import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { DevTowerStore } from "./store";
import { resolveDir } from "./git";

/**
 * "Selected Directory" — a plain file tree of the currently selected room's
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

export class DirectoryProvider implements vscode.TreeDataProvider<FsNode> {
  private _onDidChange = new vscode.EventEmitter<FsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  view?: vscode.TreeView<FsNode>;

  constructor(private store: DevTowerStore) {
    // Only the explicit "USE DIR" button changes which directory we show, so the
    // tree stays put while you click around rooms and agents.
    store.onDidChangeFocusWorktree(() => this.refresh());
  }

  /** The worktree to list: whichever room's "USE DIR" was last pressed. Selecting
   *  an agent or clicking a room no longer changes it (it would shift constantly). */
  private cwd(): string | undefined {
    return resolveDir(this.store.getFocusedWorktree());
  }

  refresh(): void {
    const cwd = this.cwd();
    if (this.view) {
      this.view.description = cwd ? path.basename(cwd) : undefined;
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
    if (!dir) return [];
    let entries: fs.Dirent[];
    try {
      // async readdir: never block the extension host (a sync read on a large
      // dir, or a disk a busy agent is hammering, freezes the whole window)
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.name !== ".git")
      .sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad - bd || a.name.localeCompare(b.name);
      })
      .map((e) => new FsNode(path.join(dir, e.name), e.isDirectory()));
  }
}

/** Register the Selected Directory tree + its refresh command. */
export function registerDirectory(
  context: vscode.ExtensionContext,
  store: DevTowerStore
): DirectoryProvider {
  const provider = new DirectoryProvider(store);
  const view = vscode.window.createTreeView("devtower.directory", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.view = view;
  provider.refresh();
  context.subscriptions.push(
    view,
    vscode.commands.registerCommand("devtower.refreshDirectory", () => provider.refresh())
  );
  return provider;
}
