import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";
import { FleetStore, AgentState } from "./fleet";
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

  constructor(private store: FleetStore) {}

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Working directories of claude processes that are actually running right
   * now. A transcript on disk is NOT a running session — without this check,
   * every session touched in the last day shows up as a phantom agent.
   * Returns null when the check isn't possible (Windows / tools missing).
   */
  private async liveCwds(): Promise<Set<string> | null> {
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
      if (!pids.length) return new Set();
      const out = await execP("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"]);
      const set = new Set<string>();
      for (const line of out.split("\n")) {
        if (line.startsWith("n")) set.add(line.slice(1).trim());
      }
      return set;
    } catch {
      return null;
    }
  }

  /** Scan + sync into the store. Returns how many sessions were found. */
  async refresh(): Promise<number> {
    const root = path.join(os.homedir(), ".claude", "projects");
    const showRecent = vscode.workspace
      .getConfiguration("fleet")
      .get<boolean>("showRecentSessions", false);
    let found: Found[];
    try {
      found = await this.scan(root);
    } catch {
      return 0;
    }

    // keep only sessions backed by a live claude process (newest per cwd);
    // optionally also show recent-but-closed ones as idle "resumable" rooms
    const live = await this.liveCwds();
    const seenCwd = new Set<string>();
    const kept: Found[] = [];
    for (const f of found) {
      // found is sorted newest-first
      const isLive =
        live === null
          ? Date.now() - f.mtime < 15 * 60_000 // no process info → only very fresh
          : live.has(f.cwd);
      if (isLive) {
        // at most one agent per cwd unless both are actively being written
        if (seenCwd.has(f.cwd) && Date.now() - f.mtime > 10 * 60_000) continue;
        seenCwd.add(f.cwd);
        kept.push(f);
      } else if (showRecent) {
        if (seenCwd.has(f.cwd)) continue;
        seenCwd.add(f.cwd);
        kept.push({ ...f, state: "idle", task: `(recent) ${f.task}` });
      }
    }
    found = kept;

    const present = new Set<string>();
    for (const f of found) {
      present.add(f.id);
      this.mine.add(f.id);
      let branch = this.branchCache.get(f.cwd);
      if (branch === undefined) {
        branch = (await isRepo(f.cwd)) ? await currentBranch(f.cwd) : "";
        this.branchCache.set(f.cwd, branch);
      }
      this.store.apply({
        id: f.id,
        name: `${path.basename(f.cwd)}·${f.id.slice(3, 7)}`,
        model: f.model,
        repo: path.basename(f.cwd),
        worktree: f.cwd,
        branch: branch || "—",
        state: f.state,
        task: f.task,
        elapsed: ago(f.mtime),
        transcriptPath: f.file,
        question: f.question,
        contextTokens: f.contextTokens,
      });
    }
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
    const cfg = vscode.workspace.getConfiguration("fleet");
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
  cwd: string;
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
): Promise<{ cwd?: string; lastRole?: string; task?: string; model?: string; question?: string; contextTokens?: number }> {
  const CHUNK = 32 * 1024;
  const fh = await fs.promises.open(file, "r").catch(() => null);
  if (!fh) return {};
  try {
    const headBuf = Buffer.alloc(Math.min(CHUNK, size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString("utf8");
    const cwd = /"cwd"\s*:\s*"([^"]+)"/.exec(head)?.[1];

    let tail = head;
    if (size > CHUNK) {
      const tailBuf = Buffer.alloc(CHUNK);
      await fh.read(tailBuf, 0, CHUNK, size - CHUNK);
      tail = tailBuf.toString("utf8");
    }
    const model = lastMatch(tail, /"model"\s*:\s*"([^"]+)"/g);
    // context usage = the last turn's full input window + output
    let contextTokens: number | undefined;
    // capture up to the first closing brace — the four token counts all come
    // before nested objects like server_tool_use:{...}
    const usageStr = lastMatch(tail, /"usage"\s*:\s*\{([^}]*)/g);
    if (usageStr) {
      const num = (k: string) => {
        const m = new RegExp(`"${k}"\\s*:\\s*(\\d+)`).exec(usageStr);
        return m ? Number(m[1]) : 0;
      };
      contextTokens =
        num("input_tokens") +
        num("cache_read_input_tokens") +
        num("cache_creation_input_tokens") +
        num("output_tokens");
    }

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
    return { cwd, lastRole, task, model, question, contextTokens };
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
