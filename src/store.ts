import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export type AgentState = "active" | "waiting" | "complete" | "error" | "idle";

export interface DiffLine {
  kind: "ctx" | "add" | "del" | "meta";
  text: string;
}

export interface ChangedFile {
  path: string;
  add: number;
  del: number;
  lines: DiffLine[];
}

export type MessageKind = "user" | "assistant" | "tool" | "result" | "system";

export interface SessionMessage {
  kind: MessageKind;
  text: string;
  tool?: string;
}

export interface Agent {
  id: string;
  name: string;
  model: string;
  repo: string;
  worktree: string;
  branch: string;
  state: AgentState;
  task: string;
  elapsed: string;
  add: number;
  del: number;
  question?: string;
  files: ChangedFile[];
  /** Conversation/session log shown in the console (mock or seeded). */
  session?: SessionMessage[];
  /** Path to a Claude Code transcript JSONL; if set, read live instead. */
  transcriptPath?: string;
  /** Tokens currently in the session's context window. */
  contextTokens?: number;
  /** Skills (slash commands / Skill tool) this session has used, accumulated in
   *  order of first use. Drives the tower's bookshelf trips and the panel list. */
  skills?: string[];
  /** A live session discovered running OUTSIDE DevTower (e.g. an external
   *  terminal). DevTower must not open/resume a terminal for it — it's managed
   *  in its own session. */
  external?: boolean;
  /** Set when this agent was dispatched to review a PR. Links the agent to the
   *  PR so the scene can render the diegetic review (desk + verdict stamp) and
   *  the verdict can be derived from the polled PR decision. */
  reviewOf?: ReviewTarget;
}

/** The PR an agent was dispatched to review. */
export interface ReviewTarget {
  prId: string;
  number: number;
  repo: string;
  url?: string;
}

/** A single event line in the generic state.jsonl feed. */
export interface StateEvent {
  id: string;
  state?: AgentState;
  task?: string;
  repo?: string;
  worktree?: string;
  branch?: string;
  name?: string;
  model?: string;
  elapsed?: string;
  transcriptPath?: string;
  /** the actual question the agent asked, when one exists */
  question?: string;
  contextTokens?: number;
  /** Skills seen in this poll's transcript window; unioned into the agent. */
  skills?: string[];
  external?: boolean;
  reviewOf?: ReviewTarget;
}

export const STATE_LABEL: Record<AgentState, string> = {
  active: "Active",
  waiting: "Awaiting input",
  complete: "Complete",
  error: "Error",
  idle: "Idle",
};

/** Union two skill lists, keeping first-seen order and dropping duplicates.
 *  Returns undefined when neither side has any, so the field stays absent. */
function mergeSkills(prev?: string[], next?: string[]): string[] | undefined {
  if (!prev?.length && !next?.length) return prev ?? next;
  const out = [...(prev ?? [])];
  for (const s of next ?? []) if (s && !out.includes(s)) out.push(s);
  return out;
}

/**
 * Owns the tower of agents. Source of truth for the extension.
 * Agents arrive from two places:
 *   1. mock seed data (for trying the UI), and
 *   2. an append-only state.jsonl file any agent runner can write to.
 */
export class DevTowerStore {
  private agents = new Map<string, Agent>();
  private _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;
  private _onSelect = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeSelection = this._onSelect.event;
  private selectedId?: string;
  private watcher?: vscode.FileSystemWatcher;
  private stateFileAbs?: string;

  constructor(private context: vscode.ExtensionContext) {}

  getSelected(): Agent | undefined {
    return this.selectedId ? this.agents.get(this.selectedId) : undefined;
  }

  getSelectedId(): string | undefined {
    return this.selectedId;
  }

  setSelected(id: string | undefined): void {
    this.selectedId = id;
    this._onSelect.fire(id);
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  repos(): string[] {
    return [...new Set(this.list().map((a) => a.repo))];
  }

  /** Apply a partial state event, creating the agent if needed. */
  apply(ev: StateEvent): void {
    if (!ev.id) return;
    const existing = this.agents.get(ev.id);
    const merged: Agent = {
      id: ev.id,
      name: ev.name ?? existing?.name ?? ev.id,
      model: ev.model ?? existing?.model ?? "unknown",
      repo: ev.repo ?? existing?.repo ?? "workspace",
      // no fallback to "." — a worktree-less agent has no checkout to attach to,
      // so it stays unplaced (layout/seatPlan skip empty worktrees) instead of
      // silently collapsing into the workspace-root "main" room
      worktree: ev.worktree ?? existing?.worktree ?? "",
      branch: ev.branch ?? existing?.branch ?? "HEAD",
      state: ev.state ?? existing?.state ?? "idle",
      task: ev.task ?? existing?.task ?? "",
      elapsed: ev.elapsed ?? existing?.elapsed ?? "",
      add: existing?.add ?? 0,
      del: existing?.del ?? 0,
      question: ev.question ?? (ev.state === undefined ? existing?.question : ev.state === "waiting" ? existing?.question : undefined),
      files: existing?.files ?? [],
      session: existing?.session,
      transcriptPath: ev.transcriptPath ?? existing?.transcriptPath,
      contextTokens: ev.contextTokens ?? existing?.contextTokens,
      // union, preserving first-seen order, so the full per-session set persists
      // even as individual Skill calls scroll out of the transcript tail
      skills: mergeSkills(existing?.skills, ev.skills),
      external: ev.external ?? existing?.external,
      reviewOf: ev.reviewOf ?? existing?.reviewOf,
    };
    this.agents.set(ev.id, merged);
    this._onChange.fire();
  }

  remove(id: string): void {
    if (this.agents.delete(id)) this._onChange.fire();
  }

  /** Manual state change from the UI (quick actions / send). */
  setState(id: string, state: AgentState, task?: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.state = state;
    if (task !== undefined) a.task = task;
    this._onChange.fire();
  }

  seedMock(): void {
    for (const a of MOCK_AGENTS) this.agents.set(a.id, structuredClone(a));
    this._onChange.fire();
  }

  /** Begin watching the configured state.jsonl for live events. */
  watchStateFile(): void {
    const cfg = vscode.workspace.getConfiguration("devtower");
    const rel = cfg.get<string>("stateFile", ".devtower/state.jsonl");
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.stateFileAbs = path.isAbsolute(rel) ? rel : root ? path.join(root, rel) : undefined;
    if (!this.stateFileAbs) return;

    this.ingestFile();
    const pattern = new vscode.RelativePattern(
      path.dirname(this.stateFileAbs),
      path.basename(this.stateFileAbs)
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const reload = () => this.ingestFile();
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.context.subscriptions.push(this.watcher);
  }

  private ingestFile(): void {
    if (!this.stateFileAbs || !fs.existsSync(this.stateFileAbs)) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.stateFileAbs, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        this.apply(JSON.parse(t) as StateEvent);
      } catch {
        /* skip malformed line */
      }
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onChange.dispose();
    this._onSelect.dispose();
  }
}

/** Reconstruct old/new file text from a diff for the native diff editor. */
export function reconstruct(file: ChangedFile): { left: string; right: string } {
  const left: string[] = [];
  const right: string[] = [];
  for (const l of file.lines) {
    if (l.kind === "meta") continue;
    if (l.kind === "ctx") {
      left.push(l.text);
      right.push(l.text);
    } else if (l.kind === "del") {
      left.push(l.text);
    } else if (l.kind === "add") {
      right.push(l.text);
    }
  }
  return { left: left.join("\n") + "\n", right: right.join("\n") + "\n" };
}

/* ============ MOCK SEED ============ */
export const MOCK_AGENTS: Agent[] = [
  {
    id: "a1",
    name: "streamer",
    model: "opus-4.8",
    repo: "atlas-api",
    worktree: "../wt/feat-sse",
    branch: "feat/streaming-sse",
    state: "active",
    task: "Wiring SSE transport into /v1/messages",
    elapsed: "8m12s",
    add: 214,
    del: 37,
    files: [
      {
        path: "src/routes/messages.ts",
        add: 64,
        del: 12,
        lines: [
          { kind: "meta", text: "@@ -41,7 +41,9 @@ export async function handler(req, res)" },
          { kind: "ctx", text: '  const stream = req.query.stream === "true"' },
          { kind: "del", text: "  res.json(await complete(req.body))" },
          { kind: "add", text: "  if (stream) {" },
          { kind: "add", text: '    res.setHeader("Content-Type", "text/event-stream")' },
          { kind: "add", text: '    res.setHeader("Cache-Control", "no-cache")' },
          { kind: "add", text: "    for await (const ev of completeStream(req.body)) {" },
          { kind: "add", text: "      res.write(`data: ${JSON.stringify(ev)}\\n\\n`)" },
          { kind: "add", text: "    }" },
          { kind: "add", text: "    return res.end()" },
          { kind: "add", text: "  }" },
          { kind: "add", text: "  res.json(await complete(req.body))" },
        ],
      },
    ],
    session: [
      { kind: "user", text: "Add SSE streaming support to the /v1/messages route, gated behind ?stream=true." },
      { kind: "assistant", text: "I'll branch the handler on the stream flag and write an event-stream response, then add a heartbeat so the gateway doesn't time the connection out." },
      { kind: "tool", tool: "Read", text: "src/routes/messages.ts (218 lines)" },
      { kind: "tool", tool: "Edit", text: "src/routes/messages.ts  +11 -1" },
      { kind: "tool", tool: "Write", text: "src/lib/sse.ts  +9" },
      { kind: "tool", tool: "Bash", text: "npm test -- messages  →  PASS (4 passed)" },
      { kind: "assistant", text: "Tests pass. Checking the heartbeat interval against the 30s gateway timeout before I call this done." },
    ],
  },
  {
    id: "a2",
    name: "refresher",
    model: "sonnet-4.6",
    repo: "atlas-api",
    worktree: "../wt/fix-auth",
    branch: "fix/auth-refresh-race",
    state: "waiting",
    task: "Needs a decision on token rotation strategy",
    elapsed: "2m40s",
    add: 31,
    del: 18,
    question:
      "Rotate refresh tokens on every use, or only near expiry? Rotation-on-use is safer but invalidates concurrent tabs.",
    files: [
      {
        path: "src/auth/refresh.ts",
        add: 31,
        del: 18,
        lines: [
          { kind: "meta", text: "@@ -22,10 +22,14 @@ async function refresh(token)" },
          { kind: "del", text: "  const next = await mint(user)" },
          { kind: "del", text: "  return next" },
          { kind: "add", text: "  const reuse = await detectReuse(token)" },
          { kind: "add", text: "  if (reuse) { await revokeFamily(token); throw new ReuseError() }" },
          { kind: "add", text: "  const next = await mint(user, { rotate: true })" },
          { kind: "add", text: "  await store.link(token, next)" },
          { kind: "add", text: "  return next" },
        ],
      },
    ],
    session: [
      { kind: "user", text: "There's a race in refresh-token rotation when two tabs refresh at once. Fix it." },
      { kind: "assistant", text: "Found two concurrent-refresh paths. I'll add reuse detection that revokes the token family on replay, and rotate on every use." },
      { kind: "tool", tool: "Edit", text: "src/auth/refresh.ts  +8 -2" },
      { kind: "result", text: "Decision required: rotate on every use (safer, invalidates concurrent tabs) vs only near expiry?" },
    ],
  },
  {
    id: "a3",
    name: "cockpit-ui",
    model: "opus-4.8",
    repo: "atlas-web",
    worktree: "../wt/feat-cockpit",
    branch: "feat/agent-cockpit",
    state: "complete",
    task: "Built agent tree + diff panel",
    elapsed: "done · 19m",
    add: 512,
    del: 88,
    files: [
      {
        path: "src/views/Tree.tsx",
        add: 180,
        del: 20,
        lines: [
          { kind: "meta", text: "@@ -1,4 +1,8 @@" },
          { kind: "add", text: "export function Tree({ agents }: { agents: Agent[] }) {" },
          { kind: "add", text: "  const byRepo = groupBy(agents, a => a.repo)" },
          { kind: "add", text: "  return <nav>{Object.entries(byRepo).map(renderRepo)}</nav>" },
          { kind: "add", text: "}" },
        ],
      },
    ],
  },
  {
    id: "a4",
    name: "webgl-spike",
    model: "sonnet-4.6",
    repo: "atlas-web",
    worktree: "../wt/spike-webgl",
    branch: "spike/webgl-carousel",
    state: "error",
    task: "Build failed — missing texture binding",
    elapsed: "fail · 4m",
    add: 96,
    del: 4,
    files: [
      {
        path: "src/gl/carousel.ts",
        add: 96,
        del: 4,
        lines: [
          { kind: "meta", text: "@@ -55,3 +55,4 @@" },
          { kind: "add", text: "gl.bindTexture(gl.TEXTURE_2D, tex)  // tex undefined" },
        ],
      },
    ],
  },
  {
    id: "a5",
    name: "deps-bot",
    model: "haiku-4.5",
    repo: "infra",
    worktree: "../wt/chore-deps",
    branch: "chore/bump-deps",
    state: "idle",
    task: "Queued — bump 6 minor versions",
    elapsed: "queued",
    add: 0,
    del: 0,
    files: [],
  },
];
