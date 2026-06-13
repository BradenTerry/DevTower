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
  private cdPending = new Map<string, { dir: string; room?: string; at: number }>();
  private static readonly CD_HOLD_MS = 120_000;
  // session id → the panel-created placeholder agent it was adopted into, so a
  // launched Claude session flows into that agent rather than spawning a dup.
  private adopted = new Map<string, string>();
  // placeholder agent id → when DevTower launched its terminal. A placeholder
  // may only adopt a session whose transcript is no older than this — otherwise
  // a STALE prior transcript in the same worktree (you ran claude there earlier)
  // gets bound to the placeholder, then churns out the moment the real launched
  // session writes its own transcript and steals the live-process slot.
  private launchPending = new Map<string, number>();
  // slack for clock skew / mtime granularity when comparing launch vs transcript
  private static readonly ADOPT_SLACK_MS = 10_000;

  constructor(private store: DevTowerStore) {}

  /** Record that an agent was sent `/cd <dir>`. The move is NOT applied until a
   *  scan sees the transcript report `dir` as the live cwd — only then is the
   *  agent relocated (to `room`). A declined/failed /cd never confirms, so the
   *  agent stays put; the pending entry expires after CD_HOLD_MS. */
  expectCd(agentId: string, dir: string, room?: string): void {
    this.cdPending.set(agentId, { dir, room, at: Date.now() });
    void this.refresh();
  }

  /** Record that DevTower just launched a Claude session into the placeholder
   *  `agentId`. Only a transcript written at/after this moment may be adopted
   *  into it, so a pre-existing transcript in the same worktree can't be
   *  mis-bound and then churned out when the real launched session appears. */
  expectSession(agentId: string): void {
    this.launchPending.set(agentId, Date.now());
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

    // Keep one transcript per live claude process. `found` is newest-first, so
    // we walk it and CLAIM a live process slot for each kept session — by its
    // launch dir, or (if renamed/cd'd mid-run) its current dir, whichever still
    // has an unclaimed running process. Claiming per slot (not per dir) is what
    // stops a CLOSED session whose dir was later reused/renamed from borrowing a
    // newer session's live process at the same path (the phantom-agent bug).
    const liveCounts = await this.liveCwdCounts();
    const kept: Found[] = [];
    const keptCwd = new Set<string>();
    if (liveCounts === null) {
      // no process info → treat only one very-fresh session per launch dir as live
      for (const f of found) {
        if (keptCwd.has(f.launchCwd)) continue;
        if (Date.now() - f.mtime < 15 * 60_000) {
          keptCwd.add(f.launchCwd);
          kept.push(f);
        } else if (showRecent) {
          keptCwd.add(f.launchCwd);
          kept.push({ ...f, state: "idle", task: `(recent) ${f.task}` });
        }
      }
    } else {
      const remaining = new Map(liveCounts);
      const claim = (cwd: string): boolean => {
        const n = remaining.get(cwd) ?? 0;
        if (n <= 0) return false;
        remaining.set(cwd, n - 1);
        return true;
      };
      for (const f of found) {
        if (claim(f.launchCwd) || (f.cwd !== f.launchCwd && claim(f.cwd))) {
          keptCwd.add(f.launchCwd);
          kept.push(f);
        } else if (showRecent && !keptCwd.has(f.launchCwd)) {
          keptCwd.add(f.launchCwd);
          kept.push({ ...f, state: "idle", task: `(recent) ${f.task}` });
        }
      }
    }
    found = kept;

    // Panel-created placeholders (a reviewer / added dev) carry no transcript
    // yet. When a live session turns up in such a placeholder's worktree, adopt
    // it into that agent instead of spawning a separate discovered one — one
    // terminal, one session, one agent.
    const placeholderByWorktree = new Map<string, string>();
    for (const a of this.store.list()) {
      if (!a.transcriptPath && !this.mine.has(a.id) && !placeholderByWorktree.has(a.worktree)) {
        placeholderByWorktree.set(a.worktree, a.id);
      }
    }

    const seenSessions = new Set<string>();
    const claimedPlaceholders = new Set<string>();
    const present = new Set<string>();
    for (const f of found) {
      seenSessions.add(f.id);
      // which store agent this session drives: a prior adoption, a fresh adopt
      // of a placeholder in its launch dir, or its own discovered id
      let targetId = this.adopted.get(f.id);
      if (targetId && !this.store.get(targetId)) {
        this.adopted.delete(f.id);
        targetId = undefined;
      }
      // only a genuinely NEW session may adopt a placeholder — a session we are
      // already tracking keeps its own id, so an existing dev sharing the cwd
      // can't hijack the placeholder (which would churn it out + back in)
      if (!targetId && !this.mine.has(f.id)) {
        const cand = placeholderByWorktree.get(f.launchCwd) ?? placeholderByWorktree.get(f.cwd);
        // a transcript older than the placeholder's launch is a stale prior
        // session, NOT the one we just started — refuse it so the placeholder
        // waits for its real session instead of binding to the old one
        const launchedAt = cand ? this.launchPending.get(cand) : undefined;
        const fresh = launchedAt === undefined || f.mtime >= launchedAt - ClaudeDiscovery.ADOPT_SLACK_MS;
        if (cand && !claimedPlaceholders.has(cand) && fresh) {
          targetId = cand;
          this.adopted.set(f.id, cand);
          this.launchPending.delete(cand);
        }
      }
      const id = targetId ?? f.id;
      const isAdopted = id !== f.id;
      if (isAdopted) claimedPlaceholders.add(id);
      present.add(id);
      this.mine.add(id);

      // a pending /cd only takes effect once the transcript actually reports the
      // target dir as the live cwd (the move "worked"); until then the agent is
      // shown wherever it really is. The hold expires so a failed /cd is dropped.
      const cwd = f.cwd;
      const pend = this.cdPending.get(id);
      let cdRoom: string | undefined;
      if (pend) {
        if (cwd === pend.dir) {
          cdRoom = pend.room; // confirmed — relocate to the requested room
          this.cdPending.delete(id);
        } else if (Date.now() - pend.at > ClaudeDiscovery.CD_HOLD_MS) {
          this.cdPending.delete(id);
        }
      }
      const cdConfirmed = cdRoom !== undefined || (pend !== undefined && cwd === pend.dir);
      let branch = this.branchCache.get(cwd);
      if (branch === undefined) {
        branch = (await isRepo(cwd)) ? await currentBranch(cwd) : "";
        this.branchCache.set(cwd, branch);
      }
      if (isAdopted && !cdConfirmed) {
        // keep the placeholder's identity (name/repo/worktree/branch/task);
        // only flow in the live session fields
        this.store.apply({
          id,
          model: f.model,
          state: f.state,
          elapsed: ago(f.mtime),
          transcriptPath: f.file,
          question: f.question,
          contextTokens: f.contextTokens,
          skills: f.skills,
          external: false, // DevTower launched/owns this one
        });
      } else {
        // a discovered agent (or a just-confirmed /cd) is placed at its real cwd.
        // On a confirmed move, honor the requested room name; keep an adopted
        // agent's own name rather than renaming it.
        this.store.apply({
          id,
          name: isAdopted ? undefined : `${path.basename(cwd)}·${f.id.slice(3, 7)}`,
          model: f.model,
          repo: cdRoom ?? path.basename(cwd),
          worktree: cwd,
          branch: branch || "—",
          state: f.state,
          task: isAdopted ? undefined : f.task,
          elapsed: ago(f.mtime),
          transcriptPath: f.file,
          question: f.question,
          contextTokens: f.contextTokens,
          skills: f.skills,
          // a purely discovered session (not adopted into a DevTower placeholder)
          // is running in its own terminal outside DevTower
          external: !isAdopted,
        });
      }
    }
    // drop pending /cd for agents that are no longer present
    for (const id of [...this.cdPending.keys()]) if (!present.has(id)) this.cdPending.delete(id);
    // drop launch waits once the placeholder is gone (removed) or has adopted a
    // session (present with a transcript → no longer an unbound placeholder)
    for (const id of [...this.launchPending.keys()]) {
      const a = this.store.get(id);
      if (!a || a.transcriptPath) this.launchPending.delete(id);
    }
    // forget adoptions whose session has gone away
    for (const [sid] of [...this.adopted]) if (!seenSessions.has(sid)) this.adopted.delete(sid);
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
          skills: meta.skills,
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
  skills?: string[];
}

/** Read head (for cwd) + tail (for last role / prompt / model) of a transcript. */
async function readMeta(
  file: string,
  size: number
): Promise<{ cwd?: string; launchCwd?: string; lastRole?: string; task?: string; model?: string; question?: string; contextTokens?: number; skills?: string[] }> {
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
    // newest real model id — synthetic/meta turns carry "model":"<synthetic>",
    // which must not become the agent's displayed model
    const model = lastMatch(tail, /"model"\s*:\s*"([^"]+)"/g, (v) => v !== "<synthetic>");

    // skills the agent used, visible in the tail. Two ways a skill shows up:
    //   1. the model called the Skill tool ("name":"Skill", input.skill), and
    //   2. the user typed it as a slash command (/foo) — Claude Code records that
    //      as a <command-name> turn, NOT a Skill tool_use, so #1 misses it.
    // Both load the skill body, which carries a "Base directory for this skill:
    // <abs path>/<name>" line (built-in slashes like /clear do NOT), so that line
    // is the reliable unified signal. Names are normalised to the bare skill name
    // so the tool form (plugin:foo) and the path form (.../foo) dedupe to one. The
    // store unions these across polls so a session's full set survives calls
    // scrolling out of the window.
    const skills: string[] = [];
    const addSkill = (raw: string) => {
      const n = raw.split(/[/:\\]/).filter(Boolean).pop();
      if (n && /^[a-z0-9][a-z0-9._-]*$/i.test(n) && !skills.includes(n)) skills.push(n);
    };
    for (const re of [
      /"name"\s*:\s*"Skill"\s*,\s*"input"\s*:\s*\{\s*"skill"\s*:\s*"([^"]+)"/g,
      /Base directory for this skill:\s*(\/[^\s"\\]+)/g, // slash-invoked + tool-loaded skills
    ]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(tail))) addSkill(m[1]);
    }

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
          if (!task && role === "user" && rec.isMeta !== true) {
            const text = flatten(rec.message?.content ?? rec.content);
            // skip Claude Code's injected turns (synthetic continuations, slash
            // command wrappers, system reminders) — they aren't the human task
            if (text && !isSyntheticTask(text)) task = text.slice(0, 80);
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
    return { cwd, launchCwd: headCwd, lastRole, task, model, question, contextTokens, skills };
  } finally {
    await fh.close();
  }
}

/** True for non-human user turns Claude Code writes into the transcript:
 *  synthetic continuations, slash-command wrappers, hook/system-reminder blocks.
 *  These must never become an agent's displayed task. */
function isSyntheticTask(text: string): boolean {
  if (text === "<synthetic>") return true;
  if (/^<(synthetic|command-|local-command|bash-(input|stdout|stderr)|system-reminder|user-prompt-submit-hook)/i.test(text)) return true;
  if (/^Caveat: The messages below were generated/i.test(text)) return true;
  return false;
}

function lastMatch(s: string, re: RegExp, accept?: (v: string) => boolean): string | undefined {
  let m: RegExpExecArray | null, last: string | undefined;
  while ((m = re.exec(s))) if (!accept || accept(m[1])) last = m[1];
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
