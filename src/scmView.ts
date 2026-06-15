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
  listBranches,
  checkout,
  worktreeList,
  GitFile,
} from "./git";
import { openGitFileDiff } from "./diffProvider";

/** The slice of the built-in Git extension's API (version 1) we use to read the
 *  set of currently-open repositories and reopen ones we previously closed. */
interface GitExtensionApi {
  readonly repositories: ReadonlyArray<{ readonly rootUri: vscode.Uri }>;
  openRepository(root: vscode.Uri): Promise<unknown>;
}

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
/** Turn a raw git failure into a tidy, multi-line message for a modal's detail:
 *  drop the wrapper/`error:`/`fatal:`/`Aborting` noise and bullet the
 *  tab-indented file paths git lists so they don't run together. */
export function formatGitError(raw: string): string {
  const lines = raw.replace(/^Error:\s*/, "").split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    // git indents listed paths with a leading tab/spaces — turn those into bullets
    if (/^\s+\S/.test(line)) {
      out.push(`  • ${line.trim()}`);
      continue;
    }
    const text = line.replace(/^(error|fatal|warning):\s*/i, "").trim();
    if (!text || /^aborting\.?$/i.test(text)) continue; // drop empty + trailing "Aborting"
    out.push(text);
  }
  return out.join("\n");
}

export function registerScmView(context: vscode.ExtensionContext, store: DevTowerStore): void {
  // The provider is (re)created with a rootUri pointing at the mounted worktree,
  // so VS Code renders it as its OWN titled section in the Source Control view —
  // sitting alongside the built-in Git provider for the folder you opened, rather
  // than as a rootless provider that looks like it replaced Source Control. Since
  // rootUri/label are fixed at creation, changing the directory means rebuilding.
  let sc: vscode.SourceControl;
  let stagedGroup: vscode.SourceControlResourceGroup;
  let changesGroup: vscode.SourceControlResourceGroup;
  let mountedRoot: string | undefined; // rootUri the live provider was built with
  let provider: vscode.Disposable | undefined;

  const mount = (root: string | undefined): void => {
    provider?.dispose();
    const title = root ? `DevTower • ${path.basename(root)}` : "DevTower Changes";
    sc = vscode.scm.createSourceControl("devtower", title, root ? vscode.Uri.file(root) : undefined);
    stagedGroup = sc.createResourceGroup("staged", "Staged Changes");
    changesGroup = sc.createResourceGroup("changes", "Changes");
    stagedGroup.hideWhenEmpty = true;
    changesGroup.hideWhenEmpty = true;
    sc.acceptInputCommand = { command: "devtower.scmCommit", title: "Commit" };
    sc.inputBox.placeholder = "Message";
    mountedRoot = root;
    provider = vscode.Disposable.from(stagedGroup, changesGroup, sc);
  };
  mount(undefined);

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

  // ── Worktree repo visibility ────────────────────────────────────────────
  // VS Code's built-in Git auto-opens every agent worktree (under
  // .claude/worktrees/) as its own repo, cluttering the Source Control panel.
  // A title-bar toggle hides them two ways, because neither alone is enough:
  //   1. Persist the paths in `git.ignoredRepositories` so FUTURE scans skip
  //      them. The Git extension only consults this list inside openRepository
  //      (when it first opens a repo); it never re-checks it to close a repo
  //      already in the panel. So the setting alone leaves open repos visible.
  //   2. Reconcile the currently-open repos live via the Git extension: close
  //      managed worktrees with `git.close` when hiding, reopen them with the
  //      Git API (which passes openIfClosed) when showing. `git.close` persists
  //      a repo as closed, which is why showing must explicitly reopen it.
  // Neither path reloads the window — only individual repos open/close.
  const WT_MARK = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const isManagedRepo = (p: string): boolean => p.includes(WT_MARK);
  const worktreesHidden = (): boolean =>
    context.workspaceState.get<boolean>("devtower.worktreeReposHidden", false);

  /** The built-in Git extension's API (version 1): lets us read which repos are
   *  currently open and reopen ones we previously closed. `undefined` if the
   *  extension is missing or fails to activate. */
  const gitApi = async (): Promise<GitExtensionApi | undefined> => {
    const ext = vscode.extensions.getExtension<{ getAPI(v: number): GitExtensionApi }>("vscode.git");
    if (!ext) return undefined;
    try {
      if (!ext.isActive) await ext.activate();
      return ext.exports.getAPI(1);
    } catch {
      return undefined;
    }
  };

  /** Reconcile both the persisted ignore list AND the live panel with the
   *  toggle: when hidden, ignore + close every agent worktree (minus any open
   *  workspace folder); when shown, un-ignore + reopen them. Leaves the user's
   *  own entries untouched; only writes the setting when it actually changes
   *  (so it's safe to call from sync). */
  const applyWorktreeVisibility = async (): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const repoDir = folders[0]?.uri.fsPath ?? curCwd;
    const open = new Set(folders.map((f) => f.uri.fsPath));
    const hidden = worktreesHidden();
    // Every agent worktree except any that's itself an open workspace folder.
    const managed = repoDir
      ? (await worktreeList(repoDir).catch(() => []))
          .map((w) => w.path)
          .filter((p) => isManagedRepo(p) && !open.has(p))
      : [];

    // 1. Persisted ignore list — gates future scans/opens.
    const cfg = vscode.workspace.getConfiguration("git");
    // Workspace settings require a folder/workspace; in an empty window fall back
    // to user settings so the toggle never throws "no workspace is opened".
    const hasWs =
      !!vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const target = hasWs
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    // read the value at the scope we'll write so we don't duplicate inherited entries
    const info = cfg.inspect<string[]>("ignoredRepositories");
    const scoped = (hasWs ? info?.workspaceValue : info?.globalValue) ?? [];
    const kept = scoped.filter((p) => !isManagedRepo(p)); // entries the user owns
    const next = hidden ? [...kept, ...managed] : kept;
    const same =
      next.length === scoped.length &&
      [...next].sort().join("\n") === [...scoped].sort().join("\n");
    if (!same) {
      try {
        await cfg.update("ignoredRepositories", next, target);
      } catch (e) {
        vscode.window.showWarningMessage(
          `DevTower: couldn't update worktree visibility — ${String(e).slice(0, 160)}`
        );
      }
    }

    // 2. Live panel — close/reopen repos that are already open. Runs every time
    //    (not gated by `same`) so the panel catches up even when the setting was
    //    already correct. Skips repos already in the target state to avoid
    //    spurious quick-picks from `git.close`.
    if (managed.length === 0) return;
    const api = await gitApi();
    if (!api) return;
    const openRepos = new Set(api.repositories.map((r) => r.rootUri.fsPath));
    for (const p of managed) {
      try {
        if (hidden && openRepos.has(p)) {
          await vscode.commands.executeCommand("git.close", vscode.Uri.file(p));
        } else if (!hidden && !openRepos.has(p)) {
          await api.openRepository(vscode.Uri.file(p));
        }
      } catch {
        /* git busy or repo gone — the persisted ignore list still covers re-scans */
      }
    }
  };

  const setWorktreesHidden = async (hidden: boolean): Promise<void> => {
    await context.workspaceState.update("devtower.worktreeReposHidden", hidden);
    await vscode.commands.executeCommand("setContext", "devtower.worktreeReposHidden", hidden);
    await applyWorktreeVisibility();
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
      // rebuild the provider when the mounted directory changes so its section
      // title + rootUri track the worktree USE DIR points at.
      if (cwd !== mountedRoot) mount(cwd);
      const real = cwd ? await isRepo(cwd) : false;
      if (!cwd || !real) {
        stagedGroup.resourceStates = [];
        changesGroup.resourceStates = [];
        sc.count = 0;
        sc.inputBox.placeholder = "Message";
        sc.statusBarCommands = [];
        return;
      }
      const st = await status(cwd).catch(() => null);
      if (!st) {
        stagedGroup.resourceStates = [];
        changesGroup.resourceStates = [];
        sc.count = 0;
        sc.statusBarCommands = [];
        return;
      }
      stagedGroup.resourceStates = st.staged.map((f) => toState(cwd, f));
      changesGroup.resourceStates = st.unstaged.map((f) => toState(cwd, f));
      sc.count = st.staged.length + st.unstaged.length;
      // branch-aware placeholder, e.g. Message (commit on "main")
      sc.inputBox.placeholder = `Message (commit on "${st.branch || "HEAD"}")`;
      // branch indicator + switcher, shown inline on the section (like built-in Git)
      const branch = st.branch || "HEAD";
      sc.statusBarCommands = [
        {
          command: "devtower.scmCheckout",
          title: `$(git-branch) ${branch}`,
          tooltip: `Switch branch (currently ${branch})`,
        },
      ];
      // keep newly-created worktrees ignored while the toggle is on
      if (worktreesHidden()) void applyWorktreeVisibility();
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
   *  context menus differ by VS Code version, so handle them all). A folder row
   *  (scm/resourceFolder/context, when the panel is in tree mode) comes through
   *  as the resource states beneath it — or, on some versions, as a resource
   *  group — so expand a group to its files too. De-duped, order preserved. */
  const pathsFrom = (args: unknown[]): string[] => {
    if (!curCwd) return [];
    const out = new Set<string>();
    const add = (uri: vscode.Uri): void => {
      out.add(path.relative(curCwd!, uri.fsPath));
    };
    for (const a of args.flat()) {
      if (!a || typeof a !== "object") continue;
      if ("resourceUri" in a) {
        add((a as vscode.SourceControlResourceState).resourceUri);
      } else if ("resourceStates" in a) {
        for (const s of (a as vscode.SourceControlResourceGroup).resourceStates) add(s.resourceUri);
      }
    }
    return [...out];
  };

  context.subscriptions.push(
    // dispose whichever provider is currently mounted on deactivate
    { dispose: () => provider?.dispose() },
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
    vscode.commands.registerCommand("devtower.scmDiscardAll", async () => {
      if (!curCwd) return;
      const rels = changesGroup.resourceStates.map((s) =>
        path.relative(curCwd!, s.resourceUri.fsPath)
      );
      if (!rels.length) {
        vscode.window.showInformationMessage("DevTower: no changes to discard.");
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        `Discard ALL changes in ${rels.length} file${rels.length === 1 ? "" : "s"}? This cannot be undone.`,
        { modal: true },
        "Discard All Changes"
      );
      if (pick !== "Discard All Changes") return;
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

    vscode.commands.registerCommand("devtower.scmCheckout", async () => {
      if (!curCwd) return;
      const cwd = curCwd;
      const [branches, st] = await Promise.all([listBranches(cwd), status(cwd).catch(() => null)]);
      const current = st?.branch;
      if (!branches.length) {
        vscode.window.showInformationMessage("DevTower: no branches to switch to.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        branches.map((b) => ({
          label: b === current ? `$(check) ${b}` : `$(git-branch) ${b}`,
          description: b === current ? "current" : undefined,
          branch: b,
        })),
        { title: `Switch branch — ${path.basename(cwd)}`, placeHolder: "Select a branch to check out" }
      );
      if (!pick || pick.branch === current) return;
      try {
        await checkout(cwd, pick.branch);
      } catch (e) {
        // git's reason (e.g. "local changes would be overwritten ...") can run
        // several lines with tab-indented file paths — clean it up and show it in
        // full, in a modal, instead of a clipped/garbled toast.
        const raw = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`DevTower: couldn't switch to "${pick.branch}".`, {
          modal: true,
          detail: formatGitError(raw),
        });
      }
      void sync();
    }),
    vscode.commands.registerCommand("devtower.scmHideWorktrees", () => setWorktreesHidden(true)),
    vscode.commands.registerCommand("devtower.scmShowWorktrees", () => setWorktreesHidden(false)),

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

  // restore the persisted toggle state (drives the title-bar icon) and enforce it
  void vscode.commands.executeCommand("setContext", "devtower.worktreeReposHidden", worktreesHidden());
  void applyWorktreeVisibility();

  // seed the branch placeholder + initial file list
  void sync();
}
