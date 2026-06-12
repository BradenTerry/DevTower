import * as vscode from "vscode";
import { FleetStore, Agent, SessionMessage } from "./fleet";
import { TerminalManager } from "./terminals";
import { getSession } from "./session";
import { openGitFileDiff, openMockFileDiff } from "./diffProvider";
import * as path from "path";
import { isRepo, resolveCwd, status, stage, unstage, stageAll, unstageAll, changedFiles, worktreeAdd, currentBranch } from "./git";
import { PrService } from "./prs";

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
  private static readonly viewType = "fleet.console";
  private disposables: vscode.Disposable[] = [];

  static createOrShow(
    context: vscode.ExtensionContext,
    store: FleetStore,
    terminals: TerminalManager,
    prs: PrService
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
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "fleet.svg");
    ConsolePanel.current = new ConsolePanel(panel, context, store, terminals, prs);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly store: FleetStore,
    private readonly terminals: TerminalManager,
    private readonly prs: PrService
  ) {
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.store.onChange(() => this.postState(), null, this.disposables);
    this.store.onDidChangeSelection(() => this.postState(), null, this.disposables);
    this.prs.onChange(() => this.postPrs(), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async onMessage(m: any): Promise<void> {
    const id: string | undefined = m.id;
    switch (m.type) {
      case "ready":
        this.postState();
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
      case "addAgent":
        if (typeof m.room === "string") await this.addAgent(m.room);
        break;
      case "removeRoom":
        // note: must not truthiness-check — a legacy room can have name ""
        if (typeof m.room === "string") await this.removeRoom(m.room);
        break;
      case "refreshPrs":
        void this.prs.refresh();
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
      fleet: this.prs.getFleet(),
      review: this.prs.getReview(),
    });
  }

  /* ============ ROOMS (mining-game floors) ============ */

  /** Load reservations, healing legacy/corrupt entries (empty names, missing
   *  cols, dropped paths) so every room has a unique, non-empty key. */
  private getRooms(): ReservedRoom[] {
    const raw = this.context.workspaceState.get<ReservedRoom[]>("fleet.reservedRooms", []);
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
    await this.context.workspaceState.update("fleet.reservedRooms", rooms);
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
    this.postState();
  }

  /** ✕ on a reserved room → confirm → drop the reservation (files untouched). */
  private async removeRoom(name: string): Promise<void> {
    const rooms = this.getRooms();
    if (!rooms.some((r) => r.name === name)) return;
    const pick = await vscode.window.showWarningMessage(
      `Remove room "${name}" from the tower? The directory and any running agents are untouched.`,
      { modal: true },
      "Remove room"
    );
    if (pick !== "Remove room") return;
    await this.saveRooms(rooms.filter((r) => r.name !== name));
    this.postState();
  }

  /** "+ dev" button on a room → choose worktree vs base dir → spawn an agent. */
  private async addAgent(roomName: string): Promise<void> {
    // resolve the room's directory: reserved room first, else any agent in that repo
    const reserved = this.getRooms().find((r) => r.name === roomName);
    let dir = reserved?.path;
    if (!dir) {
      const peer = this.store.list().find((a) => a.repo === roomName);
      dir = peer ? resolveCwd(peer) : undefined;
    }
    if (!dir) {
      vscode.window.showWarningMessage(`Fleet: no directory known for room "${roomName}".`);
      return;
    }

    const repoReady = await isRepo(dir);
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(git-branch) Create a worktree",
          description: repoReady ? "new branch + isolated working copy" : "unavailable — not a git repository",
          id: "wt",
        },
        { label: "$(folder) Use the project directory", description: dir, id: "base" },
      ],
      { title: `Add agent to ${roomName}` }
    );
    if (!pick) return;

    const n = this.store.list().filter((a) => a.repo === roomName).length + 1;
    let worktree = dir;
    let branch = await currentBranch(dir);
    if (pick.id === "wt") {
      if (!repoReady) {
        vscode.window.showWarningMessage("Fleet: not a git repository — using the project directory instead.");
      } else {
        try {
          const wt = await worktreeAdd(dir, roomName, n);
          worktree = wt.wtPath;
          branch = wt.branch;
        } catch (e) {
          vscode.window.showErrorMessage(`Fleet: worktree creation failed (${String(e).slice(0, 120)}) — using the project directory.`);
        }
      }
    }

    const id = `${roomName}-a${n}`;
    this.store.apply({
      id,
      name: `${roomName}-${n}`,
      model: "—",
      repo: roomName,
      worktree,
      branch,
      state: "idle",
      task: "Ready — dispatch a task from the panel",
      elapsed: "new",
    });
    this.store.setSelected(id);

    // start a real Claude CLI session in the agent's terminal (worktree cwd);
    // fleet.launchCommand takes precedence if the user configured one
    const cfg = vscode.workspace.getConfiguration("fleet");
    const launch = cfg.get<string>("launchCommand", "").trim();
    const claudeCmd = cfg.get<string>("claudeCommand", "claude").trim();
    if (!launch && claudeCmd) this.terminals.send(id, claudeCmd);
    else this.terminals.reveal(id);
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
          vscode.commands.executeCommand("fleet.refreshChanges");
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
    vscode.commands.executeCommand("fleet.refreshChanges");
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
    this.panel.webview.postMessage({
      type: "state",
      agents: this.store.list(),
      selectedId: this.store.getSelectedId(),
      rooms: this.getRooms(),
    });
  }

  private postSession(id: string): void {
    const agent = this.store.get(id);
    if (!agent) return;
    this.panel.webview.postMessage({ type: "session", id, messages: getSession(agent) });
  }

  private dispose(): void {
    ConsolePanel.current = undefined;
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
      <span class="tstat"><b id="fleet-count">0</b><span class="lbl">crew</span></span>
    </div>
    <div class="spacer"></div>
    <button class="iconbtn" id="prbtn" title="Pull requests">⇄<span class="nbadge" id="pr-badge" hidden>0</span></button>
    <button class="iconbtn" id="ecobtn" title="Efficiency mode (auto-on when on battery)">⚡</button>
    <button class="iconbtn" id="themebtn" title="Toggle theme">☾</button>
  </header>

  <!-- PR board (left) -->
  <aside class="prboard" id="prboard" hidden></aside>

  <!-- arrivals / departures feed -->
  <div class="feed" id="feed"></div>

  <div class="hint" id="hint">Click a dev to select · click a floor to zoom · empty floors reserve a directory · + DEV adds an agent</div>

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
