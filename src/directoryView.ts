import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DevTowerStore } from "./store";
import { resolveDir } from "./git";
import { dlog, elog } from "./debugLog";

const DRAG_MIME = "application/vnd.devtower.fsnode";

/** Render an absolute path with $HOME collapsed to `~`, for a compact but
 *  unambiguous directory label in a view's dimmed description. */
function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/**
 * Pure destination-resolution + safety check for a file/folder move.
 *
 * @param srcPath  Absolute path being moved.
 * @param destDir  Resolved destination DIRECTORY (caller is responsible for
 *                 turning a file drop-target into its parent directory).
 */
export type MoveResult =
  | { ok: true; dest: string }
  | { ok: false; reason: string };

export function resolveMoveTarget(srcPath: string, destDir: string): MoveResult {
  // Normalize to forward slashes and use path.posix so behavior is identical
  // on POSIX and Windows. Node's path.* is platform-specific (path.sep is "\\"
  // on Windows), which would mangle the dest and break the descendant check
  // for the "/"-style paths callers and tests use. Windows fs accepts "/".
  const src = srcPath.replace(/\\/g, "/");
  const dst = destDir.replace(/\\/g, "/");
  const srcParent = path.posix.dirname(src);
  const dest = path.posix.join(dst, path.posix.basename(src));

  // no-op: source is already directly inside the destination directory
  if (srcParent === dst) {
    return { ok: false, reason: "no-op: source is already in that directory" };
  }

  // guard: moving a directory into itself or one of its own descendants
  const srcNorm = src.endsWith("/") ? src : src + "/";
  const destNorm = dst.endsWith("/") ? dst : dst + "/";
  if (destNorm === srcNorm || destNorm.startsWith(srcNorm)) {
    return { ok: false, reason: "cannot move a directory into itself or a descendant" };
  }

  return { ok: true, dest };
}

/**
 * "Selected Directory" -- a plain file tree of the currently selected room's
 * worktree, living in the DevTower activity-bar container. Lets you browse,
 * open and edit ANY file in the room (not just changed ones) without touching
 * the workspace folders or opening a new window. Clicking a file opens it in a
 * normal, editable editor.
 */
class FsNode extends vscode.TreeItem {
  constructor(public readonly fsPath: string, isDir: boolean) {
    super(
      vscode.Uri.file(fsPath),
      isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.contextValue = isDir ? "dir" : "file";
    if (!isDir) {
      // preview (not pinned) so clicking through files reuses one tab, like the
      // built-in Explorer rather than stacking a tab per file
      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [vscode.Uri.file(fsPath), { preview: true }],
      };
    }
  }
}

export class DirectoryProvider
  implements
    vscode.TreeDataProvider<FsNode>,
    vscode.TreeDragAndDropController<FsNode>
{
  private _onDidChange = new vscode.EventEmitter<FsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  view?: vscode.TreeView<FsNode>;

  // drag-and-drop MIME types
  readonly dragMimeTypes = [DRAG_MIME];
  readonly dropMimeTypes = [DRAG_MIME];

  constructor(
    private store: DevTowerStore,
    private context: vscode.ExtensionContext
  ) {
    // Only the explicit "USE DIR" button changes which directory we show, so the
    // tree stays put while you click around rooms and agents. We listen to the
    // dedicated sticky selectedDir, NOT focusedWorktree — the latter is cleared
    // on agent-select for Source Control, which would silently empty this tree.
    store.onDidChangeSelectedDir(() => this.refresh());
  }

  /** The worktree to list: whichever room's "USE DIR" was last pressed. Selecting
   *  an agent or clicking a room no longer changes it (it would shift constantly). */
  private cwd(): string | undefined {
    return resolveDir(this.store.getSelectedDir());
  }

  refresh(): void {
    const raw = this.store.getSelectedDir();
    const cwd = this.cwd();
    // Trace why the Selected Directory view does / doesn't populate: the raw
    // focused worktree, what it resolved to, and whether the TreeView exists yet.
    dlog("directory.refresh", { raw, cwd, hasView: !!this.view, visible: this.view?.visible });
    if (this.view) {
      // Show the selected directory's own name as the view title (instead of the
      // static "Selected Directory") with its containing path dimmed beside it,
      // so it's clear which directory's files are listed.
      this.view.title = cwd ? path.basename(cwd) : "Selected Directory";
      this.view.description = cwd ? tildify(path.dirname(cwd)) : undefined;
      this.view.message = cwd
        ? undefined
        : "Press a room's USE DIR button to browse its files here.";
    }
    this._onDidChange.fire(undefined);
  }

  getTreeItem(n: FsNode): vscode.TreeItem {
    return n;
  }

  async getChildren(node?: FsNode): Promise<FsNode[]> {
    const dir = node ? node.fsPath : this.cwd();
    if (!dir) {
      // root query with no resolved directory: the view is empty because nothing
      // is selected (or the selection no longer resolves) — record which.
      if (!node) dlog("directory.getChildren.empty", { reason: "no-cwd", raw: this.store.getSelectedDir() });
      return [];
    }
    let entries: fs.Dirent[];
    try {
      // async readdir: never block the extension host (a sync read on a large
      // dir, or a disk a busy agent is hammering, freezes the whole window)
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      // A populated, selected directory listing as empty is the file-explorer
      // bug we're chasing — surface the cause via the always-on error sink so it
      // lands even when verbose debug logging is off.
      elog("directory.readdir", {
        dir,
        root: !node,
        message: err instanceof Error ? err.message : String(err),
        code: (err as NodeJS.ErrnoException)?.code,
      });
      return [];
    }
    dlog("directory.getChildren", { dir, root: !node, count: entries.length });
    return entries
      .filter((e) => e.name !== ".git")
      .sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad - bd || a.name.localeCompare(b.name);
      })
      .map((e) => new FsNode(path.join(dir, e.name), e.isDirectory()));
  }

  // -- drag source ------------------------------------------------------------

  async handleDrag(
    source: readonly FsNode[],
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const paths = source.map((n) => n.fsPath).join("\n");
    dataTransfer.set(DRAG_MIME, new vscode.DataTransferItem(paths));
  }

  // -- drop target ------------------------------------------------------------

  async handleDrop(
    target: FsNode | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const item = dataTransfer.get(DRAG_MIME);
    if (!item) return;

    const srcPaths = (await item.asString()).split("\n").filter(Boolean);

    // resolve destination directory from the drop target
    let destDir: string;
    if (!target) {
      destDir = this.cwd() ?? "";
    } else if (target.contextValue === "dir") {
      destDir = target.fsPath;
    } else {
      destDir = path.dirname(target.fsPath);
    }

    if (!destDir) return;

    for (const src of srcPaths) {
      const check = resolveMoveTarget(src, destDir);
      if (!check.ok) {
        vscode.window.showErrorMessage(`Cannot move "${path.basename(src)}": ${check.reason}`);
        continue;
      }

      // collision guard
      try {
        await fs.promises.access(check.dest);
        // if access does not throw, the path exists
        vscode.window.showErrorMessage(
          `Cannot move "${path.basename(src)}": "${path.basename(check.dest)}" already exists at the destination.`
        );
        continue;
      } catch {
        // does not exist -- safe to proceed
      }

      const confirmed = await confirm(
        this.context,
        "devtower.confirmFileMove",
        `Move "${path.basename(src)}"?`,
        `From: ${tildify(path.dirname(src))}\nTo:   ${tildify(destDir)}`,
        "Move"
      );
      if (!confirmed) continue;

      try {
        await fs.promises.rename(src, check.dest);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EXDEV") {
          // cross-device: copy then unlink
          await fs.promises.copyFile(src, check.dest);
          await fs.promises.unlink(src);
        } else {
          vscode.window.showErrorMessage(
            `Move failed: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
      }
      this.refresh();
    }
  }
}

// -- confirmation helper -------------------------------------------------------

async function confirm(
  context: vscode.ExtensionContext,
  key: string,
  message: string,
  detail: string,
  confirmLabel: string
): Promise<boolean> {
  if (context.globalState.get<boolean>(key)) return true;
  const dontAsk = `${confirmLabel}, don't ask again`;
  const pick = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail },
    confirmLabel,
    dontAsk
  );
  if (pick === dontAsk) {
    await context.globalState.update(key, true);
    return true;
  }
  return pick === confirmLabel;
}

/** Register the Selected Directory tree + its commands. */
export function registerDirectory(
  context: vscode.ExtensionContext,
  store: DevTowerStore
): DirectoryProvider {
  const provider = new DirectoryProvider(store, context);
  const view = vscode.window.createTreeView("devtower.directory", {
    treeDataProvider: provider,
    showCollapseAll: true,
    dragAndDropController: provider,
  });
  provider.view = view;
  provider.refresh();
  context.subscriptions.push(
    view,
    vscode.commands.registerCommand("devtower.refreshDirectory", () => provider.refresh()),
    vscode.commands.registerCommand("devtower.deleteFile", async (node: FsNode) => {
      if (!node?.fsPath) return;
      const isDir = node.contextValue === "dir";
      const label = path.basename(node.fsPath);
      const confirmed = await confirm(
        context,
        "devtower.confirmFileDelete",
        `Delete "${label}"?`,
        isDir
          ? `This will delete the folder and all its contents.`
          : `File: ${tildify(node.fsPath)}`,
        "Delete"
      );
      if (!confirmed) return;
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(node.fsPath), {
          recursive: true,
          useTrash: true,
        });
        provider.refresh();
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Delete failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),
    vscode.commands.registerCommand("devtower.resetFilePrompts", async () => {
      await context.globalState.update("devtower.confirmFileMove", undefined);
      await context.globalState.update("devtower.confirmFileDelete", undefined);
      vscode.window.showInformationMessage(
        "DevTower: File prompt confirmations have been reset."
      );
    })
  );
  return provider;
}
