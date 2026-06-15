import * as vscode from "vscode";

/** What the mini view needs from its owner (the ConsolePanel): the latest data
 *  to render and the actions it can trigger. Keeping this a thin delegate means
 *  the mini view never polls git/PRs itself — it is a second view of the data the
 *  console already computes. */
export interface MiniDelegate {
  /** The most recent `state` payload the console posted (agents, rooms, boards,
   *  selectedId, usedDir), or undefined before the first compute. */
  currentState(): unknown | undefined;
  /** The most recent `prs` payload (crew, review, connected, loading). */
  currentPrs(): unknown | undefined;
  /** "View" an agent: select it (the tower reveals/zooms its terminal), same as a
   *  tower click. */
  selectAgent(id: string): void;
  /** "Chat" with an agent: reveal just its terminal, WITHOUT selecting/zooming —
   *  so the mini view works standalone without moving the tower's camera. */
  chatAgent(id: string): void;
  /** Send an agent home (the tower's "send home"): confirm, stop it, retire it. */
  removeAgent(id: string): void;
  /** Mount a worktree checkout in the Selected Directory view (the "USE DIR"
   *  action), keyed by the room/worktree path. */
  useDir(room: string): void;
  /** Open a pull request in the browser. */
  openPr(url: string): void;
  /** Spawn a new dev into a worktree (the tower's "+ DEV"), keyed by the owning
   *  island/project name and the worktree checkout path. */
  spawnDev(island: string, worktree: string): void;
  /** Create or assign a worktree for a project (the tower's "+ WORKTREE"), keyed
   *  by the owning island/project name. No agent is spawned. */
  addWorktree(island: string): void;
  /** Add a new project: pick a directory and reserve it as an island (the tower's
   *  empty-slot reserve, but auto-placed since the mini view has no grid). */
  addProjectFromMini(): void;
  /** Remove a worktree room (the tower's worktree ✕): confirm, stop its agents,
   *  optionally delete the worktree + branch from disk. */
  removeWorktree(worktree: string, island: string): void;
  /** Remove a project/island (the tower's root ✕): confirm, stop every agent,
   *  optionally delete all worktrees, drop the reservation. */
  removeProject(name: string): void;
  /** The mini view's visibility changed — let the host re-evaluate whether the
   *  background pollers should be running. */
  onVisibilityChange(): void;
}

/** A compact, DOM-table popout of the tower: projects → worktrees → agents, plus
 *  a nested PR view. Hosted as its own editor WebviewPanel beside the tower and
 *  fed by the ConsolePanel, which owns it. */
export class MiniPanel {
  public static current: MiniPanel | undefined;
  private static readonly viewType = "devtower.mini";
  private disposables: vscode.Disposable[] = [];
  private ready = false;

  static createOrShow(context: vscode.ExtensionContext, delegate: MiniDelegate): MiniPanel {
    if (MiniPanel.current) {
      MiniPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      MiniPanel.current.push();
      return MiniPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      MiniPanel.viewType,
      "DevTower — Mini",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "devtower.svg");
    MiniPanel.current = new MiniPanel(panel, context, delegate);
    return MiniPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly delegate: MiniDelegate
  ) {
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(() => this.delegate.onVisibilityChange(), null, this.disposables);
  }

  /** True while this panel is on screen (own window or visible tab). */
  get visible(): boolean {
    return this.panel.visible;
  }

  /** Push a fresh `state` payload to the mini webview. No-op until it reports
   *  ready (a message posted before then is dropped by VS Code). */
  postState(payload: unknown): void {
    this.post(payload);
  }

  /** Push a fresh `prs` payload to the mini webview. */
  postPrs(payload: unknown): void {
    this.post(payload);
  }

  /** Post to the webview, tolerating a disposed panel (a race during close). */
  private post(payload: unknown): void {
    if (!this.ready || !payload) return;
    try {
      this.panel.webview.postMessage({ ...(payload as object) });
    } catch {
      /* panel disposed mid-flight — the next open replays state */
    }
  }

  /** Re-send whatever the host has right now (used on reveal / first ready). */
  private push(): void {
    this.postState(this.delegate.currentState());
    this.postPrs(this.delegate.currentPrs());
  }

  private onMessage(m: any): void {
    switch (m?.type) {
      case "ready":
        this.ready = true;
        this.push();
        break;
      case "select":
        if (typeof m.id === "string") this.delegate.selectAgent(m.id);
        break;
      case "chat":
        if (typeof m.id === "string") this.delegate.chatAgent(m.id);
        break;
      case "removeAgent":
        if (typeof m.id === "string") this.delegate.removeAgent(m.id);
        break;
      case "useDir":
        if (typeof m.room === "string") this.delegate.useDir(m.room);
        break;
      case "openPr":
        if (typeof m.url === "string") this.delegate.openPr(m.url);
        break;
      case "addDev":
        if (typeof m.island === "string" && typeof m.worktree === "string") this.delegate.spawnDev(m.island, m.worktree);
        break;
      case "addWorktree":
        if (typeof m.island === "string") this.delegate.addWorktree(m.island);
        break;
      case "addProject":
        this.delegate.addProjectFromMini();
        break;
      case "removeWorktree":
        if (typeof m.worktree === "string") this.delegate.removeWorktree(m.worktree, typeof m.island === "string" ? m.island : "");
        break;
      case "removeProject":
        if (typeof m.name === "string") this.delegate.removeProject(m.name);
        break;
    }
  }

  /** Close the panel (e.g. when the owning console is disposed). */
  close(): void {
    this.panel.dispose();
  }

  private dispose(): void {
    MiniPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.delegate.onVisibilityChange();
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = makeNonce();
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "mini.css"));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "mini.js"));
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
<title>DevTower — Mini</title>
</head>
<body data-theme="dark">
  <header class="mini-top">
    <nav class="tabs" id="tabs">
      <button class="tab" data-tab="projects">Projects</button>
      <button class="tab" data-tab="agents">All agents</button>
      <button class="tab" data-tab="prs">All PRs</button>
    </nav>
    <div class="spacer"></div>
    <div class="telemetry" id="telemetry">
      <span class="tstat"><i class="pip active"></i><b id="t-active">0</b><span class="lbl">run</span></span>
      <span class="tstat"><i class="pip waiting"></i><b id="t-waiting">0</b><span class="lbl">wait</span></span>
      <span class="tstat"><i class="pip error"></i><b id="t-error">0</b><span class="lbl">err</span></span>
      <span class="tstat"><b id="t-crew">0</b><span class="lbl">crew</span></span>
    </div>
  </header>
  <div class="subbar">
    <nav class="crumbs" id="crumbs"></nav>
    <div class="spacer"></div>
    <div class="seldir" id="seldir"></div>
  </div>
  <main class="mini-body" id="view"></main>
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
