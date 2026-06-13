import * as vscode from "vscode";
import * as path from "path";
import { DevTowerStore } from "./store";
import { isRepo, resolveCwd, resolveDir, status, stage, unstage, stageAll, unstageAll, GitFile } from "./git";
import { gitHeadUri } from "./diffProvider";

/**
 * Mirrors the selected room's worktree into VS Code's NATIVE Source Control
 * panel. One SourceControl whose two groups (Staged / Changes) are repopulated
 * on each selection change — so clicking a different room re-points the same
 * provider at a different worktree without reloading the window or refreshing
 * the webview.
 *
 * Bonus over the custom Changes tree: native count badge, colored status
 * letters (via a FileDecorationProvider), and editor gutter diffs (via the
 * quick-diff provider).
 */
class ScmMirror {
  private sc: vscode.SourceControl;
  private staged: vscode.SourceControlResourceGroup;
  private changes: vscode.SourceControlResourceGroup;

  /** worktree of the currently mirrored selection (for quick-diff / staging). */
  private cwd: string | undefined;
  /** repo-relative path -> status letter, drives the FileDecorationProvider. */
  private decos = new Map<string, GitFile>();
  private decoEmitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  /** monotonic token so a slow git status from an old selection can't clobber
   *  the groups after the user has already clicked a different room. */
  private gen = 0;

  readonly disposables: vscode.Disposable[] = [];

  constructor(private store: DevTowerStore) {
    this.sc = vscode.scm.createSourceControl("devtower", "DevTower Room");
    this.sc.quickDiffProvider = { provideOriginalResource: (u) => this.originalResource(u) };
    // We don't commit from here (rooms are foreign worktrees) — hide the box.
    this.sc.inputBox.visible = false;
    this.staged = this.sc.createResourceGroup("staged", "Staged Changes");
    this.changes = this.sc.createResourceGroup("changes", "Changes");
    this.staged.hideWhenEmpty = true;
    this.changes.hideWhenEmpty = true;

    const fileDeco: vscode.FileDecorationProvider = {
      onDidChangeFileDecorations: this.decoEmitter.event,
      provideFileDecoration: (u) => this.decorate(u),
    };

    this.disposables.push(
      this.sc,
      this.decoEmitter,
      vscode.window.registerFileDecorationProvider(fileDeco),
      this.store.onDidChangeSelection(() => void this.sync()),
      this.store.onDidChangeFocusWorktree(() => void this.sync()),
      this.store.onChange(() => void this.sync())
    );

    void this.sync();
  }

  /** Recompute the groups for the current selection. */
  async sync(): Promise<void> {
    const token = ++this.gen;
    // A room clicked directly (even an empty one) wins; otherwise fall back to
    // the selected agent's worktree.
    const agent = this.store.getSelected();
    const focused = resolveDir(this.store.getFocusedWorktree());
    const cwd = focused ?? (agent ? resolveCwd(agent) : undefined);
    const label = focused ? path.basename(focused) : agent?.name ?? "room";
    const real = cwd ? await isRepo(cwd) : false;
    if (token !== this.gen) return; // superseded by a newer selection

    if (!cwd || !real) {
      this.apply(token, cwd, [], []);
      return;
    }
    const st = await status(cwd);
    if (token !== this.gen) return;
    this.apply(
      token,
      cwd,
      st.staged.map((f) => this.state(cwd, f, true, label)),
      st.unstaged.map((f) => this.state(cwd, f, false, label))
    );
  }

  private apply(
    token: number,
    cwd: string | undefined,
    staged: vscode.SourceControlResourceState[],
    changes: vscode.SourceControlResourceState[]
  ): void {
    if (token !== this.gen) return;
    this.cwd = cwd;
    this.staged.resourceStates = staged;
    this.changes.resourceStates = changes;
    this.sc.count = staged.length + changes.length;

    this.decos.clear();
    if (cwd) {
      for (const s of [...staged, ...changes]) {
        const f = (s as any)._file as GitFile;
        this.decos.set(path.join(cwd, f.path), f);
      }
    }
    this.decoEmitter.fire(undefined); // refresh all badges
  }

  private state(
    cwd: string,
    file: GitFile,
    staged: boolean,
    label: string
  ): vscode.SourceControlResourceState {
    const resourceUri = vscode.Uri.file(path.join(cwd, file.path));
    const letter = file.untracked ? "U" : staged ? file.index : file.work;
    const left = gitHeadUri(cwd, file.path);
    const title = `${label} ⌥ ${path.basename(file.path)} (HEAD ↔ working)`;
    return {
      resourceUri,
      command: {
        command: "vscode.diff",
        title: "Open Diff",
        arguments: [left, resourceUri, title, { preview: true }],
      },
      decorations: {
        strikeThrough: letter === "D",
        faded: file.untracked,
        tooltip: `${file.path} — ${statusWord(letter)}`,
      },
      // smuggled for staging + decoration lookup (plain object, in-process)
      _file: file,
      _staged: staged,
    } as vscode.SourceControlResourceState;
  }

  /** Quick-diff: original (HEAD) side for a worktree file -> native gutters. */
  private originalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== "file" || !this.cwd) return undefined;
    const f = this.decos.get(uri.fsPath);
    if (!f || f.untracked || f.work === "D") return undefined;
    return gitHeadUri(this.cwd, f.path);
  }

  private decorate(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined;
    const f = this.decos.get(uri.fsPath);
    if (!f) return undefined;
    const letter = f.untracked ? "U" : f.index !== " " ? f.index : f.work;
    return {
      badge: letter,
      tooltip: statusWord(letter),
      color: new vscode.ThemeColor(themeColor(letter, f.untracked)),
      propagate: false,
    };
  }

  async stageFile(s: vscode.SourceControlResourceState | undefined): Promise<void> {
    const f = s && ((s as any)._file as GitFile);
    if (!this.cwd || !f) return;
    await stage(this.cwd, f.path);
    await this.sync();
  }

  async unstageFile(s: vscode.SourceControlResourceState | undefined): Promise<void> {
    const f = s && ((s as any)._file as GitFile);
    if (!this.cwd || !f) return;
    await unstage(this.cwd, f.path);
    await this.sync();
  }

  /** The worktree currently mirrored (focused room or selected agent), if any. */
  currentCwd(): string | undefined {
    return this.cwd;
  }

  async stageAll(): Promise<void> {
    if (!this.cwd) return;
    await stageAll(this.cwd);
    await this.sync();
  }

  async unstageAll(): Promise<void> {
    if (!this.cwd) return;
    await unstageAll(this.cwd);
    await this.sync();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function statusWord(letter: string): string {
  return (
    { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "untracked" }[
      letter
    ] ?? "changed"
  );
}

function themeColor(letter: string, untracked: boolean): string {
  if (untracked || letter === "U") return "gitDecoration.untrackedResourceForeground";
  if (letter === "D") return "gitDecoration.deletedResourceForeground";
  if (letter === "A") return "gitDecoration.addedResourceForeground";
  if (letter === "R" || letter === "C") return "gitDecoration.renamedResourceForeground";
  return "gitDecoration.modifiedResourceForeground";
}

/** Register the native SCM mirror + its stage/unstage commands. */
export function registerScmMirror(
  context: vscode.ExtensionContext,
  store: DevTowerStore
): ScmMirror {
  const mirror = new ScmMirror(store);
  context.subscriptions.push(
    mirror,
    vscode.commands.registerCommand("devtower.scmStage", (s) => mirror.stageFile(s)),
    vscode.commands.registerCommand("devtower.scmUnstage", (s) => mirror.unstageFile(s)),
    vscode.commands.registerCommand("devtower.scmStageAll", () => mirror.stageAll()),
    vscode.commands.registerCommand("devtower.scmUnstageAll", () => mirror.unstageAll()),
    vscode.commands.registerCommand("devtower.scmRefresh", () => mirror.sync()),
    vscode.commands.registerCommand("devtower.openRoomFolder", () => {
      const cwd = mirror.currentCwd();
      if (!cwd) {
        void vscode.window.showInformationMessage(
          "DevTower: click a room (or a dev) first, then show it in the Explorer."
        );
        return;
      }
      mountRoomFolder(cwd);
    })
  );
  return mirror;
}

/** URI of the single workspace folder DevTower manages for room browsing, so we
 *  can re-point it on each call instead of stacking up folders. */
let managedRoomFolder: vscode.Uri | undefined;

/**
 * Point the CURRENT window's Explorer at a room's worktree, without reloading.
 * VS Code only restarts the window when the FIRST workspace folder changes, so
 * we keep the user's existing root at index 0 and add/replace a single managed
 * folder after it. The Explorer, global search and quick-open then include the
 * room's full tree (not just its changed files), and every file is editable.
 */
export function mountRoomFolder(dir: string): void {
  const target = vscode.Uri.file(dir);
  const name = `Room · ${path.basename(dir)}`;
  const folders = vscode.workspace.workspaceFolders ?? [];

  // already shown as some folder → just focus the Explorer, don't duplicate
  if (folders.some((f) => f.uri.fsPath === dir)) {
    managedRoomFolder = target;
    void vscode.commands.executeCommand("workbench.view.explorer");
    return;
  }

  // No root open at all: there's nothing to preserve, so opening the folder in
  // this window (a reload) is acceptable and is the only way to set the root.
  if (folders.length === 0) {
    void vscode.commands.executeCommand("vscode.openFolder", target, { forceNewWindow: false });
    return;
  }

  const managedIdx = managedRoomFolder
    ? folders.findIndex((f) => f.uri.fsPath === managedRoomFolder!.fsPath)
    : -1;

  // Replace our previous managed folder in place (index >= 1, no reload), or
  // append a new one after the user's root.
  if (managedIdx > 0) {
    vscode.workspace.updateWorkspaceFolders(managedIdx, 1, { uri: target, name });
  } else {
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: target, name });
  }
  managedRoomFolder = target;
  void vscode.commands.executeCommand("workbench.view.explorer");
}
