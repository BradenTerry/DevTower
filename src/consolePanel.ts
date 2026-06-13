import * as vscode from "vscode";
import { DevTowerStore, Agent, SessionMessage } from "./store";
import { TerminalManager } from "./terminals";
import { getSession } from "./session";
import { openGitFileDiff, openMockFileDiff } from "./diffProvider";
import * as path from "path";
import { isRepo, resolveCwd, status, stage, unstage, stageAll, unstageAll, changedFiles, worktreeAdd, worktreeForPr, worktreeRemove, worktreeList, currentBranch, branchSummary, runGit } from "./git";
import { PrService, PrInfo } from "./prs";
import { ClaudeDiscovery } from "./claude";
import * as fs from "fs";
import * as os from "os";

/** POSIX single-quote a string so it survives as one shell argument. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

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
  };
}

/** A grid cell the user reserved for a directory (persisted per-workspace). */
export interface ReservedRoom {
  name: string;
  path: string;
  floor: number;
  col: number;
}

/** Full-window cockpit hosted as an editor-area WebviewPanel. */
export class ConsolePanel {
  public static current: ConsolePanel | undefined;
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
  private statsTimer?: ReturnType<typeof setInterval>;
  private lastWtSignature = "";
  /** fs.watch handles on each tracked repo's .git dir, so staging/committing is
   *  reflected at once instead of waiting for the poll. Keyed by repo top-level. */
  private gitWatchers = new Map<string, fs.FSWatcher>();
  private gitDebounce?: ReturnType<typeof setTimeout>;
  /** room key → absolute git path, so a sync request can run git in the right dir. */
  private roomGitPaths = new Map<string, string>();
  private fetchTimer?: ReturnType<typeof setInterval>;

  static createOrShow(
    context: vscode.ExtensionContext,
    store: DevTowerStore,
    terminals: TerminalManager,
    prs: PrService,
    discovery?: ClaudeDiscovery
  ): void {
    const column = vscode.ViewColumn.Active;
    if (ConsolePanel.current) {
      ConsolePanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ConsolePanel.viewType,
      "DevTower",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "devtower.svg");
    ConsolePanel.current = new ConsolePanel(panel, context, store, terminals, prs, discovery);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly store: DevTowerStore,
    private readonly terminals: TerminalManager,
    private readonly prs: PrService,
    private readonly discovery?: ClaudeDiscovery
  ) {
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.store.onChange(() => this.postState(), null, this.disposables);
    this.store.onDidChangeSelection(() => this.postState(), null, this.disposables);
    this.prs.onChange(() => this.postPrs(), null, this.disposables);
    this.prs.onChange(() => void this.refreshState(), null, this.disposables); // PR → board column
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.startUsage();
    // a saved file is a working-tree (unstaged) change → refresh promptly
    vscode.workspace.onDidSaveTextDocument(() => this.onGitChange(), null, this.disposables);
    // poll each worktree's git stats as a fallback (the .git watchers below catch
    // stage/commit/push instantly; the poll covers edits made outside VS Code)
    this.statsTimer = setInterval(() => {
      if (this.panel.visible) void this.refreshState();
    }, 6_000);
    // background fetch so "behind" (out-of-date) is meaningful; once shortly after
    // open, then periodically while visible
    setTimeout(() => void this.fetchAll(), 5_000);
    this.fetchTimer = setInterval(() => {
      if (this.panel.visible) void this.fetchAll();
    }, 180_000);
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
        /* platform without recursive watch / dir gone — poll still covers it */
      }
    }
  }

  private async onMessage(m: any): Promise<void> {
    const id: string | undefined = m.id;
    switch (m.type) {
      case "ready":
        this.postState();
        this.postUsage();
        // push the persisted efficiency-mode setting (defaults off) plus the
        // review-dispatch options (selectable skills + saved defaults)
        {
          const cfg = vscode.workspace.getConfiguration("devtower");
          this.panel.webview.postMessage({
            type: "config",
            eco: cfg.get<boolean>("efficiencyMode", false),
            reviewSkills: cfg.get<string[]>("reviewSkills", []),
            reviewDefaults: cfg.get<object>("reviewDefaults", {}),
            reviewAgents: this.discoverReviewAgents(),
          });
        }
        void this.refreshState(); // fill in each island's worktree rooms
        break;
      case "setEco":
        // operator toggled efficiency mode → persist their choice
        await vscode.workspace
          .getConfiguration("devtower")
          .update("efficiencyMode", !!m.on, vscode.ConfigurationTarget.Global);
        break;
      case "select":
        if (id) this.store.setSelected(id);
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
        if (typeof m.island === "string") await this.addWorktree(m.island);
        break;
      case "assignReview":
        if (m.pr && typeof m.pr === "object") {
          await this.assignReview(m.pr, {
            skills: Array.isArray(m.skills) ? m.skills.filter((s: any) => typeof s === "string") : undefined,
            effort: typeof m.effort === "string" ? m.effort : undefined,
            instructions: typeof m.instructions === "string" ? m.instructions : undefined,
            agent: typeof m.agent === "string" ? m.agent : undefined,
            saveDefault: !!m.saveDefault,
          });
        }
        break;
      case "removeRoom":
        // note: must not truthiness-check — a legacy room can have name ""
        if (typeof m.room === "string") await this.removeRoom(m.room);
        break;
      case "removeWorktree":
        if (typeof m.worktree === "string") await this.removeWorktree(m.worktree, typeof m.island === "string" ? m.island : "");
        break;
      case "cdAgent":
        if (id) await this.cdAgent(id, m.room, m.ghost);
        break;
      case "refreshPrs":
        void this.prs.refresh();
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
    }
  }

  private postPrs(): void {
    this.panel.webview.postMessage({
      type: "prs",
      crew: this.prs.getCrew(),
      review: this.prs.getReview(),
    });
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
    const rooms: ReservedRoom[] = [];
    for (const r of raw) {
      if (!r || typeof r.path !== "string" || !r.path) continue; // unusable without a directory
      let name =
        (r.name || "").trim() ||
        path.basename(r.path) ||
        path.basename(path.dirname(r.path)) ||
        "room";
      let unique = name;
      let n = 2;
      while (seen.has(unique)) unique = `${name}-${n++}`;
      seen.add(unique);
      rooms.push({ name: unique, path: r.path, floor: r.floor ?? 0, col: r.col ?? 0 });
    }
    return rooms;
  }

  private async saveRooms(rooms: ReservedRoom[]): Promise<void> {
    await this.context.globalState.update("devtower.reservedRooms", rooms);
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

  /** Click on an empty grid slot → pick a directory → reserve the room. */
  private async reserveRoom(floor: number, col: number): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Reserve room for this directory",
      title: `DevTower: reserve ${floor >= 0 ? `F${floor}` : `B${-floor}`} · tower ${col}`,
    });
    if (!picked?.[0]) return;
    const dir = picked[0].fsPath;
    const rooms = this.getRooms();
    if (rooms.some((r) => r.path === dir)) {
      vscode.window.showInformationMessage(`DevTower: ${path.basename(dir) || dir} already has a room.`);
      return;
    }
    // never allow an empty/duplicate name — it becomes the room's identity
    let name = path.basename(dir) || path.basename(path.dirname(dir)) || "room";
    const base = name;
    let n = 2;
    while (rooms.some((r) => r.name === name)) name = `${base}-${n++}`;
    rooms.push({ name, path: dir, floor, col });
    await this.saveRooms(rooms);
    await this.refreshState(); // surfaces the required main building right away
  }

  /** ✕ on the root building → nuke the whole directory: stop every agent in the
   *  island, optionally delete all its worktrees, and drop the reservation. The
   *  root checkout itself is never deleted from disk. */
  private async removeRoom(name: string): Promise<void> {
    const reserved = this.getRooms().find((r) => r.name === name);
    const agents = this.store.list().filter((a) => a.repo === name);
    const rootDir = reserved?.path;
    // worktrees we could delete from disk = any checkout that isn't the root
    const canDelete = agents.some((a) => a.worktree && a.worktree !== rootDir && resolveCwd(a) !== rootDir);
    const choices = canDelete ? ["Remove directory", "Remove + delete worktrees"] : ["Remove directory"];
    const pick = await vscode.window.showWarningMessage(
      `Remove the entire "${name}" directory${agents.length ? ` and its ${agents.length} room(s)` : ""}? ` +
        `Agents will stop.${canDelete ? " You can also delete the worktrees from disk." : ""}`,
      { modal: true },
      ...choices
    );
    if (!pick) return;

    for (const a of agents) {
      this.terminals.disposeAgent(a.id);
      this.store.remove(a.id);
    }
    if (pick === "Remove + delete worktrees") {
      const dir = reserved?.path ?? this.dirForRepo(name);
      if (dir) {
        for (const a of agents) {
          if (!a.worktree || a.worktree === dir) continue; // never the root checkout
          try {
            await worktreeRemove(dir, a.worktree, a.branch);
          } catch (e) {
            vscode.window.showWarningMessage(`DevTower: couldn't remove worktree ${path.basename(a.worktree)} — ${String(e).slice(0, 120)}`);
          }
        }
      }
    }
    if (reserved) await this.saveRooms(this.getRooms().filter((r) => r.name !== name));
    // forget every worktree room assigned to this island
    await this.saveWorktreeRooms(this.getWorktreeRooms().filter((w) => w.island !== name));
    this.postState();
    void this.refreshState();
  }

  /** ✕ on a worktree building → confirm → stop its agent(s); optionally delete
   *  the git worktree (and its branch) from disk too. */
  private async removeWorktree(worktree: string, island: string): Promise<void> {
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
    this.postState();
    void this.refreshState();
  }

  /** + DEV on a room → drop an agent straight into that room's worktree. No
   *  prompt — the room already fixes the directory. */
  private async addDev(island: string, worktree: string): Promise<void> {
    const key = `dev::${worktree}`;
    if (this.addingRooms.has(key)) return; // guard a double-click
    this.addingRooms.add(key);
    try {
      if (!worktree) {
        vscode.window.showWarningMessage(`DevTower: no directory for "${island}".`);
        return;
      }
      const n = this.store.list().filter((a) => a.repo === island).length + 1;
      const branch = await currentBranch(worktree);
      const id = `${island}-a${n}`;
      this.store.apply({
        id,
        name: `${island}-${n}`,
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
  private async addWorktree(island: string): Promise<void> {
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
          const wt = await worktreeAdd(dir, island, assigned.length + 2);
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
    // mark the launch so discovery only adopts the session we start here, not a
    // stale prior transcript already sitting in this worktree
    this.discovery?.expectSession(id);
    if (!launch && claudeCmd) this.terminals.send(id, claudeCmd);
    else this.terminals.reveal(id);
  }

  /** Recompute live git stats + branch per ROOM (keyed by the room's checkout
   *  path, which is exactly the building key the webview uses) and push if it
   *  changed. Git is resolved from the path even when it lives in a parent dir. */
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
        boards.set(roomKey, {
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
                comments: pr.comments,
              }
            : undefined,
        });
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
    // only push (and wake the render loop) when something actually changed, so
    // the idle poll doesn't defeat the webview's park-when-quiet power saving
    const sig = JSON.stringify([...boards].sort());
    if (sig !== this.lastWtSignature || vanishedWorktrees.length) {
      this.lastWtSignature = sig;
      this.postState(); // pruned rooms also need a re-sync so they stop rendering
    }
  }

  /** Spawn a reviewer agent for a PR, configured by the Review Dispatch card:
   *  drops a dev into the PR's repo, tags it with reviewOf (so the scene draws
   *  the diegetic review), then seeds its Claude session — checkout the PR, run
   *  each chosen skill as its own slash command, and append any free-text focus.
   *  With no skills selected it falls back to a generic full review. */
  private async assignReview(
    pr: { number?: number; repo?: string; branch?: string; url?: string; title?: string },
    opts: { skills?: string[]; effort?: string; instructions?: string; agent?: string; saveDefault?: boolean } = {}
  ): Promise<void> {
    if (typeof pr.number !== "number" || !pr.repo) return;
    const key = `review-${pr.number}-${pr.repo}`.replace(/[^A-Za-z0-9_-]+/g, "-");
    if (this.addingRooms.has(key)) return; // guard double-clicks
    this.addingRooms.add(key);
    try {
      const repoDir = this.dirForRepo(pr.repo);
      if (!repoDir) {
        vscode.window.showWarningMessage(`DevTower: no local directory known for "${pr.repo}".`);
        return;
      }

      const cfg = vscode.workspace.getConfiguration("devtower");
      const skills = (opts.skills ?? []).map((s) => s.trim()).filter(Boolean);
      const effort = (opts.effort ?? "").trim();
      const instructions = (opts.instructions ?? "").trim();
      const agentMd = (opts.agent ?? "").trim();

      // persist the operator's choices as the new default dispatch when asked
      if (opts.saveDefault) {
        await cfg.update(
          "reviewDefaults",
          { skills, effort: effort || undefined, instructions: instructions || undefined, agent: agentMd || undefined },
          vscode.ConfigurationTarget.Workspace
        );
      }

      // review the PR in its OWN worktree so the main checkout is never disturbed.
      // The worktree is added detached; `gh pr checkout` (below) brings the PR
      // branch (incl. forks) into it. Falls back to the repo dir if not a git repo.
      const island = this.getRooms().find((r) => r.name === pr.repo || r.name === pr.repo!.split("/").pop())?.name
        ?? pr.repo.split("/").pop() ?? pr.repo;
      let cwd = repoDir;
      let wtCreated = false;
      if (await isRepo(repoDir)) {
        try {
          const wt = await worktreeForPr(repoDir, pr.number);
          cwd = wt.wtPath;
          wtCreated = true;
          // register it as a worktree room so the reviewer gets its own building
          const rows = this.getWorktreeRooms().filter((w) => w.path !== wt.wtPath);
          rows.push({ island, path: wt.wtPath, branch: pr.branch || `pr/${pr.number}`, base: wt.base });
          await this.saveWorktreeRooms(rows);
        } catch (e) {
          vscode.window.showWarningMessage(`DevTower: couldn't create a review worktree — reviewing in the main checkout instead. ${String(e).slice(0, 120)}`);
        }
      }

      this.store.apply({
        id: key,
        name: `review #${pr.number}`,
        model: "—",
        repo: island,
        worktree: cwd,
        branch: pr.branch || `pr/${pr.number}`,
        state: "active",
        task: `Reviewing PR #${pr.number}: ${pr.title ?? ""}`.trim(),
        elapsed: "new",
        reviewOf: { prId: `${pr.repo}#${pr.number}`, number: pr.number, repo: pr.repo, url: pr.url },
      });
      this.store.setSelected(key);
      if (wtCreated) { this.postState(); void this.refreshState(); } // render the new room + board

      // effort flag only applies to the review skills that take one
      const EFFORT_SKILLS = new Set(["code-review", "review"]);
      const skillLine = (s: string): string => `/${s}${effort && EFFORT_SKILLS.has(s) ? ` ${effort}` : ""}`;

      const launch = cfg.get<string>("launchCommand", "").trim();
      const claudeCmd = cfg.get<string>("claudeCommand", "claude").trim() || "claude";
      // a chosen agent md becomes the reviewer's system prompt (non-launch path)
      const sysFlag = agentMd && !launch ? ` --append-system-prompt "$(cat ${shellQuote(agentMd)})"` : "";

      if (skills.length) {
        // interactive session: check out the PR branch into this worktree, then
        // fire each chosen skill as its own slash command against that diff.
        if (launch) this.terminals.reveal(key); // launchCommand runs on first open
        else this.terminals.send(key, `${claudeCmd}${sysFlag}`);
        if (wtCreated) this.terminals.send(key, `gh pr checkout ${pr.number}`);
        for (const s of skills) this.terminals.send(key, skillLine(s));
        if (instructions) this.terminals.send(key, instructions);
      } else {
        // no skills → generic one-shot review prompt (prior behavior)
        const extra = instructions ? ` Focus on: ${instructions}.` : "";
        const prompt =
          `Please review pull request #${pr.number} in ${pr.repo} (${pr.url}). ` +
          (wtCreated
            ? `Run \`gh pr checkout ${pr.number}\` to bring the change into this worktree, then review the diff `
            : `Use \`gh pr view ${pr.number}\` and \`gh pr diff ${pr.number}\` to read the change, then review it `) +
          `with concrete, actionable feedback.${extra}`;
        if (launch) {
          this.terminals.reveal(key);
          this.terminals.send(key, prompt);
        } else {
          this.terminals.send(key, `${claudeCmd}${sysFlag} ${shellQuote(prompt)}`);
        }
      }
    } finally {
      this.addingRooms.delete(key);
    }
  }

  /** Discover reviewer agent definitions: markdown files under `.claude/agents`
   *  in each workspace folder plus the user's global `~/.claude/agents`. Returns
   *  {label, path} — label is the file stem (or a `name:` frontmatter value). */
  private discoverReviewAgents(): { label: string; path: string }[] {
    const dirs: string[] = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) dirs.push(path.join(f.uri.fsPath, ".claude", "agents"));
    dirs.push(path.join(os.homedir(), ".claude", "agents"));
    const out: { label: string; path: string }[] = [];
    const seen = new Set<string>();
    for (const d of dirs) {
      let files: string[] = [];
      try { files = fs.readdirSync(d); } catch { continue; }
      for (const fn of files) {
        if (!fn.endsWith(".md")) continue;
        const p = path.join(d, fn);
        if (seen.has(p)) continue;
        seen.add(p);
        let label = fn.replace(/\.md$/, "");
        try {
          const head = fs.readFileSync(p, "utf8").slice(0, 600);
          const m = /^name:\s*(.+)$/m.exec(head);
          if (m) label = m[1].trim().replace(/^["']|["']$/g, "");
        } catch { /* keep the stem */ }
        out.push({ label, path: p });
      }
    }
    return out;
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
    if (resolveCwd(agent) === dir) return; // already there

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
      case "createPr":
        // runs in the agent's worktree terminal; --web hands off to the browser
        this.terminals.send(id, "gh pr create --web");
        break;
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
          vscode.commands.executeCommand("devtower.refreshChanges");
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
    vscode.commands.executeCommand("devtower.refreshChanges");
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
    this.panel.webview.postMessage({ type: "changes", id, files, real: !!(cwd && (await isRepo(cwd))) });
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
    const rooms = this.getRooms().map((r) => {
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
    this.panel.webview.postMessage({
      type: "state",
      agents,
      selectedId: this.store.getSelectedId(),
      rooms,
      boards: Object.fromEntries(this.boardsByPath),
    });
  }

  private postSession(id: string): void {
    const agent = this.store.get(id);
    if (!agent) return;
    this.panel.webview.postMessage({ type: "session", id, messages: getSession(agent) });
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
    this.usageTimer = setInterval(() => this.postUsage(), 60_000);
    try {
      this.usageWatcher = fs.watch(this.usageFile(), () => this.postUsage());
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
    this.panel.webview.postMessage({ type: "usage", usage });
  }

  private dispose(): void {
    ConsolePanel.current = undefined;
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    if (this.gitDebounce) clearTimeout(this.gitDebounce);
    for (const w of this.gitWatchers.values()) w.close();
    this.gitWatchers.clear();
    this.usageWatcher?.close();
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    const w = this.panel.webview;
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
    <div class="brand"><span class="spark">◆</span>DEVTOWER</div>
    <div class="telemetry">
      <span class="tstat"><i class="pip active"></i><b id="t-active">0</b><span class="lbl">run</span></span>
      <span class="tstat"><i class="pip waiting"></i><b id="t-waiting">0</b><span class="lbl">wait</span></span>
      <span class="tstat"><i class="pip error"></i><b id="t-error">0</b><span class="lbl">err</span></span>
      <span class="tstat"><b id="devtower-count">0</b><span class="lbl">crew</span></span>
    </div>
    <div class="usage" id="usage" hidden>
      <span class="umeter" id="u-5h" title="Plan usage — 5-hour window">
        <span class="ulbl">5H</span><span class="ubar"><i></i></span><b class="upct">–</b>
      </span>
      <span class="umeter" id="u-wk" title="Plan usage — weekly window">
        <span class="ulbl">WK</span><span class="ubar"><i></i></span><b class="upct">–</b>
      </span>
    </div>
    <div class="spacer"></div>
    <button class="iconbtn" id="prbtn" title="Pull requests">⇄<span class="nbadge" id="pr-badge" hidden>0</span></button>
    <button class="iconbtn" id="ecobtn" title="Efficiency mode (auto-on when on battery)">⚡</button>
  </header>

  <!-- review dispatch card (modal) -->
  <div class="rd-scrim" id="reviewdispatch" hidden></div>

  <!-- arrivals / departures feed -->
  <div class="feed" id="feed"></div>

  <!-- selected-agent panel: chat + changes -->
  <aside class="panel" id="panel" hidden></aside>

  <script nonce="${nonce}" src="${crew}"></script>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
