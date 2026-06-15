import * as vscode from "vscode";
import * as path from "path";
import { DevTowerStore, Agent } from "./store";
import {
  isRepo,
  resolveCwd,
  resolveDir,
  status,
  stage,
  unstage,
  stageAll,
  unstageAll,
  discardPath,
  commit,
  push,
  pull,
  fetch,
  stashSave,
  GitFile,
} from "./git";
import { openGitFileDiff } from "./diffProvider";

/**
 * A native VS Code Source Control provider mirroring the active room/agent's
 * worktree. Rendering through the built-in SCM API (rather than our own tree)
 * means it LOOKS and behaves exactly like the editor's Source Control panel:
 *   - a real commit message box (with a branch-aware placeholder),
 *   - Staged / Changes resource groups whose rows support native multi-select
 *     (shift-click ranges, cmd/ctrl-click toggles — handled by VS Code itself),
 *   - inline stage/unstage/discard actions and click-to-diff.
 *
 * The commit message box drives both Commit (accept input / ⌘Enter) and Stash.
 * The full-width commit BUTTON the built-in Git shows is the proposed
 * `SourceControl.actionButton` API, which a marketplace build can't use, so we
 * commit via accept-input + the title-bar check (the pre-actionButton native UX).
 */
export function registerScmView(context: vscode.ExtensionContext, store: DevTowerStore): void {
  const sc = vscode.scm.createSourceControl("devtower", "DevTower Changes");
  const stagedGroup = sc.createResourceGroup("staged", "Staged Changes");
  const changesGroup = sc.createResourceGroup("changes", "Changes");
  stagedGroup.hideWhenEmpty = true;
  changesGroup.hideWhenEmpty = true;
  sc.acceptInputCommand = { command: "devtower.scmCommit", title: "Commit" };
  sc.inputBox.placeholder = "Message";

  // the worktree the SCM currently reflects, resolved fresh each sync. Commands
  // act on this cwd; null when nothing committable is selected.
  let curCwd: string | undefined;
  let curLabel = "changes";

  /** The active worktree. The Selected Directory view's sticky dir (set by a
   *  room's USE DIR) wins, so Source Control always mirrors the directory the
   *  user explicitly mounted and never drifts to another branch when an agent is
   *  selected — that select clears focusedWorktree but NOT selectedDir, which is
   *  exactly how the two used to diverge. Falls back to a focused room / the
   *  selected agent only before anything has been mounted. */
  const resolveCurrent = (): { cwd?: string; label: string } => {
    const sticky = resolveDir(store.getSelectedDir());
    if (sticky) return { cwd: sticky, label: path.basename(sticky) };
    const focused = resolveDir(store.getFocusedWorktree());
    const agent: Agent | undefined = store.getSelected();
    const cwd = focused ?? (agent ? resolveCwd(agent) : undefined);
    const label = focused ? path.basename(focused) : agent?.name ?? "changes";
    return { cwd, label };
  };

  const toState = (cwd: string, f: GitFile): vscode.SourceControlResourceState => {
    const uri = vscode.Uri.file(path.join(cwd, f.path));
    const deleted = f.work === "D" || f.index === "D";
    return {
      resourceUri: uri,
      // clicking a row opens the same HEAD↔working diff the tree uses
      command: { command: "devtower.scmOpenDiff", title: "Open Diff", arguments: [cwd, f, curLabel] },
      decorations: {
        strikeThrough: deleted,
        faded: f.untracked,
        tooltip: f.untracked ? "Untracked" : deleted ? "Deleted" : "Modified",
      },
      // distinguishes which inline actions apply (stage vs unstage)
      contextValue: f.staged ? "staged" : "unstaged",
    };
  };

  let syncing = false;
  let queued = false;
  const sync = async (): Promise<void> => {
    if (syncing) {
      queued = true;
      return;
    }
    syncing = true;
    try {
      const { cwd, label } = resolveCurrent();
      curCwd = cwd;
      curLabel = label;
      const real = cwd ? await isRepo(cwd) : false;
      if (!cwd || !real) {
        stagedGroup.resourceStates = [];
        changesGroup.resourceStates = [];
        sc.count = 0;
        sc.inputBox.placeholder = "Message";
        return;
      }
      const st = await status(cwd).catch(() => null);
      if (!st) {
        stagedGroup.resourceStates = [];
        changesGroup.resourceStates = [];
        sc.count = 0;
        return;
      }
      stagedGroup.resourceStates = st.staged.map((f) => toState(cwd, f));
      changesGroup.resourceStates = st.unstaged.map((f) => toState(cwd, f));
      sc.count = st.staged.length + st.unstaged.length;
      // branch-aware placeholder, e.g. Message (commit on "main")
      sc.inputBox.placeholder = `Message (commit on "${st.branch || "HEAD"}")`;
    } finally {
      syncing = false;
      if (queued) {
        queued = false;
        void sync();
      }
    }
  };

  /** Collect repo-relative paths from however VS Code passed the selection: a
   *  single resource state, several spread args, or one array arg (multi-select
   *  context menus differ by VS Code version, so handle them all). */
  const pathsFrom = (args: unknown[]): string[] => {
    const states = args.flat().filter((a): a is vscode.SourceControlResourceState =>
      !!a && typeof a === "object" && "resourceUri" in (a as object)
    );
    if (!curCwd) return [];
    return states.map((s) => path.relative(curCwd!, s.resourceUri.fsPath));
  };

  context.subscriptions.push(
    sc,
    stagedGroup,
    changesGroup,
    // keep the mirror in step with selection, focus, and any store change (a
    // poll, a stage/commit landing via the .git watcher, etc.)
    store.onChange(() => void sync()),
    store.onDidChangeSelection(() => void sync()),
    store.onDidChangeFocusWorktree(() => void sync()),
    // the sticky Selected Directory mount drives the mirror, so re-sync (branch
    // placeholder + file list) whenever USE DIR points it at a new worktree
    store.onDidChangeSelectedDir(() => void sync()),

    vscode.commands.registerCommand("devtower.scmOpenDiff", (cwd: string, f: GitFile, label: string) =>
      openGitFileDiff(cwd, f, label || "changes")
    ),

    vscode.commands.registerCommand("devtower.scmCommit", async () => {
      if (!curCwd) return;
      const message = sc.inputBox.value.trim();
      if (!message) {
        vscode.window.showInformationMessage("DevTower: enter a commit message first.");
        return;
      }
      const st = await status(curCwd).catch(() => null);
      if (!st) return;
      // commit the staged index; if nothing is staged, offer to commit every
      // tracked edit (commit -a), mirroring the changes tree's one-click commit
      let all = false;
      if (!st.staged.length) {
        if (!st.unstaged.length) {
          vscode.window.showInformationMessage("DevTower: nothing to commit.");
          return;
        }
        const pick = await vscode.window.showWarningMessage(
          "No staged changes. Commit all tracked changes?",
          { modal: true },
          "Commit All"
        );
        if (pick !== "Commit All") return;
        all = true;
      }
      try {
        await commit(curCwd, message, all);
        sc.inputBox.value = ""; // clear the box on a successful commit, like Git
      } catch (e) {
        vscode.window.showErrorMessage(`DevTower: commit failed — ${String(e).slice(0, 200)}`);
      }
      void sync();
    }),

    vscode.commands.registerCommand("devtower.scmStage", async (...args: unknown[]) => {
      if (!curCwd) return;
      for (const rel of pathsFrom(args)) await stage(curCwd, rel);
      void sync();
    }),
    vscode.commands.registerCommand("devtower.scmUnstage", async (...args: unknown[]) => {
      if (!curCwd) return;
      for (const rel of pathsFrom(args)) await unstage(curCwd, rel);
      void sync();
    }),
    vscode.commands.registerCommand("devtower.scmDiscard", async (...args: unknown[]) => {
      if (!curCwd) return;
      const rels = pathsFrom(args);
      if (!rels.length) return;
      const pick = await vscode.window.showWarningMessage(
        rels.length === 1
          ? `Discard changes in ${path.basename(rels[0])}? This cannot be undone.`
          : `Discard changes in ${rels.length} files? This cannot be undone.`,
        { modal: true },
        "Discard Changes"
      );
      if (pick !== "Discard Changes") return;
      for (const rel of rels) await discardPath(curCwd, rel).catch(() => {});
      void sync();
    }),

    vscode.commands.registerCommand("devtower.scmStageAll", async () => {
      if (!curCwd) return;
      await stageAll(curCwd);
      void sync();
    }),
    vscode.commands.registerCommand("devtower.scmUnstageAll", async () => {
      if (!curCwd) return;
      await unstageAll(curCwd);
      void sync();
    }),
    vscode.commands.registerCommand("devtower.scmRefresh", () => void sync()),

    vscode.commands.registerCommand("devtower.scmStash", async () => {
      if (!curCwd) return;
      // reuse the commit message box as the stash message (blank → default WIP)
      const message = sc.inputBox.value.trim() || undefined;
      try {
        await stashSave(curCwd, message);
        if (message) sc.inputBox.value = "";
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: stash failed — ${String(e).slice(0, 200)}`);
      }
      void sync();
    }),

    vscode.commands.registerCommand("devtower.scmPush", async () => {
      if (!curCwd) return;
      try {
        await push(curCwd);
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: push failed — ${String(e).slice(0, 200)}`);
      }
      void sync();
    }),
    vscode.commands.registerCommand("devtower.scmPull", async () => {
      if (!curCwd) return;
      try {
        await pull(curCwd);
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: pull failed — ${String(e).slice(0, 200)}`);
      }
      void sync();
    }),
    vscode.commands.registerCommand("devtower.scmFetch", async () => {
      if (!curCwd) return;
      await fetch(curCwd).catch(() => {});
      void sync();
    })
  );

  // seed the branch placeholder + initial file list
  void sync();
}
