import * as vscode from "vscode";
import { DevTowerStore, Agent, SessionMessage } from "./store";
import { TerminalManager } from "./terminals";
import { getSession } from "./session";
import { openGitFileDiff, openMockFileDiff } from "./diffProvider";
import * as path from "path";
import { randomUUID } from "crypto";
import { isRepo, resolveCwd, resolveDir, status, stage, unstage, stageAll, unstageAll, changedFiles, worktreeAdd, worktreeRemove, worktreeList, currentBranch, branchSummary, runGit, canonicalDir, BranchSummary } from "./git";
import { PrService, PrInfo } from "./prs";
import { capabilities, setGithubToken, clearGithubToken, SCOPE_HELP } from "./github";
import { listHooks, setHookEnabled, setAllHooksEnabled, EDITED_DIR, readEditMarkers } from "./hooks";
import { ClaudeDiscovery } from "./claude";
import { MiniPanel, MiniDelegate } from "./miniPanel";
import { dlog, elog, showDebugChannel, clearDebugLog, debugLogExists, debugLogPath, debugLogArchiveCount, debugLogDir, execStatsSnapshot, resetExecStats } from "./debugLog";
import * as fs from "fs";
import * as os from "os";

/** One usage limit window (5-hour or weekly) from Claude's rate_limits feed. */
interface UsageWindow {
  pct: number;
  resetsAt?: number;
}

/** Everything a room's back-wall board renders: file/staged/commit columns plus
 *  a matched pull request with its check + review status. */
interface BoardData {
  branch: string;
  modified: number;
  staged: number;
  modifiedFiles: string[];
  stagedFiles: string[];
  unstagedAdd: number;
  unstagedDel: number;
  stagedAdd: number;
  stagedDel: number;
  committedAdd: number;
  committedDel: number;
  base: string;
  ahead: number;
  unpushed: number;
  behind: number;
  commits: string[];
  /** Set when the room's directory no longer exists on disk (a worktree removed
   *  out from under us). The board renders a distinct "missing" state. */
  missing?: boolean;
  /** False until the first GitHub PR poll completes, so the board can show a
   *  spinner instead of an empty "no PR" placeholder on initial load. */
  prReady: boolean;
  pr?: {
    number: number;
    title: string;
    url: string;
    draft: boolean;
    checks: "pass" | "fail" | "pending" | "none";
    checksPass: number;
    checksFailed: number;
    checksRunning: number;
    checksTotal: number;
    review: "approved" | "changes" | "required" | "none";
    approvals: number;
    changesRequested: number;
    reviewersPending: number;
    comments: number;
    /** PR was merged: the board shows a brief MERGED badge before it clears. */
    merged?: boolean;
  };
}

/** A grid cell the user reserved for a directory (persisted globally). */
export interface ReservedRoom {
  name: string;
  path: string;
  floor: number;
  col: number;
  /** Workspace folders this project was added under. Used only when
   *  devtower.projectScope = "workspace": the building shows only in windows
   *  whose folder key is in this list. Absent on legacy rooms (they show in
   *  global mode only, until re-added from the workspace that should own them). */
  workspaces?: string[];
}

/** Full-window cockpit hosted as an editor-area WebviewPanel. */
export class ConsolePanel implements MiniDelegate {
  public static current: ConsolePanel | undefined;
  /** The compact popout view (projects → worktrees → agents). Owned here so it
   *  reuses this panel's git/PR feed instead of polling on its own. */
  private mini?: MiniPanel;
  /** Last payloads posted to the webview, replayed to the mini view on open. */
  private lastState?: Record<string, unknown>;
  private lastPrs?: Record<string, unknown>;
  /** The tower's editor webview panel — created on demand and re-created if it was
   *  closed while the mini popout kept the instance (and its data feed) alive.
   *  Undefined while the tower is not open. */
  private panel?: vscode.WebviewPanel;
  /** Listeners scoped to the CURRENT tower panel (message / dispose / view-state),
   *  torn down and re-added each time the panel is (re)mounted. */
  private towerDisposables: vscode.Disposable[] = [];
  private static readonly viewType = "devtower.console";
  private usageTimer?: ReturnType<typeof setInterval>;
  private usageWatcher?: fs.FSWatcher;
  private disposables: vscode.Disposable[] = [];
  /** Rooms with an add-agent flow in flight, so a double-click can't spawn two. */
  private addingRooms = new Set<string>();
  /** Live board data per ROOM KEY (building key = its checkout path): modified vs
   *  staged files, commits, and a matched PR. Keyed by the same string the room
   *  uses so they line up. */
  private boardsByPath = new Map<string, BoardData>();
  /** Branch name per room key, so the main building shows its real branch. */
  private branchByPath = new Map<string, string>();
  private lastWtSignature = "";
  /** fs.watch handles on each tracked repo's .git dir, so staging/committing is
   *  reflected at once instead of waiting for the poll. Keyed by repo top-level. */
  private gitWatchers = new Map<string, fs.FSWatcher>();
  private gitDebounce?: ReturnType<typeof setTimeout>;
  /** fs.watch on the PostToolUse(edit) marker dir: an agent's working-tree edit
   *  (which never touches .git) updates just that worktree's board, the job the
   *  old 6s git poll used to do. Needs the PostToolUse hook installed. */
  private editWatcher?: fs.FSWatcher;
  private editDebounce?: ReturnType<typeof setTimeout>;
  /** room key → absolute git path, so a sync request can run git in the right dir. */
  private roomGitPaths = new Map<string, string>();
  /** room key whose worktree is mounted in the Selected Directory view (set only
   *  by its "USE DIR" button). The scene marks it "SELECTED DIR". */
  private usedDirRoom?: string;
  private fetchTimer?: ReturnType<typeof setInterval>;
  /** True once the webview has sent `ready` (its message listener is wired). A
   *  message posted before this is dropped by VS Code, so openSettings sent on a
   *  freshly created panel is deferred until ready instead of lost. */
  private webviewReady = false;
  /** A pending "open settings" request that arrived before the webview was ready,
   *  flushed from the `ready` handler. Holds the tab to land on (or `true` for the
   *  default tab) when set. */
  private pendingOpenSettings: boolean | string = false;

  static createOrShow(
    context: vscode.ExtensionContext,
    store: DevTowerStore,
    terminals: TerminalManager,
    prs: PrService,
    discovery?: ClaudeDiscovery
  ): ConsolePanel {
    const inst = ConsolePanel.ensure(context, store, terminals, prs, discovery);
    inst.showTower();
    return inst;
  }

  /** Get (creating if needed) the singleton WITHOUT opening the tower panel. The
   *  instance owns the live data feed, so this is what lets the mini popout run on
   *  its own — `devtower.openMini` calls `ensure(...).openMini()`. */
  static ensure(
    context: vscode.ExtensionContext,
    store: DevTowerStore,
    terminals: TerminalManager,
    prs: PrService,
    discovery?: ClaudeDiscovery
  ): ConsolePanel {
    if (!ConsolePanel.current) {
      ConsolePanel.current = new ConsolePanel(context, store, terminals, prs, discovery);
    }
    return ConsolePanel.current;
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: DevTowerStore,
    private readonly terminals: TerminalManager,
    private readonly prs: PrService,
    private readonly discovery?: ClaudeDiscovery
  ) {
    // DATA PIPELINE — lives as long as the instance, i.e. while EITHER the tower or
    // the mini popout is open. The tower webview is mounted/unmounted separately
    // (showTower / onTowerClosed) so closing the tower never kills this feed.
    this.store.onChange(() => this.postState(), null, this.disposables);
    this.store.onDidChangeSelection(() => this.postState(), null, this.disposables);
    this.prs.onChange(() => this.postPrs(), null, this.disposables);
    this.prs.onChange(() => void this.refreshState(), null, this.disposables); // PR → board column
    // mirror a live devtower.debugLog toggle into the scene so shred/toon events
    // start (or stop) without reopening the console
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("devtower.debugLog")) this.postConfig();
      // a live perf-overlay toggle (Settings UI or settings.json) mirrors into the scene
      if (e.affectsConfiguration("devtower.perfHud")) this.postConfig();
      // a live graphics-quality change (Settings UI or settings.json) re-applies in the scene
      if (e.affectsConfiguration("devtower.graphicsQuality")) this.postConfig();
      // an external edit to the project scope re-filters which buildings render
      if (e.affectsConfiguration("devtower.projectScope")) {
        this.postConfig();
        this.postState();
      }
    }, null, this.disposables);
    this.startUsage();
    // a saved file is a working-tree (unstaged) change → refresh promptly
    vscode.workspace.onDidSaveTextDocument(() => this.onGitChange(), null, this.disposables);
    // event-driven board updates (no 6s git poll): the .git watchers catch stage/
    // commit/push, onDidSaveTextDocument catches in-editor saves, and this watches
    // the PostToolUse(edit) marker dir to catch an agent's working-tree edits.
    this.watchEditMarkers();
    // background fetch so "behind" (out-of-date) is meaningful; once shortly after
    // open, then periodically while visible
    setTimeout(() => void this.fetchAll(), 5_000);
    this.fetchTimer = setInterval(() => {
      if (this.anyVisible()) void this.fetchAll();
    }, 180_000);
    // populate rooms/boards + restore the mounted dir now, so the data feed is
    // ready whether the first view to open is the tower or a standalone mini (the
    // mini has no webview "ready" handshake to kick this off).
    void this.bootstrap();
  }

  private bootstrapped = false;
  /** One-time initial data load: fill in worktree rooms + boards, then re-mount the
   *  last-used Selected Directory. Idempotent; the tower's `ready` handler no longer
   *  owns this so the mini can open first. */
  private async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    await this.refreshState();
    await this.restoreSelectedDir(); // needs roomGitPaths, so after refreshState
  }

  /** True while either view is on screen — gates the always-on pollers and the
   *  git/fetch timers (the mini renders the same data, so it counts). */
  private anyVisible(): boolean {
    return !!this.panel?.visible || !!this.mini?.visible;
  }

  /** Re-evaluate the background pollers and re-broadcast state on any visibility
   *  change: the tower (if now visible) catches up after being hidden, and the
   *  mini's "tower visible?" flag stays fresh. Each post gates the tower webview on
   *  its own visibility and always feeds the mini. */
  private applyVisibility(): void {
    const visible = this.anyVisible();
    this.discovery?.setVisible(visible);
    this.prs.setVisible(visible);
    if (visible) this.postUsage(); // catch up on any missed-while-hidden usage
    this.postState();
    this.postPrs();
  }

  /** Create the tower webview panel if it isn't open, otherwise reveal it. The
   *  panel is a detachable surface over the instance's live data feed, so it can
   *  be closed and re-opened without disturbing the mini popout. */
  showTower(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ConsolePanel.viewType,
      "DevTower",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "media", "devtower-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "devtower-dark.svg"),
    };
    this.panel = panel;
    this.webviewReady = false; // a fresh webview must re-announce `ready`
    panel.webview.html = this.html(panel.webview);
    this.towerDisposables.push(
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      panel.onDidDispose(() => this.onTowerClosed()),
      panel.onDidChangeViewState(() => this.applyVisibility())
    );
    this.applyVisibility();
  }

  /** The tower tab was closed. Drop the panel + its listeners, but keep the
   *  instance (and its data feed) alive if the mini popout is still open, so the
   *  mini keeps updating and the tower can be re-opened later. Tear everything
   *  down only once both views are gone. */
  private onTowerClosed(): void {
    this.panel = undefined;
    this.towerDisposables.forEach((d) => d.dispose());
    this.towerDisposables = [];
    if (this.mini) this.applyVisibility();
    else this.disposeInstance();
  }

  /** Quiet `git fetch` per tracked repo so the boards' behind/ahead counts reflect
   *  the remote, then refresh the stats. Best-effort; offline/no-remote is fine. */
  private async fetchAll(): Promise<void> {
    const dirs = new Set(this.roomGitPaths.values());
    await Promise.all(
      [...dirs].map((d) => (fs.existsSync(d) ? runGit(d, ["fetch", "--quiet"]).catch(() => "") : Promise.resolve("")))
    );
    await this.refreshState();
  }

  /** Fetch a single room's remote refs on demand (the COMMITS-cell ↻ button) so
   *  its behind/ahead counts reflect upstream right now, then refresh the board.
   *  Read-only: never changes the working tree. */
  private async fetchRoom(roomKey: string): Promise<void> {
    const dir = this.roomGitPaths.get(roomKey) ?? roomKey;
    if (!fs.existsSync(dir)) return;
    await runGit(dir, ["fetch", "--quiet"]).catch(() => "");
    await this.refreshState();
  }

  /** Push a room's local commits (the COMMITS-cell ↑ button). Sets the upstream
   *  on the first push. Surfaces a warning and leaves the repo untouched if it
   *  can't (e.g. rejected non-fast-forward / network). */
  private async pushRoom(roomKey: string): Promise<void> {
    const dir = this.roomGitPaths.get(roomKey) ?? roomKey;
    if (!fs.existsSync(dir)) return;
    try {
      await runGit(dir, ["push"]);
    } catch {
      try {
        await runGit(dir, ["push", "-u", "origin", "HEAD"]); // first push sets upstream
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: push failed — ${String(e).slice(0, 140)}`);
      }
    }
    await this.refreshState();
  }

  /** Pull a room's upstream commits (the COMMITS-cell ↓ button), fast-forward
   *  only so a divergent history is never silently merged. */
  private async pullRoom(roomKey: string): Promise<void> {
    const dir = this.roomGitPaths.get(roomKey) ?? roomKey;
    if (!fs.existsSync(dir)) return;
    try {
      await runGit(dir, ["pull", "--ff-only"]);
    } catch (e) {
      vscode.window.showWarningMessage(`DevTower: can't fast-forward — pull/rebase manually. ${String(e).slice(0, 140)}`);
    }
    await this.refreshState();
  }

  /** Coalesce a flurry of git/file events into a single prompt refresh of the
   *  board stats (unstaged/staged/commits) and the matched PR. */
  private onGitChange(): void {
    if (this.gitDebounce) clearTimeout(this.gitDebounce);
    this.gitDebounce = setTimeout(() => {
      void this.refreshState();
      // NOTE: deliberately NOT refreshing PRs here — .git fires on every commit/
      // ref write during a build, and a gh call per event blows the GitHub API
      // rate limit. PR status comes from the adaptive poll in PrService instead.
    }, 300);
  }

  /** Watch each tracked repo's .git directory so manual stage/commit/push (or any
   *  external git op) updates the boards immediately. Re-synced each refresh as
   *  rooms/worktrees come and go; watchers for vanished repos are dropped. */
  private async syncGitWatchers(repoDirs: Set<string>): Promise<void> {
    for (const [dir, w] of this.gitWatchers) {
      if (!repoDirs.has(dir)) { w.close(); this.gitWatchers.delete(dir); }
    }
    for (const dir of repoDirs) {
      if (this.gitWatchers.has(dir)) continue;
      let gitDir: string;
      try {
        const out = (await runGit(dir, ["rev-parse", "--git-dir"])).trim();
        gitDir = path.isAbsolute(out) ? out : path.join(dir, out);
      } catch {
        continue; // not a repo (yet)
      }
      try {
        // recursive so index (staging), HEAD/refs (commits), FETCH_HEAD (push) all fire
        const w = fs.watch(gitDir, { recursive: true }, () => this.onGitChange());
        this.gitWatchers.set(dir, w);
      } catch {
        /* platform without recursive watch / dir gone — manual Refresh still covers it */
      }
    }
  }

  /** Watch the PostToolUse(edit) marker dir so an agent's working-tree edit (which
   *  never touches .git, so the .git watchers miss it) updates that worktree's
   *  board at once — the unique job the old 6s git poll did. mkdir first so the
   *  watch doesn't throw before any marker has landed. */
  private watchEditMarkers(): void {
    try { fs.mkdirSync(EDITED_DIR, { recursive: true }); } catch { /* */ }
    try {
      this.editWatcher = fs.watch(EDITED_DIR, () => this.onEditMarker());
    } catch {
      dlog("editWatch.fail", { dir: EDITED_DIR }); // manual Refresh still covers it
    }
  }

  /** An edit marker landed — debounce a burst of edits, then refresh only the
   *  worktrees those markers name (not the full per-worktree fan-out). */
  private onEditMarker(): void {
    if (this.editDebounce) clearTimeout(this.editDebounce);
    this.editDebounce = setTimeout(async () => {
      if (!this.anyVisible()) return; // no view on screen → nothing to update
      const markers = await readEditMarkers();
      const cwds = new Set<string>();
      for (const m of markers.values()) if (m.cwd) cwds.add(m.cwd);
      await this.refreshEditedWorktrees(cwds);
    }, 300);
  }

  /** Recompute boards for only the rooms whose checkout matches one of `cwds`
   *  (the edited worktree roots), reusing buildBoard. Scoped so a single agent's
   *  edit doesn't trigger a git-spawn storm across every tracked worktree. */
  private async refreshEditedWorktrees(cwds: Set<string>): Promise<void> {
    if (!cwds.size) return;
    const canon = new Set([...cwds].map((c) => canonicalDir(c)));
    const targets = [...this.roomGitPaths].filter(([, gp]) => canon.has(canonicalDir(gp)));
    if (!targets.length) return;
    // fork-point base per worktree room, so a worktree's commit count is measured
    // from where it branched (mirrors refreshState's forkBase).
    const forkBase = new Map<string, string>();
    for (const w of this.getWorktreeRooms()) if (w.base) forkBase.set(w.path, w.base);
    const prs = [...this.prs.getCrew(), ...this.prs.getReview()];
    let changed = false;
    for (const [roomKey, gp] of targets) {
      try {
        if (!fs.existsSync(gp) || !(await isRepo(gp))) continue;
        const sum = await branchSummary(gp, forkBase.get(roomKey));
        if (!sum) continue;
        const branch = await currentBranch(gp);
        const pr = prs.find((x) => x.branch && x.branch === branch);
        this.boardsByPath.set(roomKey, this.buildBoard(sum, branch, pr));
        this.branchByPath.set(roomKey, branch);
        changed = true;
      } catch {
        /* path vanished or git hiccup — leave that board for the next refresh */
      }
    }
    if (changed) {
      this.lastWtSignature = ""; // force the next refreshState to re-broadcast too
      this.postState();
    }
  }

  /** Assemble a room's back-wall board from its git summary, branch, and matched
   *  PR. Shared by the full refreshState fan-out and the scoped edit-watcher. */
  private buildBoard(sum: BranchSummary, branch: string, pr?: PrInfo): BoardData {
    return {
      branch,
      modified: sum.modified,
      staged: sum.staged,
      modifiedFiles: sum.modifiedFiles.slice(0, 30),
      stagedFiles: sum.stagedFiles.slice(0, 30),
      unstagedAdd: sum.unstagedAdd,
      unstagedDel: sum.unstagedDel,
      stagedAdd: sum.stagedAdd,
      stagedDel: sum.stagedDel,
      committedAdd: sum.committedAdd,
      committedDel: sum.committedDel,
      base: sum.base,
      prReady: this.prs.hasFetched(),
      ahead: sum.ahead,
      unpushed: sum.unpushed,
      behind: sum.behind,
      commits: sum.commits,
      pr: pr
        ? {
            number: pr.number, title: pr.title, url: pr.url, draft: pr.isDraft,
            checks: pr.checks, checksPass: pr.checksPass, checksFailed: pr.checksFailed,
            checksRunning: pr.checksRunning, checksTotal: pr.checksTotal,
            review: pr.review, approvals: pr.approvals,
            changesRequested: pr.changesRequested, reviewersPending: pr.reviewersPending,
            comments: pr.comments, merged: pr.merged,
          }
        : undefined,
    };
  }

  private async onMessage(m: any): Promise<void> {
    const id: string | undefined = m.id;
    switch (m.type) {
      case "ready":
        this.webviewReady = true;
        // replay current data to the freshly-mounted webview (the initial load is
        // owned by bootstrap() now, so a re-opened tower catches up immediately)
        this.postConfig();
        this.postState();
        this.postPrs();
        this.postUsage();
        await this.bootstrap(); // no-op after the first view opened it
        void this.refreshState(); // refresh boards on (re)open
        if (this.pendingOpenSettings) {
          const tab = typeof this.pendingOpenSettings === "string" ? this.pendingOpenSettings : undefined;
          this.pendingOpenSettings = false;
          this.panel?.webview.postMessage({ type: "openSettings", tab });
        }
        break;
      case "setPerf":
        // operator picked a performance mode → persist their choice (legacy path)
        await this.persistValue("performanceMode", String(m.mode));
        break;
      case "setQuality":
        // operator picked a graphics-quality preset → persist their choice
        await this.persistValue("graphicsQuality", String(m.mode));
        break;
      case "setProjectScope":
        // operator chose global vs this-workspace projects → persist and redraw
        // the scene with the new filter (the config listener echoes it back too).
        await this.persistValue("projectScope", String(m.scope));
        this.postState();
        break;
      case "setBookPreference":
        // operator picked physical vs ebook for skill books → persist their choice
        await this.persistValue("bookPreference", String(m.mode));
        break;
      case "setPerfHud":
        // operator toggled the on-canvas performance overlay (Settings > Debug)
        await this.persistToggle("perfHud", !!m.on);
        break;
      case "setDebug": {
        // operator toggled debug logging from the Settings > Debug tab. Persisting
        // it fires the devtower.debugLog config listener, which re-posts config so
        // the toggle's authoritative state echoes back to the webview.
        const on = !!m.on;
        await this.persistToggle("debugLog", on);
        // Turning OFF with a captured log present: offer to clear it (the logs
        // stay viewable if the operator declines). Dismissing the modal (Cancel
        // or Escape) aborts the whole disable — re-enable logging and bounce the
        // toggle back on via the config echo, since the webview already flipped
        // it off optimistically.
        if (!on && debugLogExists()) {
          const pick = await vscode.window.showWarningMessage(
            "Clear the DevTower debug log?",
            { modal: true, detail: "Clear the captured log, keep it to review, or cancel to leave logging on." },
            "Clear log",
            "Keep"
          );
          if (pick === undefined) {
            await this.persistToggle("debugLog", true);
            this.postConfig();
          } else if (pick === "Clear log") {
            clearDebugLog();
            this.postConfig();
          }
        }
        break;
      }
      case "viewDebugLog": {
        // reveal the live output channel AND open the on-disk log (the full
        // history, greppable), whichever exists
        showDebugChannel();
        const p = debugLogPath();
        if (p && fs.existsSync(p)) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
          await vscode.window.showTextDocument(doc, { preview: false });
        }
        break;
      }
      case "clearDebugLog": {
        const archives = debugLogArchiveCount();
        const detail = archives
          ? `This permanently deletes the captured debug log and its ${archives} archived file${archives === 1 ? "" : "s"}.`
          : "This permanently deletes the captured debug log.";
        const pick = await vscode.window.showWarningMessage(
          "Clear the DevTower debug log?",
          { modal: true, detail },
          "Clear log"
        );
        if (pick === "Clear log") {
          clearDebugLog();
          this.postConfig();
        }
        break;
      }
      case "openLogFolder": {
        // reveal the .devtower folder (with debug.log selected when present) in
        // the OS file manager so the operator can see the active log + archives
        const dir = debugLogDir();
        if (dir) {
          const p = debugLogPath();
          const target = p && fs.existsSync(p) ? p : dir;
          await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target));
        }
        break;
      }
      case "refresh":
        // tower Refresh button → manual full refresh (sessions + git boards + PRs)
        void this.refreshAll();
        break;
      case "getExecStats":
        // Settings > Debug "External calls" table asked for the current tally
        this.postExecStats();
        break;
      case "resetExecStats":
        resetExecStats();
        this.postExecStats();
        break;
      case "select":
        if (id) {
          this.store.setSelected(id);
          // An agent DevTower runs inside VS Code (not external) has a native
          // integrated terminal hosting its session — reveal it on click so the
          // chat is right there. External sessions live in their own terminal
          // outside DevTower, so there's nothing of ours to reveal.
          const sel = this.store.get(id);
          if (sel && !sel.external) this.terminals.reveal(id);
        }
        break;
      case "pickRoom":
        // a room/building was clicked: only zoom the camera (handled webview-side).
        // It no longer changes the Selected Directory — that is the explicit job of
        // the room's "USE DIR" button, so the selection stays put until asked.
        break;
      case "popout":
        // the HUD popout button → open (or reveal) the compact mini view
        this.openMini();
        break;
      case "useDir":
        // the room's "USE DIR" button → mount this worktree in the Selected
        // Directory view (works even for an empty, agent-less worktree) and reveal
        // it. This is the ONLY action that changes the selected directory.
        if (typeof m.room === "string") this.mountSelectedDir(m.room);
        break;
      case "requestSession":
        if (id) this.postSession(id);
        break;
      case "requestChanges":
        if (id) await this.postChanges(id);
        break;
      case "requestPrs":
        this.postPrs();
        break;
      case "reserveRoom":
        await this.reserveRoom(
          typeof m.floor === "number" ? m.floor : 0,
          typeof m.col === "number" ? m.col : 0
        );
        break;
      case "addDev":
        // + DEV on a room → drop an agent straight into that room's worktree
        if (typeof m.island === "string" && typeof m.worktree === "string") await this.addDev(m.island, m.worktree);
        break;
      case "addWorktree":
        // + WORKTREE on an island → create a new worktree room (no agent yet)
        if (typeof m.island === "string") await this.addWorktreeRoom(m.island);
        break;
      case "removeRoom":
        // note: must not truthiness-check — a legacy room can have name ""
        if (typeof m.room === "string") await this.removeRoom(m.room);
        break;
      case "removeWorktree":
        if (typeof m.worktree === "string") await this.removeWorktreeRoom(m.worktree, typeof m.island === "string" ? m.island : "");
        break;
      case "cdAgent":
        if (id) await this.cdAgent(id, m.room, m.ghost);
        break;
      case "getSettings":
        await this.postSettings();
        break;
      case "setGithubToken":
        if (typeof m.token === "string") {
          await setGithubToken(m.token);
          await this.postSettings();
          void this.prs.reauth(); // re-poll PRs now that a token exists
        }
        break;
      case "clearGithubToken":
        await clearGithubToken();
        await this.postSettings();
        void this.prs.reauth(); // drop the boards now that the token is gone
        break;
      case "getHooks":
        await this.postHooks();
        break;
      case "setHook":
        if (typeof m.id === "string" && typeof m.on === "boolean") {
          await setHookEnabled(this.context, m.id, m.on);
          await this.postHooks();
        }
        break;
      case "setAllHooks":
        if (typeof m.on === "boolean") {
          await setAllHooksEnabled(this.context, m.on);
          await this.postHooks();
        }
        break;
      case "pushBranch":
        if (typeof m.room === "string") await this.pushRoom(m.room);
        break;
      case "pullBranch":
        if (typeof m.room === "string") await this.pullRoom(m.room);
        break;
      case "fetchBranch":
        if (typeof m.room === "string") await this.fetchRoom(m.room);
        break;
      case "send":
        if (id) this.handleSend(id, m.text);
        break;
      case "action":
        if (m.act === "openPr" && m.url) {
          void vscode.env.openExternal(vscode.Uri.parse(String(m.url)));
          break;
        }
        if (id) await this.handleAction(id, m.act, m.path);
        break;
      case "debug":
        // scene-side debug events (shred swaps, toon spawn/leave, ghost render)
        // forwarded so the extension + webview share one ordered timeline
        if (typeof m.event === "string") dlog(`scene.${m.event}`, m.data && typeof m.data === "object" ? m.data : undefined);
        break;
      case "error":
        // an uncaught error in the webview (scene render crash, etc.) — always
        // recorded to errors.log so a blank panel can be diagnosed afterward
        elog("webview", {
          kind: typeof m.kind === "string" ? m.kind : undefined,
          message: typeof m.message === "string" ? m.message : "webview error",
          stack: typeof m.stack === "string" ? m.stack : undefined,
          source: typeof m.source === "string" ? m.source : undefined,
          line: typeof m.line === "number" ? m.line : undefined,
          col: typeof m.col === "number" ? m.col : undefined,
        });
        break;
    }
  }

  /** Persist a devtower boolean toggle so the EFFECTIVE value becomes `on`, even
   *  when a higher-precedence scope overrides Global. A workspace
   *  `.vscode/settings.json` (e.g. `devtower.debugLog: true`) wins over the Global
   *  value, so writing only Global left the effective value unchanged: the config
   *  echo then read the still-true effective value and bounced the toggle back on
   *  while logging kept running. Mirror the new value into every scope that
   *  currently defines the key so the override can't keep the old state. */
  private async persistToggle(key: string, on: boolean): Promise<void> {
    await this.persistValue(key, on);
  }

  /** Like persistToggle but for any value type (e.g. the performanceMode enum). */
  private async persistValue(key: string, value: unknown): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("devtower");
    const info = cfg.inspect(key);
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    if (info?.workspaceValue !== undefined)
      await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
    if (info?.workspaceFolderValue !== undefined)
      await cfg.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  }

  /** Push the persisted efficiency-mode + debug-log prefs and review-dispatch
   *  options to the webview. Sent on ready and re-sent when debugLog toggles so
   *  the scene's debug emission tracks the setting without a reopen. */
  private postConfig(): void {
    const cfg = vscode.workspace.getConfiguration("devtower");
    // Resolve the graphics-quality preset, migrating the deprecated keys when the
    // operator hasn't explicitly chosen one: performanceMode (smooth/balanced/eco)
    // maps to high/balanced/low, and an old efficiencyMode=true reads as "low".
    const qInfo = cfg.inspect<string>("graphicsQuality");
    const qSet = qInfo?.globalValue ?? qInfo?.workspaceValue ?? qInfo?.workspaceFolderValue;
    const perfInfo = cfg.inspect<string>("performanceMode");
    const perfSet = perfInfo?.globalValue ?? perfInfo?.workspaceValue ?? perfInfo?.workspaceFolderValue;
    const legacyPerf = perfSet ?? (cfg.get<boolean>("efficiencyMode", false) ? "eco" : undefined);
    const PERF_TO_QUALITY: Record<string, string> = { smooth: "high", balanced: "balanced", eco: "low" };
    const quality = qSet ?? (legacyPerf ? PERF_TO_QUALITY[legacyPerf] : undefined) ?? "balanced";
    this.panel?.webview.postMessage({
      type: "config",
      quality,
      projectScope: cfg.get<string>("projectScope", "global"),
      books: cfg.get<string>("bookPreference", "physical"),
      debug: cfg.get<boolean>("debugLog", false),
      debugLogExists: debugLogExists(),
      debugLogArchives: debugLogArchiveCount(),
      perfHud: cfg.get<boolean>("perfHud", false),
    });
  }

  /** Push the external-call tally to the Settings > Debug "External calls" table. */
  private postExecStats(): void {
    this.panel?.webview.postMessage({ type: "execStats", stats: execStatsSnapshot() });
  }

  private postPrs(): void {
    const payload = {
      type: "prs",
      crew: this.prs.getCrew(),
      review: this.prs.getReview(),
      connected: this.prs.isConnected(),
      // first GitHub poll still in flight → the webview shows a spinner instead of
      // a premature "not connected" (isConnected() reads false until that completes)
      loading: !this.prs.hasFetched(),
    };
    this.lastPrs = payload;
    // only feed the tower webview while it's on screen — a hidden scene shouldn't
    // re-render; it replays lastPrs when it becomes visible again (applyVisibility).
    // The mini popout always gets it, so it stays live even when used standalone.
    if (this.panel?.visible) this.panel.webview.postMessage(payload);
    this.mini?.postPrs(payload);
  }

  /** Push the current GitHub auth state (token connected? login, scopes, which
   *  features it unlocks) to the settings page. Never sends the token itself. */
  private async postSettings(): Promise<void> {
    const caps = await capabilities();
    this.panel?.webview.postMessage({ type: "settings", caps, scopeHelp: SCOPE_HELP });
  }

  /** Push the managed Claude Code hooks and their enabled state to the Hooks tab. */
  private async postHooks(): Promise<void> {
    this.panel?.webview.postMessage({ type: "hooks", hooks: await listHooks() });
  }

  /** Reveal the tower and open the settings overlay (from the nudge / command),
   *  optionally landing on a specific tab (e.g. "hooks"). Re-mounts the tower if it
   *  was closed while only the mini popout was open. */
  openSettings(tab?: string): void {
    this.showTower();
    // On a freshly created panel the webview's message listener isn't wired yet,
    // so this post would be dropped — defer it until the webview reports `ready`.
    if (this.webviewReady) this.panel?.webview.postMessage({ type: "openSettings", tab });
    else this.pendingOpenSettings = tab ?? true;
  }

  /* ============ MINI VIEW (compact popout) ============ */

  /** Open (or reveal) the compact mini view beside the tower. It is fed by this
   *  panel's data, so make sure a state payload exists, then create + push.
   *  Public so the `devtower.openMini` command can open straight to it. */
  openMini(): void {
    if (!this.lastState) this.postState(); // guarantee a payload to replay
    this.mini = MiniPanel.createOrShow(this.context, this);
    this.applyVisibility(); // a freshly opened mini view counts as on-screen
  }

  /** Mount a worktree checkout in the Selected Directory view and reveal it. The
   *  only action that changes the selected directory; shared by the tower's "USE
   *  DIR" button and the mini view's switch-directory control. */
  private mountSelectedDir(room: string): void {
    const dir = resolveDir(this.roomGitPaths.get(room) ?? room);
    if (!dir) return;
    this.usedDirRoom = room;
    void this.saveSelectedDir(room); // remember it across restarts
    this.store.setSelectedDir(dir); // sticky mount for the directory view
    this.store.setFocusedWorktree(dir);
    this.postState(); // re-render so the room's button reads "SELECTED DIR"
    void vscode.commands.executeCommand("devtower.directory.focus");
  }

  /* ---- MiniDelegate ---- */
  currentState(): unknown | undefined {
    return this.lastState;
  }
  currentPrs(): unknown | undefined {
    return this.lastPrs;
  }
  selectAgent(id: string): void {
    this.store.setSelected(id);
    const sel = this.store.get(id);
    // "View" jumps to the agent in the tower, so bring the tower to front — it may
    // be hidden behind the mini tab (same editor group) when this fires.
    this.showTower();
    // open the agent's chat: reveal its integrated terminal (the live Claude
    // session). External sessions live in their own terminal outside DevTower,
    // so there's nothing of ours to reveal.
    if (sel && !sel.external) this.terminals.reveal(id);
  }
  useDir(room: string): void {
    this.mountSelectedDir(room);
  }
  openPr(url: string): void {
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }
  spawnDev(island: string, worktree: string): void {
    void this.addDev(island, worktree); // same flow as the tower's + DEV
  }
  addWorktree(island: string): void {
    void this.addWorktreeRoom(island); // same flow as the tower's + WORKTREE
  }
  addProjectFromMini(): void {
    void this.addProject(); // pick a folder, reserve it as a new island
  }
  chatAgent(id: string): void {
    // open just the agent's chat (its integrated terminal) WITHOUT selecting it,
    // so the mini view can be used standalone without yanking the tower's camera.
    const sel = this.store.get(id);
    if (sel && !sel.external) this.terminals.reveal(id);
  }
  removeAgent(id: string): void {
    void this.handleAction(id, "sendHome"); // same confirm + retire as the tower
  }
  removeWorktree(worktree: string, island: string): void {
    void this.removeWorktreeRoom(worktree, island); // same confirm/warnings as the tower
  }
  removeProject(name: string): void {
    void this.removeRoom(name); // same confirm/warnings as the tower's root ✕
  }
  onVisibilityChange(): void {
    if (!MiniPanel.current) this.mini = undefined; // it closed itself
    this.applyVisibility();
    // the mini was the last view holding the instance open → full teardown
    if (!this.panel && !this.mini) this.disposeInstance();
  }

  /* ============ ROOMS (tower floors) ============ */

  /** Load reservations, healing legacy/corrupt entries (empty names, missing
   *  cols, dropped paths) so every room has a unique, non-empty key. */
  private getRooms(): ReservedRoom[] {
    // Stored GLOBALLY (not per-workspace) so your campus is the same no matter
    // which folder VS Code is opened at. Falls back through the older
    // per-workspace keys so existing reservations migrate in on first read.
    const raw = this.context.globalState.get<ReservedRoom[]>(
      "devtower.reservedRooms",
      this.context.workspaceState.get<ReservedRoom[]>(
        "devtower.reservedRooms",
        // pre-rename key, kept so the earliest reservations still survive
        this.context.workspaceState.get<ReservedRoom[]>("fleet.reservedRooms", [])
      )
    );
    const seen = new Set<string>();
    const seenPaths = new Set<string>();
    const rooms: ReservedRoom[] = [];
    for (const r of raw) {
      if (!r || typeof r.path !== "string" || !r.path) continue; // unusable without a directory
      // Collapse duplicate reservations for the SAME directory (a trailing slash,
      // symlink, or case difference would otherwise spawn a second empty building
      // named "<dir>-1"). Keep the first; skip later dupes of the same real path.
      const key = normalizeRoomPath(r.path);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      let name =
        (r.name || "").trim() ||
        path.basename(r.path) ||
        path.basename(path.dirname(r.path)) ||
        "room";
      let unique = name;
      let n = 2;
      while (seen.has(unique)) unique = `${name}-${n++}`;
      seen.add(unique);
      rooms.push({
        name: unique,
        path: r.path,
        floor: r.floor ?? 0,
        col: r.col ?? 0,
        workspaces: Array.isArray(r.workspaces) ? r.workspaces.filter((w) => typeof w === "string") : undefined,
      });
    }
    return rooms;
  }

  private async saveRooms(rooms: ReservedRoom[]): Promise<void> {
    await this.context.globalState.update("devtower.reservedRooms", rooms);
  }

  /** Rooms to actually render, honoring devtower.projectScope. "global" (default)
   *  shows every registered building; "workspace" shows only the buildings tagged
   *  with the folder this window is opened at. Filtering happens HERE (render only)
   *  so getRooms() stays the full source for agent matching, path resolution, and
   *  reserve/remove — a hidden building still works, it just isn't drawn. */
  private visibleRooms(): ReservedRoom[] {
    const all = this.getRooms();
    const scope = vscode.workspace.getConfiguration("devtower").get<string>("projectScope", "global");
    if (scope !== "workspace") return all;
    const key = this.workspaceKey();
    return all.filter((r) => (r.workspaces ?? []).includes(key));
  }

  /** Worktree rooms the user has explicitly assigned to an island. Worktrees do
   *  NOT auto-appear from git — only these (and rooms an agent is live in) show. */
  private getWorktreeRooms(): { island: string; path: string; branch: string; base?: string }[] {
    // Global (see getRooms) with a one-read fallback to the old per-workspace key.
    const raw = this.context.globalState.get<{ island: string; path: string; branch: string; base?: string }[]>(
      "devtower.worktreeRooms",
      this.context.workspaceState.get<{ island: string; path: string; branch: string; base?: string }[]>(
        "devtower.worktreeRooms",
        []
      )
    );
    return (raw || []).filter((w) => w && typeof w.path === "string" && w.path && typeof w.island === "string");
  }

  private async saveWorktreeRooms(rows: { island: string; path: string; branch: string; base?: string }[]): Promise<void> {
    await this.context.globalState.update("devtower.worktreeRooms", rows);
  }

  /* ============ SELECTED DIRECTORY (persisted "USE DIR") ============ */

  /** Key the persisted selection by the folder VS Code is opened at, so each
   *  workspace reopens to its own last-used room. Falls back to a fixed key when
   *  no folder is open (a window started on a bare editor still gets one slot). */
  private workspaceKey(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "__noworkspace__";
  }

  /** Remember (or clear) the room whose "USE DIR" was last pressed, globally but
   *  keyed by workspace, so it survives a window close/reopen. */
  private async saveSelectedDir(room: string | undefined): Promise<void> {
    const map = this.context.globalState.get<Record<string, string>>("devtower.selectedDirByWorkspace", {});
    const key = this.workspaceKey();
    if (room) map[key] = room;
    else delete map[key];
    await this.context.globalState.update("devtower.selectedDirByWorkspace", map);
  }

  /** Re-mount the last "USE DIR" room for this workspace on open. No-op when none
   *  was saved or its directory no longer resolves (a removed/renamed worktree). */
  private async restoreSelectedDir(): Promise<void> {
    const map = this.context.globalState.get<Record<string, string>>("devtower.selectedDirByWorkspace", {});
    const key = this.workspaceKey();
    const room = map[key];
    if (!room) {
      dlog("restoreSelectedDir.none", { key, saved: Object.keys(map) });
      return;
    }
    const mapped = this.roomGitPaths.get(room);
    const dir = resolveDir(mapped ?? room);
    // Trace the restore: the workspace key it looked up, the saved room, what the
    // room mapped to in roomGitPaths, and whether it resolved to a real dir. A
    // room "marked selected" but with empty files shows up here as dir != null
    // yet the directory view's getChildren still empty (see directory.* events).
    dlog("restoreSelectedDir", { key, room, mapped, dir, knownRooms: this.roomGitPaths.size });
    if (!dir) {
      await this.saveSelectedDir(undefined); // stale entry — its directory is gone
      return;
    }
    this.usedDirRoom = room;
    this.store.setSelectedDir(dir); // sticky mount for the directory view
    this.store.setFocusedWorktree(dir); // directory view lists it (no focus steal)
    this.postState(); // scene marks the room "SELECTED DIR"
  }

  /** Click on an empty grid slot → pick a directory → reserve the room. */
  private async reserveRoom(floor: number, col: number): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Add this directory as a project",
      title: `DevTower: add a project · ${floor >= 0 ? `F${floor}` : `B${-floor}`} · tower ${col}`,
    });
    if (!picked?.[0]) return;
    await this.reserveDir(picked[0].fsPath, floor, col);
  }

  /** Add a project from the mini view: pick a folder and reserve it at the next
   *  free column (no grid cell to click). Mirrors the tower's reserve flow. */
  private async addProject(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Add this directory as a project",
      title: "DevTower: add a project",
    });
    if (!picked?.[0]) return;
    // place it to the right of every existing island (islands sort by col)
    const col = this.getRooms().reduce((m, r) => Math.max(m, r.col), -1) + 1;
    await this.reserveDir(picked[0].fsPath, 0, col);
  }

  /** Reserve a directory as a room at the given grid cell, de-duping the path and
   *  name. Shared by the tower's grid-click reserve and the mini view's add. */
  private async reserveDir(dir: string, floor: number, col: number): Promise<void> {
    const rooms = this.getRooms();
    const key = this.workspaceKey();
    const existing = rooms.find((r) => normalizeRoomPath(r.path) === normalizeRoomPath(dir));
    if (existing) {
      // Already registered. In per-workspace scope a building only shows under the
      // workspaces it's tagged with, so re-adding it from a different window just
      // associates it here (rather than a dead-end "already has a room") so the
      // user can pull an existing project into this workspace's view.
      const tags = existing.workspaces ?? (existing.workspaces = []);
      if (!tags.includes(key)) {
        tags.push(key);
        await this.saveRooms(rooms);
        await this.refreshState();
        vscode.window.showInformationMessage(`DevTower: added ${existing.name} to this workspace.`);
      } else {
        vscode.window.showInformationMessage(`DevTower: ${path.basename(dir) || dir} already has a room.`);
      }
      return;
    }
    // never allow an empty/duplicate name — it becomes the room's identity
    let name = path.basename(dir) || path.basename(path.dirname(dir)) || "room";
    const base = name;
    let n = 2;
    while (rooms.some((r) => r.name === name)) name = `${base}-${n++}`;
    rooms.push({ name, path: dir, floor, col, workspaces: [key] });
    await this.saveRooms(rooms);
    await this.refreshState(); // surfaces the required main building right away
  }

  /** A worktree holds work that isn't safely on the remote — uncommitted changes
   *  or unpushed commits — so deleting it (worktreeRemove --force + branch -D)
   *  would lose data. Read from the same board the UI shows. */
  private worktreeHasUnsavedWork(p: string): boolean {
    const b = this.boardsByPath.get(p);
    if (!b) return false;
    return !!(b.modified || b.staged || b.unstagedAdd || b.unstagedDel ||
      b.stagedAdd || b.stagedDel || b.unpushed);
  }

  /** ✕ on the root building (and the mini view's project ✕) → stop every agent in
   *  the island, optionally delete all its NON-root worktrees from disk, and drop
   *  the reservation. The project directory itself is never deleted. The delete
   *  option is withheld while any worktree has uncommitted/unpushed work. */
  private async removeRoom(name: string): Promise<void> {
    const reserved = this.getRooms().find((r) => r.name === name);
    const agents = this.store.list().filter((a) => a.repo === name);
    const rootDir = reserved?.path;
    const dir = reserved?.path ?? this.dirForRepo(name);

    // every non-root worktree belonging to this project (agents + assigned rooms),
    // keyed to a branch so we can also drop the branch when deleting it
    const wtBranch = new Map<string, string | undefined>();
    const addWt = (p?: string, branch?: string) => {
      if (!p || p === rootDir || p === dir) return; // never the root checkout
      if (!wtBranch.has(p) || (branch && !wtBranch.get(p))) wtBranch.set(p, branch);
    };
    for (const a of agents) addWt(a.worktree, a.branch);
    for (const w of this.getWorktreeRooms()) if (w.island === name) addWt(w.path, w.branch);
    const worktrees = [...wtBranch.keys()];

    const dirty = worktrees.filter((p) => this.worktreeHasUnsavedWork(p));
    const canDelete = worktrees.length > 0;
    const blockDelete = dirty.length > 0;

    const choices = ["Unregister project"];
    if (canDelete && !blockDelete) choices.push("Unregister + delete worktrees");

    const detail = !canDelete
      ? ""
      : blockDelete
        ? ` Deleting its ${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"} is unavailable — ` +
          `${dirty.map((p) => path.basename(p)).join(", ")} ${dirty.length === 1 ? "has" : "have"} ` +
          `uncommitted or unpushed changes. Commit and push them first.`
        : ` You can also delete its ${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"} from disk.`;

    const pick = await vscode.window.showWarningMessage(
      `Unregister "${name}" from DevTower${agents.length ? ` and stop its ${agents.length} agent${agents.length === 1 ? "" : "s"}` : ""}? ` +
        `The project directory stays on disk.${detail}`,
      { modal: true },
      ...choices
    );
    if (!pick) return;

    for (const a of agents) {
      this.terminals.disposeAgent(a.id);
      this.store.remove(a.id);
    }
    if (pick === "Unregister + delete worktrees" && dir) {
      for (const [p, branch] of wtBranch) {
        try {
          await worktreeRemove(dir, p, branch);
        } catch (e) {
          vscode.window.showWarningMessage(`DevTower: couldn't remove worktree ${path.basename(p)} — ${String(e).slice(0, 120)}`);
        }
      }
    }
    if (reserved) await this.saveRooms(this.getRooms().filter((r) => r.name !== name));
    // forget every worktree room assigned to this island
    await this.saveWorktreeRooms(this.getWorktreeRooms().filter((w) => w.island !== name));
    // drop the persisted "USE DIR" selection if it pointed at this directory
    if (reserved && this.usedDirRoom === reserved.path) {
      this.usedDirRoom = undefined;
      this.store.setSelectedDir(undefined);
      await this.saveSelectedDir(undefined);
    }
    this.postState();
    void this.refreshState();
  }

  /** ✕ on a worktree building → confirm → stop its agent(s); optionally delete
   *  the git worktree (and its branch) from disk too. */
  private async removeWorktreeRoom(worktree: string, island: string): Promise<void> {
    const agents = this.store
      .list()
      .filter((a) => a.worktree === worktree || resolveCwd(a) === worktree);
    const branch = agents[0]?.branch;
    const label = branch && branch !== "—" ? branch : path.basename(worktree);
    const pick = await vscode.window.showWarningMessage(
      `Remove worktree room "${label}"? Its agent(s) will stop.`,
      { modal: true },
      "Remove room",
      "Remove room + delete worktree"
    );
    if (!pick) return;

    if (pick === "Remove room + delete worktree") {
      const changes = await changedFiles(worktree).catch(() => []);
      if (changes.length) {
        const confirm = await vscode.window.showWarningMessage(
          `"${label}" has ${changes.length} uncommitted change${changes.length === 1 ? "" : "s"}. Deleting the worktree discards them permanently. Are you sure?`,
          { modal: true },
          "Delete worktree and discard changes"
        );
        if (confirm !== "Delete worktree and discard changes") return;
      }
    }

    for (const a of agents) {
      this.terminals.disposeAgent(a.id);
      this.store.remove(a.id);
    }
    if (pick === "Remove room + delete worktree") {
      const dir = this.dirForRepo(island);
      if (!dir || dir === worktree) {
        vscode.window.showWarningMessage(`DevTower: couldn't resolve the repo for "${island}" to remove the worktree.`);
      } else {
        try {
          await worktreeRemove(dir, worktree, branch);
          vscode.window.showInformationMessage(`DevTower: removed worktree ${label}.`);
        } catch (e) {
          vscode.window.showErrorMessage(`DevTower: worktree remove failed — ${String(e).slice(0, 160)}`);
        }
      }
    }
    // unassign this worktree room
    await this.saveWorktreeRooms(this.getWorktreeRooms().filter((w) => w.path !== worktree));
    // drop the persisted "USE DIR" selection if it pointed at this worktree
    if (this.usedDirRoom === worktree) {
      this.usedDirRoom = undefined;
      this.store.setSelectedDir(undefined);
      await this.saveSelectedDir(undefined);
    }
    this.postState();
    void this.refreshState();
  }

  /** + DEV on a room → drop an agent straight into that room's worktree. No
   *  prompt — the room already fixes the directory. */
  /** A short random suffix (4 hex chars) for a new agent's id/name, not already
   *  taken by an existing agent. Random instead of an incrementing counter so a
   *  name stays stable as siblings come and go, and is unique enough to grep
   *  when reporting a bug against a specific agent. */
  private uniqueAgentSuffix(island: string): string {
    const taken = new Set(this.store.list().map((a) => a.id));
    for (let i = 0; i < 50; i++) {
      const suffix = randomUUID().replace(/-/g, "").slice(0, 4);
      if (!taken.has(`${island}-${suffix}`)) return suffix;
    }
    return randomUUID().slice(0, 8); // astronomically unlikely fallback
  }

  private async addDev(island: string, worktree: string): Promise<void> {
    const key = `dev::${worktree}`;
    if (this.addingRooms.has(key)) return; // guard a double-click
    this.addingRooms.add(key);
    try {
      if (!worktree) {
        vscode.window.showWarningMessage(`DevTower: no directory for "${island}".`);
        return;
      }
      const suffix = this.uniqueAgentSuffix(island);
      const branch = await currentBranch(worktree);
      const id = `${island}-${suffix}`;
      dlog("panel.addDev", { island, worktree, id });
      this.store.apply({
        id,
        name: `${island}-${suffix}`,
        model: "—",
        repo: island,
        worktree,
        branch,
        state: "idle",
        task: "Ready — dispatch a task from the panel",
        elapsed: "new",
      });
      this.store.setSelected(id);
      this.launchSession(id);
    } finally {
      this.addingRooms.delete(key);
    }
  }

  /** + WORKTREE on an island → prompt to assign an existing worktree as a room
   *  or create a brand-new one. Worktrees only become rooms once assigned here.
   *  No agent is spawned; the operator drops one in afterwards with + DEV. */
  private async addWorktreeRoom(island: string): Promise<void> {
    const key = `wt::${island}`;
    if (this.addingRooms.has(key)) return;
    this.addingRooms.add(key);
    try {
      const dir = this.dirForRepo(island);
      if (!dir) {
        vscode.window.showWarningMessage(`DevTower: no directory known for "${island}".`);
        return;
      }
      if (!(await isRepo(dir))) {
        vscode.window.showWarningMessage(`DevTower: "${island}" isn't a git repository — can't add a worktree.`);
        return;
      }
      const assigned = this.getWorktreeRooms().filter((w) => w.island === island);
      const taken = new Set(assigned.map((w) => w.path));
      // existing on-disk worktrees not already a room (and not the root checkout)
      const existing = (await worktreeList(dir)).filter((w) => w.path !== dir && !taken.has(w.path));
      const items: (vscode.QuickPickItem & { id: string; branch?: string })[] = [
        { label: "$(add) Create a new worktree", description: "new branch + isolated checkout", id: "__new__" },
        ...existing.map((w) => ({
          label: `$(git-branch) ${w.branch || path.basename(w.path)}`,
          description: w.path,
          id: w.path,
          branch: w.branch,
        })),
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: `Add a worktree to ${island}`,
        placeHolder: "Assign an existing worktree, or create a new one",
      });
      if (!pick) return;

      let row: { island: string; path: string; branch: string; base?: string };
      if (pick.id === "__new__") {
        try {
          const wt = await worktreeAdd(dir);
          row = { island, path: wt.wtPath, branch: wt.branch, base: wt.base };
        } catch (e) {
          vscode.window.showErrorMessage(`DevTower: worktree creation failed — ${String(e).slice(0, 160)}`);
          return;
        }
      } else {
        row = { island, path: pick.id, branch: pick.branch || "" };
      }
      const rows = this.getWorktreeRooms().filter((w) => !(w.island === island && w.path === row.path));
      rows.push(row);
      await this.saveWorktreeRooms(rows);
      this.postState(); // show the room right away (don't move the camera)
      void this.refreshState(); // fill in its branch + stats
    } finally {
      this.addingRooms.delete(key);
    }
  }

  /** Start the agent's real Claude CLI session in its terminal (worktree cwd);
   *  devtower.launchCommand takes precedence if the user configured one. */
  private launchSession(id: string): void {
    const cfg = vscode.workspace.getConfiguration("devtower");
    const launch = cfg.get<string>("launchCommand", "").trim();
    const claudeCmd = cfg.get<string>("claudeCommand", "claude").trim();
    // Pin an explicit session id so discovery binds THIS transcript to THIS
    // placeholder deterministically — essential when several placeholders share
    // one worktree (one + DEV per dev), where a worktree/time heuristic can't
    // tell which placeholder launched which session. Only the default `claude`
    // path can carry the flag; a custom launchCommand falls back to the
    // launch-time/worktree heuristic in discovery.
    const sessionId = randomUUID();
    const mode = !launch && claudeCmd ? "claude" : launch ? "launchCommand" : "reveal";
    dlog("panel.launchSession", { id, mode, sessionId: mode === "claude" ? sessionId : undefined });
    if (!launch && claudeCmd) {
      this.discovery?.expectSession(id, sessionId);
      this.terminals.send(id, `${claudeCmd} --session-id ${sessionId}`);
    } else {
      this.discovery?.expectSession(id);
      this.terminals.reveal(id);
    }
  }

  /** Recompute live git stats + branch per ROOM (keyed by the room's checkout
   *  path, which is exactly the building key the webview uses) and push if it
   *  changed. Git is resolved from the path even when it lives in a parent dir. */
  /** Manual full refresh: re-scan for sessions, re-read every room's git board,
   *  and re-poll PRs. Wired to the devtower.refresh command and the tower's
   *  Refresh button so the user can update on demand — the event-driven path
   *  (.git watchers, file saves, hooks) handles the rest without background
   *  polling. */
  async refreshAll(): Promise<void> {
    await this.discovery?.refresh().catch(() => 0);
    await this.refreshState();
    void this.prs.refresh(true);
  }

  private async refreshState(): Promise<void> {
    // roomKey → absolute path to run git in. Track which keys are island (main)
    // rooms vs worktree rooms so a vanished worktree can be auto-pruned while a
    // vanished island just renders a "missing" board.
    const pairs = new Map<string, string>();
    const islandPaths = new Set<string>();
    const worktreePaths = new Set<string>();
    const forkBase = new Map<string, string>(); // roomKey → fork-point sha (worktrees)
    for (const isl of this.getRooms()) if (isl.path) { pairs.set(isl.path, isl.path); islandPaths.add(isl.path); }
    for (const w of this.getWorktreeRooms()) { pairs.set(w.path, w.path); worktreePaths.add(w.path); if (w.base) forkBase.set(w.path, w.base); }
    for (const a of this.store.list()) {
      if (a.worktree && a.worktree.trim()) pairs.set(a.worktree, resolveCwd(a) ?? a.worktree);
    }
    // (re)watch each repo's .git so stage/commit/push reflects immediately
    const repoDirs = new Set<string>();
    for (const p of pairs.values()) if (fs.existsSync(p)) repoDirs.add(p);
    void this.syncGitWatchers(repoDirs);
    this.roomGitPaths = new Map(pairs); // room key → git path, for sync requests
    const prs = [...this.prs.getCrew(), ...this.prs.getReview()];
    const boards = new Map<string, BoardData>();
    const branches = new Map<string, string>();
    const vanishedWorktrees: string[] = [];
    const emptyBoard = (over: Partial<BoardData>): BoardData => ({
      branch: "", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
      unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0,
      committedAdd: 0, committedDel: 0, base: "", ahead: 0, unpushed: 0, behind: 0, commits: [],
      prReady: this.prs.hasFetched(), ...over,
    });
    for (const [roomKey, p] of pairs) {
      // directory removed out from under us (e.g. a deleted worktree): a worktree
      // room is auto-pruned; an island room shows a distinct "missing" board so
      // the user knows its directory is gone rather than just "no git".
      if (!fs.existsSync(p)) {
        if (worktreePaths.has(roomKey) && !islandPaths.has(roomKey)) vanishedWorktrees.push(roomKey);
        else if (islandPaths.has(roomKey)) boards.set(roomKey, emptyBoard({ missing: true }));
        continue;
      }
      try {
        if (!(await isRepo(p))) continue; // git is found by walking up to the repo root
        const sum = await branchSummary(p, forkBase.get(roomKey));
        if (!sum) continue;
        const branch = await currentBranch(p);
        branches.set(roomKey, branch);
        const pr = prs.find((x) => x.branch && x.branch === branch);
        boards.set(roomKey, this.buildBoard(sum, branch, pr));
      } catch {
        /* path vanished or git hiccup — skip this round */
      }
    }
    // drop rooms whose worktree directory is gone, then re-sync the webview
    if (vanishedWorktrees.length) {
      const gone = new Set(vanishedWorktrees);
      await this.saveWorktreeRooms(this.getWorktreeRooms().filter((w) => !gone.has(w.path)));
    }
    this.boardsByPath = boards;
    this.branchByPath = branches;
    // feed the room checkouts' branches to the PR service so a PR opened outside
    // any agent (e.g. from the CLI) still surfaces on its building's board
    const prTargets: { cwd: string; repo: string; branch: string }[] = [];
    for (const [roomKey, branch] of branches) {
      const gp = pairs.get(roomKey);
      if (gp && branch) prTargets.push({ cwd: gp, repo: path.basename(gp), branch });
    }
    this.prs.setExtraTargets(prTargets);
    // only push (and wake the render loop) when something actually changed, so
    // the idle poll doesn't defeat the webview's park-when-quiet power saving
    const sig = JSON.stringify([...boards].sort());
    if (sig !== this.lastWtSignature || vanishedWorktrees.length) {
      this.lastWtSignature = sig;
      this.postState(); // pruned rooms also need a re-sync so they stop rendering
    }
  }

  /** Best-effort working directory for a repo: a reserved room, an agent already
   *  in that repo (exact or by basename), else the first workspace folder. */
  private dirForRepo(repo: string): string | undefined {
    const reserved = this.getRooms().find((r) => r.name === repo);
    if (reserved?.path) return reserved.path;
    const base = repo.split("/").pop();
    const peer =
      this.store.list().find((a) => a.repo === repo) ??
      this.store.list().find((a) => a.repo.split("/").pop() === base);
    if (peer) {
      const cwd = resolveCwd(peer);
      if (cwd) return cwd;
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Drag a toon onto a room (or an empty ghost cell) → /cd that agent there.
   *  Existing room: use its directory. Empty cell: pick + reserve a new room. */
  private async cdAgent(
    id: string,
    room?: string,
    ghost?: { floor: number; col: number }
  ): Promise<void> {
    const agent = this.store.get(id);
    if (!agent) return;
    // never relocate an agent mid-task — its /cd would land in the middle of a
    // running turn. Wait until it's idle/waiting/done.
    if (agent.state === "active") {
      vscode.window.showInformationMessage(
        `DevTower: ${agent.name} is active — wait until it finishes before moving it.`
      );
      return;
    }

    let dir: string | undefined;
    let roomName: string | undefined;
    if (typeof room === "string") {
      const reserved = this.getRooms().find((r) => r.name === room);
      dir = reserved?.path;
      if (!dir) {
        const peer = this.store.list().find((a) => a.repo === room && a.id !== id);
        dir = peer ? resolveCwd(peer) : undefined;
      }
      roomName = room;
    } else if (ghost) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: `Move ${agent.name} here`,
        title: `DevTower: pick a directory for ${agent.name}`,
      });
      if (!picked?.[0]) return;
      dir = picked[0].fsPath;
      const rooms = this.getRooms();
      const existing = rooms.find((r) => r.path === dir);
      if (existing) {
        roomName = existing.name;
      } else {
        let name = path.basename(dir) || path.basename(path.dirname(dir)) || "room";
        const base = name;
        let n = 2;
        while (rooms.some((r) => r.name === name)) name = `${base}-${n++}`;
        rooms.push({ name, path: dir, floor: ghost.floor, col: ghost.col });
        await this.saveRooms(rooms);
        roomName = name;
      }
    }

    if (!dir) {
      vscode.window.showWarningMessage(`DevTower: no directory known for room "${room ?? ""}".`);
      return;
    }
    const cur = resolveCwd(agent);
    if (cur && canonicalDir(cur) === canonicalDir(dir)) return; // already there (canonical compare)

    // tell the live Claude session to change directory; the terminal hosts the
    // real session (auto-resumed on first open). Use command() so the path is
    // pasted as a literal block — typing it would trip Claude's /cd autocomplete
    this.terminals.command(id, `/cd ${dir}`);
    // do NOT move the toon yet — only show it's in transit. Discovery relocates
    // it (repo/worktree) once the transcript actually reports the new cwd, so a
    // declined or failed /cd leaves the agent exactly where it was.
    this.store.apply({ id, task: `Moving to ${path.basename(dir)}…` });
    this.discovery?.expectCd(id, dir, roomName);
    this.postState();
  }

  private handleSend(id: string, text: string): void {
    const t = (text || "").trim();
    if (!t) return;
    // the agent's terminal hosts the real Claude session (auto-attached via
    // --resume on first open), so text goes straight into the CLI prompt
    this.terminals.send(id, t);
    this.appendSession(id, { kind: "user", text: t });
    this.store.setState(id, "active", `Resuming: ${t.slice(0, 48)}`);
  }

  private async handleAction(id: string, act: string, path?: string): Promise<void> {
    switch (act) {
      case "approve":
        this.handleSend(id, "Approved — continue with what you proposed.");
        break;
      case "retry":
        this.handleSend(id, "Retry the failed run.");
        break;
      case "interrupt":
        this.store.setState(id, "idle", "Interrupted by operator");
        break;
      case "terminal":
        this.terminals.reveal(id);
        break;
      case "sendHome": {
        // confirm, then close the dev's Claude terminal (kills its process) and
        // retire it from the tower. retireOwned also suppresses its transcript so
        // it can't resurface as an external ghost on the next poll or a reload.
        const agent = this.store.get(id);
        if (!agent || agent.external) break;
        const confirm = await vscode.window.showWarningMessage(
          `Send ${agent.name} home? This closes its Claude terminal and removes it from the tower.`,
          { modal: true },
          "Send Home"
        );
        if (confirm !== "Send Home") break;
        this.terminals.disposeAgent(id);
        this.discovery?.retireOwned(id);
        break;
      }
      case "diff":
        await this.openDiffFor(id);
        break;
      case "openFileDiff":
        if (path) await this.openFile(id, path);
        break;
      case "stageFile":
        if (path) await this.toggleStage(id, path, true);
        break;
      case "unstageFile":
        if (path) await this.toggleStage(id, path, false);
        break;
      case "stageAll":
      case "unstageAll": {
        const agent = this.store.get(id);
        const cwd = agent && resolveCwd(agent);
        if (cwd && (await isRepo(cwd))) {
          if (act === "stageAll") await stageAll(cwd);
          else await unstageAll(cwd);
          await this.postChanges(id);
        }
        break;
      }
    }
  }

  private async openDiffFor(id: string): Promise<void> {
    const agent = this.store.get(id);
    if (!agent) return;
    const cwd = resolveCwd(agent);
    if (cwd && (await isRepo(cwd))) {
      const st = await status(cwd);
      const file = st.unstaged[0] ?? st.staged[0];
      if (file) await openGitFileDiff(cwd, file, agent.name);
      return;
    }
    if (agent.files[0]) await openMockFileDiff(this.store, id, agent.files[0].path);
  }

  private async openFile(id: string, path: string): Promise<void> {
    const agent = this.store.get(id);
    if (!agent) return;
    const cwd = resolveCwd(agent);
    if (cwd && (await isRepo(cwd))) {
      const st = await status(cwd);
      const file = [...st.unstaged, ...st.staged].find((f) => f.path === path);
      if (file) {
        await openGitFileDiff(cwd, file, agent.name);
        return;
      }
    }
    await openMockFileDiff(this.store, id, path);
  }

  private async toggleStage(id: string, path: string, staging: boolean): Promise<void> {
    const agent = this.store.get(id);
    const cwd = agent && resolveCwd(agent);
    if (!cwd || !(await isRepo(cwd))) {
      vscode.window.showInformationMessage("Staging is available for real git worktrees only.");
      return;
    }
    if (staging) await stage(cwd, path);
    else await unstage(cwd, path);
    await this.postChanges(id);
  }

  private async postChanges(id: string): Promise<void> {
    const agent = this.store.get(id);
    if (!agent) return;
    const cwd = resolveCwd(agent);
    let files: any[];
    if (cwd && (await isRepo(cwd))) {
      files = await changedFiles(cwd);
    } else {
      // mock fallback: present seeded files as unstaged
      files = (agent.files ?? []).map((f) => ({
        path: f.path,
        add: f.add,
        del: f.del,
        staged: false,
        unstaged: true,
        untracked: false,
      }));
    }
    this.panel?.webview.postMessage({ type: "changes", id, files, real: !!(cwd && (await isRepo(cwd))) });
  }

  private appendSession(id: string, msg: SessionMessage): void {
    const agent = this.store.get(id);
    if (!agent) return;
    agent.session = [...(agent.session ?? []), msg];
    this.postSession(id);
  }

  private postState(): void {
    // each island carries the required main checkout + the worktrees the user has
    // assigned to it (branches filled from the live cache)
    const wtRooms = this.getWorktreeRooms();
    const rooms = this.visibleRooms().map((r) => {
      const main = r.path ? [{ path: r.path, branch: this.branchByPath.get(r.path) ?? "" }] : [];
      const assigned = wtRooms
        .filter((w) => w.island === r.name)
        .map((w) => ({ path: w.path, branch: this.branchByPath.get(w.path) ?? w.branch }));
      return { ...r, worktrees: [...main, ...assigned] };
    });
    // a reviewer's verdict is derived (not stored) from the PR decision the
    // PrService already polls: once the reviewer posts a review, the PR's
    // reviewDecision flips and the scene stamps approved / changes.
    const prById = new Map<string, PrInfo>();
    for (const p of [...this.prs.getCrew(), ...this.prs.getReview()]) prById.set(p.id, p);
    const verdict = (review: PrInfo["review"]): "approved" | "changes" | "pending" =>
      review === "approved" ? "approved" : review === "changes" ? "changes" : "pending";
    const agents = this.store.list().map((a) => {
      if (!a.reviewOf) return a;
      const pr = prById.get(a.reviewOf.prId);
      return { ...a, reviewVerdict: pr ? verdict(pr.review) : "pending" };
    });
    const payload = {
      type: "state",
      agents,
      selectedId: this.store.getSelectedId(),
      usedDir: this.usedDirRoom,
      selectedDir: collapseHome(this.store.getSelectedDir()),
      rooms,
      boards: Object.fromEntries(this.boardsByPath),
      // lets the mini disable its "View" action only when there is no tower to
      // jump to (View selects/zooms an agent in the scene and reveals the tower).
      // Gated on the panel EXISTING, not its visibility: a tower hidden behind the
      // mini tab is still a valid jump target — View reveals it (see selectAgent).
      towerOpen: !!this.panel,
    };
    this.lastState = payload;
    // only feed the tower webview while it's on screen (see postPrs); the mini
    // popout always receives the update so a standalone mini view stays current.
    if (this.panel?.visible) this.panel.webview.postMessage(payload);
    this.mini?.postState(payload);
  }

  private postSession(id: string): void {
    const agent = this.store.get(id);
    if (!agent) return;
    this.panel?.webview.postMessage({ type: "session", id, messages: getSession(agent) });
  }

  /* ============ PLAN USAGE (5h / weekly rate-limit windows) ============ */

  /** Path Claude Code's statusline caches its `rate_limits` payload to. */
  private usageFile(): string {
    return path.join(os.homedir(), ".claude", "claude-viewer-rate-limits.json");
  }

  /** Watch + poll the rate-limit cache so the header meters stay current. The
   *  file is rewritten whenever a Claude statusline renders; we also poll on an
   *  interval as a fallback in case the watch misses an atomic replace. */
  private startUsage(): void {
    this.postUsage();
    this.usageTimer = setInterval(() => {
      if (this.panel?.visible) this.postUsage();
    }, 60_000);
    try {
      this.usageWatcher = fs.watch(this.usageFile(), () => {
        if (this.panel?.visible) this.postUsage();
      });
    } catch {
      /* file may not exist yet — the interval will pick it up once it appears */
    }
  }

  private postUsage(): void {
    let usage: { fiveHour?: UsageWindow; sevenDay?: UsageWindow } | null = null;
    try {
      const raw = fs.readFileSync(this.usageFile(), "utf8");
      const j = JSON.parse(raw);
      const read = (o: any): UsageWindow | undefined =>
        o && typeof o.used_percentage === "number"
          ? { pct: Math.max(0, Math.min(100, Math.round(o.used_percentage))), resetsAt: o.resets_at }
          : undefined;
      usage = { fiveHour: read(j.five_hour), sevenDay: read(j.seven_day) };
    } catch {
      usage = null; // missing/unreadable → webview hides the meters
    }
    this.panel?.webview.postMessage({ type: "usage", usage });
  }

  /** Full teardown — only when BOTH the tower and the mini are gone. Drops the
   *  singleton, stops every timer/watcher, and disposes the data-pipeline
   *  subscriptions and any remaining panel. */
  private disposeInstance(): void {
    ConsolePanel.current = undefined;
    this.mini?.close();
    this.mini = undefined;
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    if (this.gitDebounce) clearTimeout(this.gitDebounce);
    if (this.editDebounce) clearTimeout(this.editDebounce);
    for (const w of this.gitWatchers.values()) w.close();
    this.gitWatchers.clear();
    this.editWatcher?.close();
    this.usageWatcher?.close();
    this.towerDisposables.forEach((d) => d.dispose());
    this.towerDisposables = [];
    this.panel?.dispose();
    this.panel = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(webview: vscode.Webview): string {
    const w = webview;
    const nonce = makeNonce();
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "console.css"));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "console.js"));
    const crew = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "crew.js"));
    const csp = [
      `default-src 'none'`,
      `style-src ${w.cspSource} 'unsafe-inline'`,
      `font-src ${w.cspSource} https://fonts.gstatic.com`,
      `style-src-elem ${w.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;600;700&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
<link href="${css}" rel="stylesheet" />
<title>DevTower</title>
</head>
<body data-theme="dark">
  <!-- full-bleed 3D scene -->
  <div id="crew-wrap" class="crew-wrap"><canvas id="crew-canvas"></canvas></div>

  <!-- top HUD -->
  <header class="hud-top">
    <div class="hud-left">
      <div class="telemetry">
        <span class="tstat"><i class="pip active"></i><b id="t-active">0</b><span class="lbl">run</span></span>
        <span class="tstat"><i class="pip waiting"></i><b id="t-waiting">0</b><span class="lbl">wait</span></span>
        <span class="tstat"><i class="pip error"></i><b id="t-error">0</b><span class="lbl">err</span></span>
        <span class="tstat"><b id="devtower-count">0</b><span class="lbl">crew</span></span>
      </div>
      <div class="seldir" id="seldir" hidden>
        <span class="lbl">dir</span><span class="seldir-path" id="seldir-path"></span>
      </div>
    </div>
    <div class="spacer"></div>
    <button class="iconbtn" id="refreshbtn" title="Refresh sessions, git boards, and PRs now">⟳</button>
    <button class="iconbtn" id="lbbtn" title="Token leaderboard">≣</button>
    <button class="iconbtn" id="popoutbtn" title="Mini view (compact popout)">⧉</button>
    <button class="iconbtn" id="settingsbtn" title="Settings">⚙</button>
  </header>

  <!-- plan-usage meters (5h / weekly token windows), pinned bottom-right -->
  <div class="usage" id="usage" hidden>
    <span class="umeter" id="u-5h" title="Plan usage — 5-hour window">
      <span class="ulbl">5H</span><span class="ubar"><i></i></span><b class="upct">–</b><small class="ureset"></small>
    </span>
    <span class="umeter" id="u-wk" title="Plan usage — weekly window">
      <span class="ulbl">WK</span><span class="ubar"><i></i></span><b class="upct">–</b><small class="ureset"></small>
    </span>
  </div>

  <!-- token leaderboard overlay (all agents ranked by context usage) -->
  <div class="lb-scrim" id="leaderboard" hidden></div>

  <!-- settings overlay (GitHub token + capabilities) -->
  <div class="settings-scrim" id="settings" hidden></div>

  <!-- arrivals / departures feed -->
  <div class="feed" id="feed"></div>

  <!-- selected-agent panel: chat + changes -->
  <aside class="panel" id="panel" hidden></aside>

  <script nonce="${nonce}">
    // Capture uncaught errors as early as possible (before the bundles load) so a
    // crash that blanks the scene is still recorded. Buffer until console.js wires
    // up the vscode bridge (window.__dtSendError), then flush.
    (function () {
      window.__dtErrors = [];
      var emit = function (rec) {
        try { (window.__dtSendError || function (r) { window.__dtErrors.push(r); })(rec); } catch (_) {}
      };
      window.addEventListener("error", function (e) {
        emit({ kind: "error", message: (e && e.message) || String((e && e.error) || "error"),
               stack: e && e.error && e.error.stack ? String(e.error.stack) : undefined,
               source: e && e.filename, line: e && e.lineno, col: e && e.colno });
      });
      window.addEventListener("unhandledrejection", function (e) {
        var r = e && e.reason;
        emit({ kind: "unhandledrejection", message: r && r.message ? r.message : String(r),
               stack: r && r.stack ? String(r.stack) : undefined });
      });
    })();
  </script>
  <script nonce="${nonce}" src="${crew}"></script>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** Collapse the user's home prefix to `~` so the HUD's selected-directory label
 *  reads compactly (the webview truncates the rest from the left). */
function collapseHome(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const home = os.homedir();
  if (home && (dir === home || dir.startsWith(home + path.sep))) {
    return "~" + dir.slice(home.length);
  }
  return dir;
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Canonical key for a reserved-room directory so the same folder reached via a
 *  trailing slash, a symlink, or a case difference maps to one building. Resolves
 *  the real path when it exists; folds case on case-insensitive platforms. */
// room keys are de-duplicated by canonical path (shared with the /cd relocation
// match in claude.ts) so a trailing slash, symlink, or case difference all fold
// to one building.
const normalizeRoomPath = canonicalDir;
