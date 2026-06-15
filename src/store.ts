import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { dlog } from "./debugLog";

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
  /** AI-generated session title (from `ai-title` transcript records). */
  aiTitle?: string;
  /** Skills (slash commands / Skill tool) this session has used, accumulated in
   *  order of first use. Drives the tower's bookshelf trips and the panel list. */
  skills?: string[];
  /** In-flight sub-agents (Task/Agent tool calls not yet returned) this session
   *  has spawned. Surfaced as a count badge beside the agent's name. */
  subagents?: number;
  /** This session's Task-tool checklist progress (read from
   *  `~/.claude/tasks/<session>/`), present only for a list of 2+ tasks. Drives
   *  the desk TV the dev deploys to track its tasks. */
  tasks?: { done: number; total: number };
  /** A live session discovered running OUTSIDE DevTower (e.g. an external
   *  terminal). DevTower must not open/resume a terminal for it — it's managed
   *  in its own session. */
  external?: boolean;
  /** The terminal's launch id (the `--session-id` its claude process started
   *  with), captured once and kept across /clear so the next clear's marker can
   *  rebind to exactly this dev regardless of how many sessions share its cwd. */
  launchId?: string;
  /** PID of the VS Code integrated terminal's shell that DevTower opened for this
   *  (owned) dev. The claude process runs as a child of this shell and the shell
   *  PID is STABLE across /clear (unlike the transcript uuid), so it is the most
   *  reliable agent↔session tie for a dev we launched. Absent for external/unseen
   *  terminals. Diagnostic for now (logged in the binding snapshot). */
  terminalPid?: number;
  /** Session id of the most recent /clear this dev went through. Rises each time
   *  the dev's session is replaced in place; the scene watches it for a change to
   *  send the dev on its context-shredder trip. */
  clearedSession?: string;
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
  aiTitle?: string;
  /** Skills seen in this poll's transcript window; unioned into the agent. */
  skills?: string[];
  /** In-flight sub-agent count from this poll's transcript window. */
  subagents?: number;
  /** Task-tool checklist progress read this poll (2+ tasks only). `null` means the
   *  poll authoritatively found no list (cleared, or dropped below 2) and the
   *  stale count must be cleared; `undefined` means this writer didn't report
   *  tasks, so the last-known value is kept. */
  tasks?: { done: number; total: number } | null;
  external?: boolean;
  /** The terminal's stable launch id, recorded when first observed. */
  launchId?: string;
  /** PID of the VS Code terminal shell DevTower opened for this dev (diagnostic). */
  terminalPid?: number;
  /** Session id of a /clear succession this poll rebound onto the agent. */
  clearedSession?: string;
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
  // change-coalescing for batch(): while depth > 0, fires are deferred and
  // collapsed into a single emit when the outermost batch closes.
  private batchDepth = 0;
  private batchDirty = false;
  private _onSelect = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeSelection = this._onSelect.event;
  private selectedId?: string;
  // A room/worktree explicitly clicked in the tower (may hold no agent). Drives
  // the Source Control mirror; takes precedence over the selected agent's cwd.
  private _onFocusWorktree = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeFocusWorktree = this._onFocusWorktree.event;
  private focusedWorktree?: string;
  // The directory mounted in the "Selected Directory" view via a room's USE DIR
  // button. UNLIKE focusedWorktree (which Source Control deliberately clears on
  // agent select), this is sticky: only USE DIR sets it and only removing that
  // room clears it, so clicking around agents never empties the file tree.
  private _onSelectedDir = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeSelectedDir = this._onSelectedDir.event;
  private selectedDir?: string;
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
    // selecting an agent supersedes any room-only focus
    this.focusedWorktree = undefined;
    this._onSelect.fire(id);
  }

  getFocusedWorktree(): string | undefined {
    return this.focusedWorktree;
  }

  /** Focus a worktree directory directly (e.g. clicking a room with no agent). */
  setFocusedWorktree(dir: string | undefined): void {
    this.focusedWorktree = dir;
    this._onFocusWorktree.fire(dir);
  }

  getSelectedDir(): string | undefined {
    return this.selectedDir;
  }

  /** Mount (or clear) the sticky directory shown by the Selected Directory view.
   *  Set only by USE DIR / its restore; cleared only when that room is removed. */
  setSelectedDir(dir: string | undefined): void {
    this.selectedDir = dir;
    this._onSelectedDir.fire(dir);
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  /** Run `fn` with all change emissions coalesced into ONE fire at the end.
   *  A single discovery refresh applies the new session AND removes the old one;
   *  without batching those land as two separate webview posts, so a /clear is
   *  seen as an old dev leaving + a new dev entering instead of one in-place
   *  swap — which is exactly what suppresses the shred trip. Batching makes the
   *  refresh reach the scene as a single atomic snapshot. Reentrancy-safe via a
   *  depth count; only the outermost batch emits. */
  async batch(fn: () => void | Promise<void>): Promise<void> {
    this.batchDepth++;
    try {
      await fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.batchDirty) {
        this.batchDirty = false;
        this._onChange.fire();
      }
    }
  }

  /** Fire a change, unless inside a batch() — then defer to the batch close. */
  private emit(): void {
    if (this.batchDepth > 0) {
      this.batchDirty = true;
      return;
    }
    this._onChange.fire();
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
      aiTitle: ev.aiTitle ?? existing?.aiTitle,
      // union, preserving first-seen order, so the full per-session set persists
      // even as individual Skill calls scroll out of the transcript tail
      skills: mergeSkills(existing?.skills, ev.skills),
      // a fresh poll reports the current in-flight count (0 when settled), so
      // honor it directly; fall back to last-known only when absent this poll
      subagents: ev.subagents ?? existing?.subagents,
      // a fresh transcript poll reports the live list each time. `null` is an
      // explicit "no list now" (cleared / dropped below 2) → clear the stale
      // count; `undefined` means this writer didn't report tasks → keep last-known
      // (e.g. a state.jsonl writer). Without the null case a cleared list left the
      // old count (e.g. 3/4) stuck on the desk TV forever.
      tasks: ev.tasks === null ? undefined : (ev.tasks ?? existing?.tasks),
      external: ev.external ?? existing?.external,
      launchId: ev.launchId ?? existing?.launchId,
      terminalPid: ev.terminalPid ?? existing?.terminalPid,
      clearedSession: ev.clearedSession ?? existing?.clearedSession,
      reviewOf: ev.reviewOf ?? existing?.reviewOf,
    };
    this.agents.set(ev.id, merged);
    // log only meaningful transitions, not every poll's no-op re-apply
    if (
      !existing ||
      existing.external !== merged.external ||
      !!existing.transcriptPath !== !!merged.transcriptPath ||
      existing.state !== merged.state ||
      existing.worktree !== merged.worktree
    ) {
      dlog(existing ? "store.update" : "store.create", {
        id: merged.id,
        name: merged.name,
        external: !!merged.external,
        hasTranscript: !!merged.transcriptPath,
        state: merged.state,
        worktree: merged.worktree,
      });
    }
    this.emit();
  }

  remove(id: string): void {
    if (this.agents.delete(id)) {
      dlog("store.remove", { id });
      this.emit();
    }
  }

  /** Manual state change from the UI (quick actions / send). */
  setState(id: string, state: AgentState, task?: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.state = state;
    if (task !== undefined) a.task = task;
    this.emit();
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
