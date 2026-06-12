import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";
import { DevTowerStore, AgentState } from "./store";
import { currentBranch, isRepo } from "./git";

function execP(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

/**
 * Discovers live Claude Code CLI sessions on this machine.
 *
 * Claude Code writes one transcript per session under
 *   ~/.claude/projects/<encoded-project>/<session-uuid>.jsonl
 * Each record carries `cwd`, so the project directory is read from the file
 * itself rather than decoded from the folder name. State is inferred from
 * recency + who spoke last:
 *   modified < 2 min ago            → active
 *   last turn was the assistant     → waiting (your move)
 *   otherwise                       → idle
 * Discovered agents get `transcriptPath`, so the chat panel renders the real
 * conversation via session.ts.
 */
export class ClaudeDiscovery {
  private timer?: ReturnType<typeof setInterval>;
  private mine = new Set<string>(); // agent ids this service created
  private branchCache = new Map<string, string>();
  // agent id → directory it was just told to /cd into (+ when), held until the
  // transcript reports the new cwd so the toon doesn't snap back meanwhile. The
  // timestamp bounds the hold: a /cd that fails or is declined never reports the
  // new cwd, so we give up after CD_HOLD_MS and revert to the real location.
  private cdPending = new Map<string, { dir: string; at: number }>();
  private static readonly CD_HOLD_MS = 120_000;

  constructor(private store: DevTowerStore) {}

  /** Record that an agent was sent `/cd <dir>`; relocate it optimistically and
   *  re-scan so the move shows immediately rather than on the next poll. */
  expectCd(agentId: string, dir: string): void {
    this.cdPending.set(agentId, { dir, at: Date.now() });
    void this.refresh();
  }

  start(intervalMs = 8_000): void {
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * How many claude processes are actually running in each working directory
   * right now. A transcript on disk is NOT a running session — without this
   * check, every session touched in the last day shows up as a phantom agent.
   *
   * We count per cwd rather than returning a plain live/not set because a
   * single cwd can host several concurrent sessions (and the CLI exposes no
   * session id via argv/env, nor does it keep the transcript file open, so the
   * cwd is the only handle the OS gives us). The caller keeps the N newest
   * transcripts per cwd, so closing one of several sessions there drops exactly
   * one toon on the next poll instead of leaving a phantom behind.
   *
   * Returns null when the check isn't possible (Windows / tools missing).
   */
  private async liveCwdCounts(): Promise<Map<string, number> | null> {
    if (process.platform === "win32") return null;
    try {
      const ps = await execP("ps", ["-axo", "pid=,comm="]);
      const pids: string[] = [];
      for (const line of ps.split("\n")) {
        const t = line.trim();
        const sp = t.indexOf(" ");
        if (sp < 0) continue;
        const comm = t.slice(sp + 1).trim();
        if (comm === "claude" || comm.endsWith("/claude")) pids.push(t.slice(0, sp));
      }
      if (!pids.length) return new Map();
      // -a -d cwd → exactly one cwd record per pid; counting them per path
      // yields the number of live claude processes rooted at that directory.
      const out = await execP("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"]);
      const counts = new Map<string, number>();
      for (const line of out.split("\n")) {
        if (!line.startsWith("n")) continue;
        const cwd = line.slice(1).trim();
        counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
      }
      return counts;
    } catch {
      return null;
    }
  }

  /** Scan + sync into the store. Returns how many sessions were found. */
  async refresh(): Promise<number> {
    const root = path.join(os.homedir(), ".claude", "projects");
    const showRecent = vscode.workspace
      .getConfiguration("devtower")
      .get<boolean>("showRecentSessions", false);
    let found: Found[];
    try {
      found = await this.scan(root);
    } catch {
      return 0;
    }

    // keep one transcript per live claude process (newest first per cwd);
    // optionally also show recent-but-closed ones as idle "resumable" rooms.
    // NB: key liveness by launchCwd (the dir claude started in, which is what
    // `lsof` reports), NOT the latest cwd — a session that cd'd into a subdir
    // still belongs to the process counted under its launch directory.
    const liveCounts = await this.liveCwdCounts();
    const usedPerCwd = new Map<string, number>();
    const kept: Found[] = [];
    for (const f of found) {
      // found is sorted newest-first, so a cwd's slots fill with its freshest
      // sessions; the rest are treated as closed.
      const used = usedPerCwd.get(f.launchCwd) ?? 0;
      let isLive: boolean;
      if (liveCounts === null) {
        // no process info → treat only a single very-fresh session as live
        isLive = used === 0 && Date.now() - f.mtime < 15 * 60_000;
      } else {
        isLive = used < (liveCounts.get(f.launchCwd) ?? 0);
      }
      if (isLive) {
        usedPerCwd.set(f.launchCwd, used + 1);
        kept.push(f);
      } else if (showRecent && used === 0) {
        usedPerCwd.set(f.launchCwd, 1);
        kept.push({ ...f, state: "idle", task: `(recent) ${f.task}` });
      }
    }
    found = kept;

    const present = new Set<string>();
    for (const f of found) {
      present.add(f.id);
      this.mine.add(f.id);
      // honor a pending /cd until the transcript reports the new directory,
      // or until the hold expires (a failed/declined /cd never lands)
      let cwd = f.cwd;
      const pend = this.cdPending.get(f.id);
      if (pend) {
        if (cwd === pend.dir || Date.now() - pend.at > ClaudeDiscovery.CD_HOLD_MS) {
          this.cdPending.delete(f.id);
        } else {
          cwd = pend.dir;
        }
      }
      let branch = this.branchCache.get(cwd);
      if (branch === undefined) {
        branch = (await isRepo(cwd)) ? await currentBranch(cwd) : "";
        this.branchCache.set(cwd, branch);
      }
      this.store.apply({
        id: f.id,
        name: `${path.basename(cwd)}·${f.id.slice(3, 7)}`,
        model: f.model,
        repo: path.basename(cwd),
        worktree: cwd,
        branch: branch || "—",
        state: f.state,
        task: f.task,
        elapsed: ago(f.mtime),
        transcriptPath: f.file,
        question: f.question,
        contextTokens: f.contextTokens,
      });
    }
    // drop pending /cd for agents that are no longer present
    for (const id of [...this.cdPending.keys()]) if (!present.has(id)) this.cdPending.delete(id);
    // sessions that aged out or were deleted leave the tower
    for (const id of [...this.mine]) {
      if (!present.has(id)) {
        this.mine.delete(id);
        this.store.remove(id);
      }
    }
    return found.length;
  }

  private async scan(root: string): Promise<Found[]> {
    const cfg = vscode.workspace.getConfiguration("devtower");
    const maxAge = cfg.get<number>("sessionMaxAgeHours", 24) * 3_600_000;
    const now = Date.now();
    const out: Found[] = [];

    const projDirs = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    for (const d of projDirs) {
      if (!d.isDirectory()) continue;
      const pdir = path.join(root, d.name);
      const files = await fs.promises.readdir(pdir).catch(() => [] as string[]);
      for (const fn of files) {
        if (!fn.endsWith(".jsonl")) continue;
        const file = path.join(pdir, fn);
        const st = await fs.promises.stat(file).catch(() => null);
        if (!st || now - st.mtimeMs > maxAge || st.size === 0) continue;
        const meta = await readMeta(file, st.size);
        if (!meta.cwd) continue;
        const age = now - st.mtimeMs;
        // waiting ONLY when the assistant actually asked something; a turn
        // that ends in a statement is just done → idle (off the clock)
        const state: AgentState =
          age < 120_000 ? "active" : meta.lastRole === "assistant" && meta.question ? "waiting" : "idle";
        out.push({
          id: "cc-" + fn.slice(0, 8),
          file,
          cwd: meta.cwd,
          launchCwd: meta.launchCwd ?? meta.cwd,
          mtime: st.mtimeMs,
          state,
          task: meta.task || "Claude session",
          model: meta.model || "claude",
          question: state === "waiting" ? meta.question : undefined,
          contextTokens: meta.contextTokens,
        });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, 12); // newest sessions; keep the tower readable
  }
}

interface Found {
  id: string;
  file: string;
  cwd: string; // latest cwd (transcript tail) — used for the room/label
  launchCwd: string; // dir claude started in (transcript head) — used for liveness
  mtime: number;
  state: AgentState;
  task: string;
  model: string;
  question?: string;
  contextTokens?: number;
}

/** Read head (for cwd) + tail (for last role / prompt / model) of a transcript. */
async function readMeta(
  file: string,
  size: number
): Promise<{ cwd?: string; launchCwd?: string; lastRole?: string; task?: string; model?: string; question?: string; contextTokens?: number }> {
  const CHUNK = 32 * 1024;
  const fh = await fs.promises.open(file, "r").catch(() => null);
  if (!fh) return {};
  try {
    const headBuf = Buffer.alloc(Math.min(CHUNK, size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString("utf8");
    const headCwd = /"cwd"\s*:\s*"([^"]+)"/.exec(head)?.[1];

    let tail = head;
    if (size > CHUNK) {
      const tailBuf = Buffer.alloc(CHUNK);
      await fh.read(tailBuf, 0, CHUNK, size - CHUNK);
      tail = tailBuf.toString("utf8");
    }
    // prefer the most recent cwd record so /cd mid-session relocates the agent
    const cwd = lastMatch(tail, /"cwd"\s*:\s*"([^"]+)"/g) ?? headCwd;
    const model = lastMatch(tail, /"model"\s*:\s*"([^"]+)"/g);

    // context usage = the prompt window of the latest MAIN-THREAD assistant turn.
    // Mirrors Claude Code's own `/context`: input + the two cache buckets (all
    // tokens occupying the window), NOT output. We read it from the parsed
    // records below so sub-agent (sidechain) turns — which carry their own,
    // smaller usage — never masquerade as the session's real context.
    let contextTokens: number | undefined;

    let lastRole: string | undefined;
    let task: string | undefined;
    let lastAssistantText: string | undefined;
    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t || !t.startsWith("{")) continue;
      try {
        const rec = JSON.parse(t);
        const role = rec.type ?? rec.message?.role;
        if (role === "user" || role === "assistant") {
          if (!lastRole) lastRole = role;
          // first (= newest, scanning backwards) real assistant turn wins;
          // skip sidechain sub-agent turns and the streaming partial at the tail
          if (contextTokens === undefined && role === "assistant" && !rec.isSidechain) {
            const u = rec.message?.usage;
            if (u) {
              contextTokens =
                (u.input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0);
            }
          }
          if (!lastAssistantText && role === "assistant") {
            const text = flatten(rec.message?.content ?? rec.content);
            if (text) lastAssistantText = text;
          }
          if (!task && role === "user") {
            const text = flatten(rec.message?.content ?? rec.content);
            if (text) task = text.slice(0, 80);
          }
          if (lastRole && task && lastAssistantText) break;
        }
      } catch {
        /* partial line at chunk boundary */
      }
    }
    // a real question = the final assistant text ends interrogatively;
    // statements ("done, pushed, no CI impact") must NOT claim to need input
    let question: string | undefined;
    if (lastRole === "assistant" && lastAssistantText) {
      const trimmed = lastAssistantText.trim();
      if (/\?["'”)\]]*\s*$/.test(trimmed) || /\?\s*\n?[^?]{0,80}$/.test(trimmed.slice(-160))) {
        const qStart = trimmed.lastIndexOf("?");
        const windowText = trimmed.slice(Math.max(0, qStart - 200), qStart + 1);
        const sentenceStart = Math.max(
          windowText.lastIndexOf(". "), windowText.lastIndexOf("\n"), windowText.lastIndexOf("! ")
        );
        question = windowText.slice(sentenceStart + 1).trim().slice(0, 220);
      }
    }
    return { cwd, launchCwd: headCwd, lastRole, task, model, question, contextTokens };
  } finally {
    await fh.close();
  }
}

function lastMatch(s: string, re: RegExp): string | undefined {
  let m: RegExpExecArray | null, last: string | undefined;
  while ((m = re.exec(s))) last = m[1];
  return last;
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === "string" ? b : b?.type === "text" ? b.text ?? "" : ""))
      .join("")
      .trim();
  }
  return "";
}

function ago(mtime: number): string {
  const m = Math.floor((Date.now() - mtime) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
