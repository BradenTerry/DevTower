import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";
import { DevTowerStore, AgentState } from "./store";
import { currentBranch, isRepo } from "./git";
import { readWaitingMarkers, clearMarker, readSuccessionMarkers, clearSuccessionMarker, readResumeMarkers, clearResumeMarker, readEndMarkers, clearEndMarker } from "./hooks";
import { dlog, elog } from "./debugLog";

function execP(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

/** Liveness of running `claude` processes, used to filter out phantom sessions.
 *  - perCwd: exact count per working directory (Unix, via ps + lsof). `sessionIds`
 *    are the live processes' `--session-id` argv values, when present — these let
 *    the caller keep transcripts by EXACT session identity instead of guessing by
 *    mtime (which mis-fires when a session exits: its final write makes it the
 *    freshest, so the newest-first heuristic would evict an older but still-live
 *    sibling in the same cwd).
 *  - total:  tower-wide count only (Windows — no cwd is available; the caller
 *    caps kept sessions to this many, newest-first).
 *  - null:   process info unavailable → caller falls back to mtime freshness. */
type LiveCounts =
  | { mode: "perCwd"; counts: Map<string, number>; sessionIds?: Set<string> }
  | { mode: "total"; total: number }
  | null;

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
  // cwd → its git branch, with the time we read it. A short TTL is essential: a
  // dev that switches branches mid-session (e.g. `git checkout -b feature/...`)
  // must have its displayed branch — and the branch the PR board queries for it —
  // follow within a poll, not stay pinned to whatever it was at first sight (which
  // left a just-opened PR off the board until the slow poller caught up).
  private branchCache = new Map<string, { branch: string; at: number }>();
  private static readonly BRANCH_TTL_MS = 5_000;
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
  // session uuid → placeholder agent id, when DevTower launched `claude` with an
  // explicit --session-id. This is the DETERMINISTIC binding: the launched
  // transcript filename IS that uuid, so its session binds to exactly the
  // placeholder that started it — even when several placeholders share one
  // worktree (where the worktree/time heuristic below can't tell them apart).
  private expecting = new Map<string, string>();
  // agent id → the transcript mtime we last KEPT it at. A tracked session whose
  // transcript has advanced past this is provably alive right now, so a momentary
  // dip in the per-cwd live-process count must not evict it (anti-flap, PASS 3).
  // A genuinely exited session's transcript freezes, so it stops qualifying and
  // still drops promptly — the --session-id exit contract is preserved.
  private keptMtime = new Map<string, number>();
  // agent id → the session uuid it was tied to last poll, so a change (the tie
  // drifting onto a different session — the duplicate-ghost bug) logs a timeline
  // event rather than hiding inside the periodic snapshot.
  private lastTie = new Map<string, string>();

  // session uuid (lc) → when the SessionEnd hook reported it exited. Its dead
  // transcript lingers on disk (freshest by mtime, thanks to /exit's final
  // write), so without this it could re-evict a still-live sibling on a later
  // poll when no --session-id pins the survivor. We suppress it from rediscovery
  // until it ages out (or its process genuinely returns as a live argv id).
  private retiredSessions = new Map<string, number>();
  private static readonly RETIRED_MAX_AGE_MS = 60 * 60_000;
  // Fires when a watched session just ran `gh pr create` (seen in its transcript)
  // so the PR poller can fetch right away. `knownSessions` gates first-sight
  // seeding (a PR that predates discovery must NOT trigger on startup);
  // `prCreatedSeen` records the last create time per session so each new create
  // fires exactly once.
  private _onPrCreated = new vscode.EventEmitter<void>();
  readonly onPrCreated = this._onPrCreated.event;
  private knownSessions = new Set<string>();
  private prCreatedSeen = new Map<string, number>();

  constructor(
    private store: DevTowerStore,
    // tests inject a fake transcripts root and process-liveness source; in the
    // extension both default to the real home dir + `ps`/`lsof`.
    private deps: {
      projectsRoot?: string;
      tasksRoot?: string;
      liveCounts?: () => Promise<LiveCounts>;
      waitingDir?: string;
      successionDir?: string;
      resumeDir?: string;
      endedDir?: string;
    } = {}
  ) {}

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
  expectSession(agentId: string, sessionId?: string): void {
    this.launchPending.set(agentId, Date.now());
    // a pinned --session-id lets discovery bind THIS exact transcript to THIS
    // placeholder, so multiple placeholders in one worktree never cross-wire
    if (sessionId) this.expecting.set(sessionId, agentId);
    dlog("discovery.expectSession", { agentId, sessionId });
  }

  start(intervalMs = 8_000): void {
    this.timer = setInterval(() => {
      this.refresh().catch((e) => elog("discovery.poll", { message: String(e), stack: (e as any)?.stack }));
    }, intervalMs);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this._onPrCreated.dispose();
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
   * Returns null when the check isn't possible (tools missing); a `total`-mode
   * count on Windows (no per-cwd info there); else exact per-cwd counts.
   */
  private async liveCwdCounts(): Promise<LiveCounts> {
    if (process.platform === "win32") return this.liveClaudeCountWindows();
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
      if (!pids.length) return { mode: "perCwd", counts: new Map() };
      // -a -d cwd → exactly one cwd record per pid; counting them per path
      // yields the number of live claude processes rooted at that directory.
      const out = await execP("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"]);
      const counts = new Map<string, number>();
      for (const line of out.split("\n")) {
        if (!line.startsWith("n")) continue;
        const cwd = line.slice(1).trim();
        counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
      }
      // Pull each live process's `--session-id <uuid>` from argv. The transcript
      // file is named <session-id>.jsonl, so this maps a running process to its
      // exact transcript — far stronger than the per-cwd freshness fallback. Not
      // every session has the flag in argv (a bare `claude` won't), so this is a
      // best-effort overlay; processes without it fall back to the count budget.
      const sessionIds = new Set<string>();
      try {
        const args = await execP("ps", ["-p", pids.join(","), "-o", "args="]);
        const re = /--session-id[= ]([0-9a-fA-F-]{36})/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(args))) sessionIds.add(m[1].toLowerCase());
      } catch {
        // argv unavailable — leave sessionIds empty, freshness fallback applies
      }
      return { mode: "perCwd", counts, sessionIds };
    } catch {
      return null;
    }
  }

  /**
   * Windows has no lsof equivalent for a process's working directory, but we can
   * still count how many `claude` processes are running tower-wide via WMI. That
   * lets the caller cap kept sessions to exactly that many (newest-first) — a
   * strict improvement on the pure mtime-freshness fallback: zero running → drop
   * every phantom at once instead of waiting out the freshness window.
   *
   * Matches the native installer (`claude.exe`) and the npm CLI (a `node`
   * process whose command line includes the `claude-code` package). Returns null
   * if PowerShell/WMI is unavailable, so we degrade to freshness.
   */
  private async liveClaudeCountWindows(): Promise<LiveCounts> {
    const script =
      "@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { " +
      "$_.Name -ieq 'claude.exe' -or ($_.CommandLine -and $_.CommandLine -match 'claude-code') " +
      "}).Count";
    try {
      const out = await execP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      const total = parseInt(out.trim(), 10);
      return Number.isFinite(total) ? { mode: "total", total } : null;
    } catch {
      return null;
    }
  }

  /** Scan + sync into the store. Returns how many sessions were found. */
  async refresh(): Promise<number> {
    const root = this.deps.projectsRoot ?? path.join(os.homedir(), ".claude", "projects");
    const showRecent = vscode.workspace
      .getConfiguration("devtower")
      .get<boolean>("showRecentSessions", false);
    let found: Found[];
    try {
      found = await this.scan(root);
    } catch (e) {
      elog("discovery.scan", { root, message: String(e), stack: (e as any)?.stack });
      return 0;
    }

    // /clear succession markers (keyed by the NEW session id). Resolved into
    // predecessor rebinds AFTER the live budget below, once we know which
    // transcripts are actually live this poll.
    const succession = await readSuccessionMarkers(this.deps.successionDir);
    // resume-picker redirects (keyed by the RESUMED session id): the operator
    // spawned a dev — `claude --session-id <launchId>` — then resumed a different,
    // pre-existing session from Claude's picker. The resumed transcript keeps its
    // own uuid, so the placeholder waiting on `launchId` would never bind it.
    // Resolved into deterministic binds below, once placeholders are gathered.
    const resume = await readResumeMarkers(this.deps.resumeDir);
    // SessionEnd markers: a dev whose session genuinely exited (not /clear). Each
    // is keyed by the EXACT transcript that ended, so we retire that one dev with
    // no guessing — unlike the per-cwd process count, which can't tell which of
    // several co-located sessions left. Resolved into endedIds (below) once the
    // live-process set is known, so a racing/stale marker can't cull a live dev.
    const endMarkers = await readEndMarkers(this.deps.endedDir);

    // Keep one transcript per live claude process. `found` is newest-first, so
    // we walk it and CLAIM a live process slot for each kept session — by its
    // launch dir, or (if renamed/cd'd mid-run) its current dir, whichever still
    // has an unclaimed running process. Claiming per slot (not per dir) is what
    // stops a CLOSED session whose dir was later reused/renamed from borrowing a
    // newer session's live process at the same path (the phantom-agent bug).
    const liveCounts = await (this.deps.liveCounts ?? (() => this.liveCwdCounts()))();
    // live processes' --session-id argv values: the terminals' LAUNCH IDs. A
    // transcript whose uuid is one of these is an un-cleared launch session, so
    // its uuid IS the launch id — stamped onto the agent (below) and kept across
    // /clear.
    const argvIds = new Set<string>(
      (liveCounts && liveCounts.mode === "perCwd" ? [...(liveCounts.sessionIds ?? [])] : []).map((s) => s.toLowerCase())
    );
    // A terminal keeps its launch id across /clear but writes a NEW transcript each
    // time, so its live process is really driving its NEWEST successor — not the
    // launch transcript, which is now dead. Map launch id → newest successor (and
    // each successor → its launch id) so PASS 1 pins the live one and stale launch
    // transcripts don't starve it or linger as ghosts.
    const newestSucc = new Map<string, { succ: string; ts: number }>(); // launch id → newest successor
    const successorLaunch = new Map<string, string>(); // successor session id → launch id
    for (const [succ, m] of succession) {
      if (!m.launchId) continue;
      successorLaunch.set(succ.toLowerCase(), m.launchId);
      const c = newestSucc.get(m.launchId);
      if (!c || m.ts > c.ts) newestSucc.set(m.launchId, { succ: succ.toLowerCase(), ts: m.ts });
    }
    // The /clear remap above lives only as long as its succession MARKER, which is
    // consumed on the poll it binds. On every later poll the marker is gone, so a
    // stale launch transcript (still live by argv) would re-steal the cwd slot from
    // the real current session and resurface as a ghost. Reconstruct the tie from
    // already-bound agents — each keeps its launchId and points transcriptPath at
    // its CURRENT session — so the remap survives the marker. (the ghost-after-/clear
    // bug: argv 13b7…→4f70… is known from the agent even once the marker is gone.)
    const foundIdsLc = new Set(found.map((f) => f.sessionId.toLowerCase()));
    const launchToCurrent = new Map<string, string>(); // launch id (lc) → current session uuid (lc)
    const staleLaunch = new Set<string>(); // dead launch transcripts whose successor is on disk
    for (const a of this.store.list()) {
      if (!a.launchId || !a.transcriptPath) continue;
      const launch = a.launchId.toLowerCase();
      const cur = path.basename(a.transcriptPath, ".jsonl").toLowerCase();
      if (cur === launch) continue; // un-cleared: launch transcript IS the current one
      launchToCurrent.set(launch, cur);
      // only retire the old launch transcript once its successor is actually on
      // disk, so we never suppress it before its replacement exists (orphaning the dev)
      if (foundIdsLc.has(cur)) staleLaunch.add(launch);
    }
    // transcript ids PASS 1 pins as live (launch ids remapped to their successor,
    // from the live marker first, else the persisted agent tie)
    const livePins = new Set<string>();
    for (const id of argvIds) livePins.add(newestSucc.get(id)?.succ ?? launchToCurrent.get(id) ?? id);
    // Session ids the SessionEnd hook reported as exited. Defensively drop (and
    // clear) any marker whose session is still a LIVE process — a stale or racing
    // marker must never retire a running dev; the marker is authoritative only
    // when the process is actually gone.
    const endedIds = new Set<string>();
    for (const [sid] of endMarkers) {
      const lc = sid.toLowerCase();
      if (argvIds.has(lc) || livePins.has(lc)) {
        await clearEndMarker(sid, this.deps.endedDir);
        continue;
      }
      endedIds.add(lc);
      this.retiredSessions.set(lc, Date.now());
    }
    // a retired session whose process genuinely came back (its uuid is live again)
    // is no longer dead — un-suppress it; otherwise age the record out so the map
    // can't grow without bound.
    for (const [lc, ts] of [...this.retiredSessions]) {
      if (argvIds.has(lc) || livePins.has(lc) || Date.now() - ts > ClaudeDiscovery.RETIRED_MAX_AGE_MS) {
        this.retiredSessions.delete(lc);
      }
    }
    // Strip exited/retired sessions from the candidate pool BEFORE the keep passes
    // below. Done here (not after) so a dead transcript can't claim a per-cwd slot
    // by its (freshest, post-/exit) mtime and starve the live sibling that should
    // have kept it — the retire must free the budget for who's actually running.
    const suppress = new Set([...endedIds, ...this.retiredSessions.keys(), ...staleLaunch]);
    if (suppress.size) found = found.filter((f) => !suppress.has(f.sessionId.toLowerCase()));
    const kept: Found[] = [];
    const keptCwd = new Set<string>();
    const asRecent = (f: Found): Found => ({ ...f, state: "idle", task: `(recent) ${f.task}` });
    if (liveCounts === null) {
      // no process info → treat only one very-fresh session per launch dir as live
      for (const f of found) {
        if (keptCwd.has(f.launchCwd)) continue;
        if (Date.now() - f.mtime < 15 * 60_000) {
          keptCwd.add(f.launchCwd);
          kept.push(f);
        } else if (showRecent) {
          keptCwd.add(f.launchCwd);
          kept.push(asRecent(f));
        }
      }
    } else if (liveCounts.mode === "total") {
      // Windows: we know HOW MANY claude processes run, not where. `found` is
      // newest-first, so the freshest N transcripts are the live ones; keep that
      // many (no per-dir dedup — several sessions can share a cwd), recent rest.
      let slots = liveCounts.total;
      for (const f of found) {
        if (slots > 0) {
          slots--;
          keptCwd.add(f.launchCwd);
          kept.push(f);
        } else if (showRecent && !keptCwd.has(f.launchCwd)) {
          keptCwd.add(f.launchCwd);
          kept.push(asRecent(f));
        }
      }
    } else {
      const remaining = new Map(liveCounts.counts);
      const liveIds = livePins; // argv launch ids, remapped to live successors across /clear
      const claim = (cwd: string): boolean => {
        const n = remaining.get(cwd) ?? 0;
        if (n <= 0) return false;
        remaining.set(cwd, n - 1);
        return true;
      };
      // PASS 1: keep transcripts whose session-id matches a live process exactly.
      // This pins each running process to ITS transcript, so exiting one session
      // drops that session (not whichever happens to be oldest by mtime).
      const claimedHere = new Set<Found>();
      for (const f of found) {
        if (!liveIds.has(f.sessionId.toLowerCase())) continue;
        if (claim(f.launchCwd) || (f.cwd !== f.launchCwd && claim(f.cwd))) {
          keptCwd.add(f.launchCwd);
          kept.push(f);
          claimedHere.add(f);
        }
      }
      // PASS 2: fill any leftover per-cwd budget (live processes whose argv hid
      // the session-id) newest-first, then mark the rest as recent if asked.
      for (const f of found) {
        if (claimedHere.has(f)) continue;
        if (claim(f.launchCwd) || (f.cwd !== f.launchCwd && claim(f.cwd))) {
          keptCwd.add(f.launchCwd);
          kept.push(f);
        } else if (showRecent && !keptCwd.has(f.launchCwd)) {
          keptCwd.add(f.launchCwd);
          kept.push(asRecent(f));
        }
      }
    }
    // PASS 3 (anti-flap): rescue a session we showed last poll whose transcript
    // has ADVANCED since — it is unambiguously alive this instant, so a transient
    // wobble in the live-process count (or two co-located plain sessions trading
    // mtime order) must not cull it. Without this, an external ghost in a busy dir
    // with no --session-id to pin it churns out and back every poll, surfacing as
    // duplicate ghosts during the leave/spawn overlap. Exited sessions don't write,
    // so their mtime is frozen and they never qualify → they still leave on time.
    const keptIds = new Set(kept.map((f) => f.id));
    for (const f of found) {
      if (keptIds.has(f.id)) continue; // already shown this poll (live or recent)
      const prev = this.keptMtime.get(f.id);
      if (this.mine.has(f.id) && prev !== undefined && f.mtime > prev) {
        keptCwd.add(f.launchCwd);
        kept.push(f);
        keptIds.add(f.id);
      }
    }
    found = kept;
    // remember each kept session's mtime for next poll's advance check; forget
    // sessions that didn't survive this poll so a later same-uuid reappearance is
    // treated as fresh, not silently rescued.
    const keptMtime = new Map<string, number>();
    for (const f of kept) keptMtime.set(f.id, f.mtime);
    this.keptMtime = keptMtime;

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

    // /clear support: the SessionStart(clear) hook drops a marker keyed by the
    // NEW session uuid, carrying the cleared terminal's LAUNCH ID (its stable
    // --session-id argv). Resolve each marker to the dev it continues:
    //   1. by launch id — deterministic, works even when sessions share a cwd;
    //   2. else the LONE orphan in the marker's cwd — a dev whose bound session
    //      is no longer live, when there's exactly one (no ambiguity). With
    //      several we refuse rather than risk swapping the wrong dev.
    // The successor then rebinds to that dev (it stays put, no stranger), and the
    // dev's now-dead transcript is dropped from `found` so it can't double-bind or
    // surface as a phantom ghost.
    const liveSessionIds = new Set(found.map((f) => f.sessionId.toLowerCase()));
    const byLaunch = new Map<string, string>(); // launch id → agent id
    const orphansByWorktree = new Map<string, string[]>();
    for (const a of this.store.list()) {
      if (a.launchId) byLaunch.set(a.launchId.toLowerCase(), a.id);
      if (!succession.size || !a.transcriptPath || !this.mine.has(a.id)) continue;
      const sid = path.basename(a.transcriptPath, ".jsonl").toLowerCase();
      if (liveSessionIds.has(sid)) continue; // its session is still live → not orphaned
      (orphansByWorktree.get(a.worktree) ?? orphansByWorktree.set(a.worktree, []).get(a.worktree)!).push(a.id);
    }
    const predecessorOf = new Map<string, string>(); // successor session id (lc) → predecessor agent id
    const retired = new Set<string>(); // dead transcript uuids (lc) to drop from `found`
    for (const [succ, mark] of succession) {
      const lc = succ.toLowerCase();
      // chained clears: only the NEWEST successor per launch is live; older ones
      // are dead intermediates — retire them, don't rebind.
      if (mark.launchId && newestSucc.get(mark.launchId)?.succ !== lc) {
        retired.add(lc);
        continue;
      }
      let pred = mark.launchId ? byLaunch.get(mark.launchId) : undefined;
      if (!pred) {
        const pool = orphansByWorktree.get(mark.cwd);
        if (pool && pool.length === 1) pred = pool[0]; // lone orphan → unambiguous
      }
      const a = pred ? this.store.get(pred) : undefined;
      if (!pred || !a) continue;
      predecessorOf.set(lc, pred);
      if (a.transcriptPath) retired.add(path.basename(a.transcriptPath, ".jsonl").toLowerCase());
      if (mark.launchId) retired.add(mark.launchId); // the stale launch transcript is dead too
    }
    if (retired.size) found = found.filter((f) => !retired.has(f.sessionId.toLowerCase()));
    // session ids this poll's succession rebinds landed on, so the apply below
    // can flag the agent (→ the scene sends the dev on its shredder trip) and
    // keep an external dev external rather than re-flagging it as owned.
    const succeeded = new Map<string, string>(); // agent id → new session id
    // why each agent ended up tied to its session THIS poll (launch-id /
    // worktree / succession / discovered / prior-adopt). Surfaced in the binding
    // snapshot so a drifting tie (the duplicate-ghost bug) can be traced.
    const bindReason = new Map<string, string>(); // agent id → reason

    const seenSessions = new Set<string>();
    const claimedPlaceholders = new Set<string>();
    const present = new Set<string>();
    // Coalesce this entire refresh (new-session applies + old-session removes)
    // into ONE webview update. A /clear applies the new session and removes the
    // old one in the same pass; without batching those reach the scene as two
    // separate posts, so it reads as one dev leaving and another entering — and
    // the shred trip only fires when the swap arrives as a single atomic
    // snapshot (old gone AND new present together).
    await this.store.batch(async () => {
    // Retire devs whose session the SessionEnd hook reported as exited. We match
    // the dev whose CURRENT transcript IS the exited session (this also covers an
    // adopted placeholder, whose transcriptPath was flowed to the live session),
    // with the launch id as a fallback. A dev that already moved on via /clear
    // has a different current transcript, so it is correctly left alone. This is
    // deterministic where the per-cwd count is not: exactly the dev you /exit'd
    // leaves, even with several sessions in one folder.
    if (endedIds.size) {
      // a placeholder that exited BEFORE its first prompt never wrote a transcript
      // (a brand-new session writes none until prompted), so it has no
      // transcriptPath/launchId to match. But DevTower knows which placeholder it
      // launched each --session-id into (expecting), so retire by that too — this
      // is the /exit-before-prompting case (quitting the terminal already drops it
      // via the terminal-close path; /exit leaves the shell open, so it can't).
      const endedPlaceholders = new Set<string>();
      for (const e of endedIds) {
        const p = this.expecting.get(e);
        if (p) endedPlaceholders.add(p);
      }
      for (const a of this.store.list()) {
        const sid = a.transcriptPath ? path.basename(a.transcriptPath, ".jsonl").toLowerCase() : "";
        // never retire a dev whose own session is still a live process — the
        // marker only speaks to the exited uuid, not to this agent if it moved on
        if (sid && (argvIds.has(sid) || livePins.has(sid))) continue;
        const byTranscript = sid && endedIds.has(sid);
        const byLaunch = !!a.launchId && endedIds.has(a.launchId.toLowerCase());
        const byExpecting = endedPlaceholders.has(a.id);
        if (!byTranscript && !byLaunch && !byExpecting) continue;
        dlog("discovery.end.retire", { agent: a.id, session: sid, worktree: a.worktree, viaPlaceholder: byExpecting });
        this.mine.delete(a.id);
        this.store.remove(a.id);
      }
      await Promise.all([...endedIds].map((sid) => clearEndMarker(sid, this.deps.endedDir)));
    }
    // Apply resume-picker redirects before binding. A dev spawned with
    // `claude --session-id <launchId>` whose terminal then resumed a different,
    // pre-existing session leaves the placeholder waiting on a session id that
    // never appears, while the resumed transcript surfaces as a stranger in its
    // own worktree — two ghosts for one dev. The SessionStart(resume) hook linked
    // the resumed uuid back to that launch id, so point the placeholder's
    // expectation at the resumed session: the deterministic bind below then adopts
    // it in place, and any twin already surfaced for it is culled here.
    if (resume.size) {
      const foundIds = new Set(found.map((f) => f.sessionId.toLowerCase()));
      for (const [sessY, mark] of resume) {
        const y = sessY.toLowerCase();
        const ph = this.expecting.get(mark.launchId);
        const a = ph ? this.store.get(ph) : undefined;
        // stale redirect (placeholder gone or already bound a session) → forget it
        // so it can't later hijack an unrelated launch reusing the same id.
        if (!ph || !a || a.transcriptPath) {
          clearResumeMarker(sessY, this.deps.resumeDir);
          continue;
        }
        if (!foundIds.has(y)) continue; // resumed transcript not on disk yet — wait
        this.expecting.set(y, ph);
        this.expecting.delete(mark.launchId);
        const twin = "cc-" + y.slice(0, 8);
        if (twin !== ph && this.store.get(twin)) {
          this.mine.delete(twin);
          this.store.remove(twin);
        }
        clearResumeMarker(sessY, this.deps.resumeDir);
        dlog("discovery.resume.redirect", { resumed: y, launchId: mark.launchId, placeholder: ph });
      }
    }
    // placeholders still waiting on a pinned --session-id (launched by DevTower
    // with `claude --session-id`, transcript not yet on disk). Such a placeholder
    // must bind ONLY by that exact id (case 1) — never let the worktree heuristic
    // adopt a stranger session that merely shares the cwd, which strands the real
    // launched session as a ghost. expecting is pruned each poll, so this holds
    // only genuinely-pending pins.
    const awaitingPinned = new Set(this.expecting.values());
    for (const f of found) {
      seenSessions.add(f.id);
      // which store agent this session drives: a prior adoption, a fresh adopt
      // of a placeholder in its launch dir, or its own discovered id
      let targetId = this.adopted.get(f.id);
      if (targetId && !this.store.get(targetId)) {
        this.adopted.delete(f.id);
        targetId = undefined;
      }
      // (1) DETERMINISTIC bind: this transcript's uuid is one DevTower launched
      // with --session-id, so it belongs to exactly that placeholder regardless
      // of cwd, mtime, or how many placeholders share the worktree. This is what
      // lets the operator spin up several devs in one room and prompt each one.
      // Normally the pinned uuid IS the transcript uuid. But a session /clear'd
      // BEFORE its first prompt never writes the pinned transcript (a brand-new
      // session writes nothing until prompted) — its successor carries the pinned
      // id only as a LAUNCH id in the succession marker. Match that too, so the
      // placeholder adopts its real (cleared) session instead of waiting forever
      // while the successor surfaces as an external ghost (the /clear-before-first-
      // prompt ghost). successorLaunch maps successor uuid → launch id.
      if (!targetId && !this.mine.has(f.id)) {
        const lc = f.sessionId.toLowerCase();
        const viaLaunch = this.expecting.has(f.sessionId) ? undefined : successorLaunch.get(lc);
        const key = this.expecting.has(f.sessionId) ? f.sessionId : viaLaunch;
        const want = key ? this.expecting.get(key) : undefined;
        if (want && this.store.get(want) && !this.store.get(want)!.transcriptPath) {
          targetId = want;
          this.adopted.set(f.id, want);
          this.expecting.delete(key!);
          this.launchPending.delete(want);
          bindReason.set(want, viaLaunch ? "launch-id-cleared" : "launch-id");
          // consume the succession marker that linked this successor: the
          // placeholder now owns the live session, so a later poll must not treat
          // the marker as a /clear still in flight (which would park the dev) or
          // rebind the successor a second time.
          if (succession.has(f.sessionId)) {
            succession.delete(f.sessionId);
            clearSuccessionMarker(f.sessionId, this.deps.successionDir);
          }
          dlog("discovery.bind.session", { sessionId: f.sessionId, placeholder: want, cwd: f.cwd, viaLaunch: viaLaunch ?? undefined });
        }
      }
      // (2) HEURISTIC bind (no pinned id — custom launchCommand, or a session
      // started outside DevTower in a placeholder's worktree): only a genuinely
      // NEW session may adopt, and a transcript older than the launch is refused
      // as a stale predecessor. One placeholder per worktree here.
      if (!targetId && !this.mine.has(f.id)) {
        const cand = placeholderByWorktree.get(f.launchCwd) ?? placeholderByWorktree.get(f.cwd);
        // a transcript older than the placeholder's launch is a stale prior
        // session, NOT the one we just started — refuse it so the placeholder
        // waits for its real session instead of binding to the old one
        const launchedAt = cand ? this.launchPending.get(cand) : undefined;
        const fresh = launchedAt === undefined || f.mtime >= launchedAt - ClaudeDiscovery.ADOPT_SLACK_MS;
        // a placeholder awaiting its pinned --session-id must NOT adopt a stranger
        // here; it waits for case 1 to bind its exact session (the ghost-on-spawn
        // bug: the heuristic grabbing an ambient session before the real one lands)
        if (cand && awaitingPinned.has(cand)) {
          dlog("discovery.heuristic.hold", { sessionId: f.sessionId, placeholder: cand, cwd: f.cwd });
        } else if (cand && !claimedPlaceholders.has(cand) && fresh) {
          targetId = cand;
          this.adopted.set(f.id, cand);
          this.launchPending.delete(cand);
          bindReason.set(cand, "worktree");
          dlog("discovery.bind.worktree", { sessionId: f.sessionId, placeholder: cand, cwd: f.cwd });
        }
      }
      // (3) SUCCESSION bind: this uuid is the successor minted by a /clear,
      // already resolved to the dev it continues (by launch id, else lone
      // orphan). Rebind it there so /clear keeps the dev in place rather than
      // culling it and surfacing a fresh stranger.
      if (!targetId && !this.mine.has(f.id)) {
        const predecessor = predecessorOf.get(f.sessionId.toLowerCase());
        if (predecessor && this.store.get(predecessor)) {
          targetId = predecessor;
          this.adopted.set(f.id, predecessor);
          succeeded.set(predecessor, f.sessionId);
          succession.delete(f.sessionId);
          clearSuccessionMarker(f.sessionId, this.deps.successionDir);
          bindReason.set(predecessor, "succession");
          dlog("discovery.bind.succession", { sessionId: f.sessionId, dev: predecessor });
        }
      }
      const id = targetId ?? f.id;
      const isAdopted = id !== f.id;
      // the three deterministic binds above set their own reason; anything else is
      // either a re-bind to a prior adoption or a plain external discovery
      if (!bindReason.has(id)) bindReason.set(id, isAdopted ? "prior-adopt" : "discovered");
      // A session APPEARING FOR THE FIRST TIME in a worktree where the user just
      // spawned a dev, but older than that launch, is the stale predecessor of
      // the session the placeholder is about to adopt (a brand-new session writes
      // no cwd until its first prompt, so it can't be matched yet) — hide it
      // rather than surface a separate external twin. The `!mine` guard is what
      // protects a genuine, already-tracked external agent (e.g. one you're
      // debugging in its own terminal) that simply shares the worktree: it has
      // been seen on prior scans, so adding a dev beside it never culls it.
      if (!isAdopted && !this.mine.has(f.id)) {
        const ph = placeholderByWorktree.get(f.launchCwd) ?? placeholderByWorktree.get(f.cwd);
        const launchedAt = ph ? this.launchPending.get(ph) : undefined;
        if (launchedAt !== undefined && f.mtime < launchedAt - ClaudeDiscovery.ADOPT_SLACK_MS) {
          dlog("discovery.suppress.stale", { sessionId: f.sessionId, placeholder: ph, cwd: f.cwd, mtimeAgoMs: Date.now() - f.mtime });
          continue;
        }
      }
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
      const cachedBranch = this.branchCache.get(cwd);
      let branch: string;
      if (cachedBranch && Date.now() - cachedBranch.at < ClaudeDiscovery.BRANCH_TTL_MS) {
        branch = cachedBranch.branch;
      } else {
        branch = (await isRepo(cwd)) ? await currentBranch(cwd) : "";
        this.branchCache.set(cwd, { branch, at: Date.now() });
      }
      // a /clear succession rebinding onto an EXTERNAL dev must keep it external
      // (it's still an outside session); only an owned placeholder adoption flips
      // it to owned. `cleared` flags the rebind so the scene runs the shred trip.
      const cleared = succeeded.get(id);
      // record the terminal's launch id: this transcript's uuid when it's an
      // un-cleared launch session (matches a live --session-id argv), else the
      // launch id its succession marker carries. Undefined leaves prior intact.
      const launchId = argvIds.has(f.sessionId.toLowerCase())
        ? f.sessionId.toLowerCase()
        : successorLaunch.get(f.sessionId.toLowerCase());
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
          subagents: f.subagents,
          tasks: f.tasks,
          external: cleared ? !!this.store.get(id)?.external : false,
          launchId,
          clearedSession: cleared,
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
          subagents: f.subagents,
          tasks: f.tasks,
          // a purely discovered session (not adopted into a DevTower placeholder)
          // is running in its own terminal outside DevTower
          external: cleared ? !!this.store.get(id)?.external : !isAdopted,
          launchId,
          clearedSession: cleared,
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
    // likewise forget a pinned session-id expectation once its placeholder is
    // gone or has already bound a transcript
    for (const [sid, agentId] of [...this.expecting]) {
      const a = this.store.get(agentId);
      if (!a || a.transcriptPath) this.expecting.delete(sid);
    }
    // forget adoptions whose session has gone away
    for (const [sid] of [...this.adopted]) if (!seenSessions.has(sid)) this.adopted.delete(sid);
    // a /clear whose successor session hasn't surfaced yet (a poll landing in the
    // sub-second gap between the old session dying and the new transcript being
    // written): keep the orphaned dev parked so the next pass can rebind it,
    // rather than culling it now and then meeting its successor as a stranger.
    // `succession` now holds only UNCONSUMED markers (rebinds were deleted above)
    // — spare a dev whose worktree has one in flight, or whose launch id matches a
    // pending marker (its terminal cleared and the new session isn't on disk yet).
    const pendingSuccessionCwds = new Set([...succession.values()].map((m) => m.cwd));
    const pendingLaunch = new Set([...succession.values()].map((m) => m.launchId).filter(Boolean));
    // sessions that aged out or were deleted leave the tower
    for (const id of [...this.mine]) {
      if (!present.has(id)) {
        const a = this.store.get(id);
        if (a?.transcriptPath && (pendingSuccessionCwds.has(a.worktree) || (a.launchId && pendingLaunch.has(a.launchId)))) continue; // /clear in flight
        this.mine.delete(id);
        this.store.remove(id);
      }
    }
    });
    // A session that just ran `gh pr create` should surface its PR immediately,
    // not on the PR poller's lazy ~60s tick. Fire once per new create. A session
    // seen for the FIRST time only seeds its timestamp (a pre-existing PR must not
    // trigger a fetch on startup); a create that advances the stamp on an already
    // known session fires the event.
    let prJustCreated = false;
    for (const f of found) {
      const known = this.knownSessions.has(f.sessionId);
      this.knownSessions.add(f.sessionId);
      if (!f.prCreatedAt) continue;
      if (f.prCreatedAt > (this.prCreatedSeen.get(f.sessionId) ?? 0)) {
        this.prCreatedSeen.set(f.sessionId, f.prCreatedAt);
        if (known) prJustCreated = true;
      }
    }
    if (prJustCreated) {
      dlog("discovery.prCreated", {});
      this._onPrCreated.fire();
    }
    // Per-agent binding snapshot: exactly which claude session each agent is tied
    // to this poll, how it got bound, whether it's owned or external, and the
    // terminal PID (the stable owned-dev tie). This is the trail for diagnosing a
    // dev that drifts onto the wrong session or splits into an owned + ghost twin.
    const bindings = this.store.list().map((a) => ({
      id: a.id,
      name: a.name,
      session: a.transcriptPath ? path.basename(a.transcriptPath, ".jsonl") : undefined,
      launchId: a.launchId,
      terminalPid: a.terminalPid,
      external: !!a.external,
      reason: bindReason.get(a.id),
    }));
    // Tie-drift timeline: log the instant an agent's bound session changes, with
    // the old → new uuids and why, so a /clear rebind vs an unexpected swap is
    // distinguishable after the fact.
    const tie = new Map<string, string>();
    for (const b of bindings) {
      if (!b.session) continue;
      tie.set(b.id, b.session);
      const prev = this.lastTie.get(b.id);
      if (prev && prev !== b.session) {
        dlog("discovery.tie.change", { id: b.id, from: prev, to: b.session, reason: b.reason, external: b.external });
      }
    }
    this.lastTie = tie;
    dlog("discovery.refresh", {
      found: found.length,
      present: [...present],
      external: this.store.list().filter((a) => a.external).map((a) => a.id),
      placeholders: this.store.list().filter((a) => !a.transcriptPath).map((a) => a.id),
      bindings,
    });
    return found.length;
  }

  private async scan(root: string): Promise<Found[]> {
    const cfg = vscode.workspace.getConfiguration("devtower");
    const maxAge = cfg.get<number>("sessionMaxAgeHours", 24) * 3_600_000;
    const now = Date.now();
    const out: Found[] = [];

    // hook-backed "raised hand": Claude Code's Notification hook drops a marker
    // when a session is parked on a permission/input prompt. A marker newer than
    // the transcript mtime means the session hasn't moved since → still waiting.
    const markers = await readWaitingMarkers(this.deps.waitingDir);
    // the Task tool's per-session store lives beside `projects/` under `tasks/`
    const tasksRoot = this.deps.tasksRoot ?? path.join(root, "..", "tasks");

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
        const sessionId = fn.slice(0, -6); // strip ".jsonl"
        // A foreground sub-agent BLOCKS the parent's main thread, so the parent
        // transcript falls silent for the whole spawn while the sub-agent writes
        // its OWN file under <sessionId>/subagents/. Fold that activity in as the
        // session's real last-active time. Without it a session running a spawn
        // looks idle, and — the bug this fixes — an already-answered permission
        // marker keeps the hand up: marker.ts stays ahead of the frozen parent
        // mtime until the sub-agent returns. A genuinely blocked sub-agent isn't
        // writing, so its mtime stays behind the marker and the hand holds.
        const tasks = await readTasks(tasksRoot, sessionId);
        const activityMtime = Math.max(st.mtimeMs, await newestSubMtime(pdir, sessionId));
        const age = now - activityMtime;
        // a fresh Notification marker overrides everything: the harness told us
        // this session is parked. Once it resumes, activity advances past the
        // marker's ts — drop the now-stale marker so the hand falls.
        const marker = markers.get(sessionId);
        const waitingByHook = !!marker && marker.ts > activityMtime;
        if (marker && !waitingByHook) clearMarker(sessionId, this.deps.waitingDir);
        // otherwise: a session mid-turn (a tool in flight, or an owed reply) is
        // WORKING even if the transcript has been silent past the freshness window
        // — a long build/test or a long model turn must not read as idle. Only a
        // turn that ENDS in a statement is done → idle; one ending in a question is
        // waiting on the human.
        const state: AgentState = waitingByHook
          ? "waiting"
          : age < 120_000
            ? "active"
            : meta.working
              ? "active"
              : meta.lastRole === "assistant" && meta.question
                ? "waiting"
                : "idle";
        out.push({
          id: "cc-" + fn.slice(0, 8),
          sessionId,
          file,
          cwd: meta.cwd,
          launchCwd: meta.launchCwd ?? meta.cwd,
          mtime: st.mtimeMs,
          state,
          task: meta.task || "Claude session",
          model: meta.model || "claude",
          question:
            state !== "waiting" ? undefined : waitingByHook ? marker!.message || meta.question : meta.question,
          contextTokens: meta.contextTokens,
          skills: meta.skills,
          subagents: meta.subagents,
          tasks,
          prCreatedAt: meta.prCreatedAt,
        });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, 12); // newest sessions; keep the tower readable
  }
}

interface Found {
  id: string;
  sessionId: string; // transcript uuid (filename without .jsonl) — the real session id
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
  subagents?: number;
  tasks?: { done: number; total: number };
  prCreatedAt?: number; // ms time of this session's most recent `gh pr create`
}

/** Count an agent's task list from `~/.claude/tasks/<sessionId>/*.json` — the
 *  Task tool's per-session store, one JSON file per task carrying a `status` of
 *  pending|in_progress|completed. Returns done/total only for a list of 2+ tasks
 *  (a single task isn't worth deploying the desk TV). Undefined when none. */
export async function readTasks(
  tasksRoot: string,
  sessionId: string
): Promise<{ done: number; total: number } | undefined> {
  const dir = path.join(tasksRoot, sessionId);
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  let done = 0;
  let total = 0;
  for (const fn of files) {
    if (!fn.endsWith(".json")) continue;
    const raw = await fs.promises.readFile(path.join(dir, fn), "utf8").catch(() => "");
    if (!raw) continue;
    try {
      const t = JSON.parse(raw) as { status?: string };
      if (typeof t.status !== "string") continue;
      total++;
      if (t.status === "completed") done++;
    } catch {
      // a half-written task file mid-poll — skip it
    }
  }
  return total >= 2 ? { done, total } : undefined;
}

/** Newest mtime among a session's sub-agent transcripts. They live in a sibling
 *  `<sessionId>/subagents/agent-*.jsonl` dir, NOT in the parent .jsonl, so the
 *  parent's mtime stays frozen while a foreground spawn runs. Returns 0 when the
 *  session has spawned none (the common case). */
export async function newestSubMtime(projectDir: string, sessionId: string): Promise<number> {
  const dir = path.join(projectDir, sessionId, "subagents");
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  let newest = 0;
  for (const fn of files) {
    if (!fn.endsWith(".jsonl")) continue;
    const st = await fs.promises.stat(path.join(dir, fn)).catch(() => null);
    if (st && st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return newest;
}

/** Read head (for cwd) + tail (for last role / prompt / model) of a transcript. */
export async function readMeta(
  file: string,
  size: number
): Promise<{ cwd?: string; launchCwd?: string; lastRole?: string; task?: string; model?: string; question?: string; contextTokens?: number; skills?: string[]; subagents?: number; working?: boolean; prCreatedAt?: number }> {
  const CHUNK = 32 * 1024;
  const fh = await fs.promises.open(file, "r").catch(() => null);
  if (!fh) return {};
  try {
    const headBuf = Buffer.alloc(Math.min(CHUNK, size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString("utf8");
    // cwd is pulled out by regex (not JSON.parse, which can't span chunk
    // boundaries), so the captured value is still JSON-escaped. On Windows the
    // path has backslashes that JSON stores doubled ("C:\\Users\\me"), so it
    // MUST be unescaped or every discovered session lands at a bogus path.
    const headCwd = jsonUnescape(/"cwd"\s*:\s*"([^"]+)"/.exec(head)?.[1]);

    let tail = head;
    if (size > CHUNK) {
      const tailBuf = Buffer.alloc(CHUNK);
      await fh.read(tailBuf, 0, CHUNK, size - CHUNK);
      tail = tailBuf.toString("utf8");
    }
    // Sub-agent accounting needs the WHOLE transcript, not the head/tail window:
    // a spawn can sit anywhere, and a background spawn acks its launch right
    // away, so a fixed window misses both. Read the file in full when it is a
    // sane size; very large transcripts fall back to the tail window.
    const SUB_MAX = 8 * 1024 * 1024;
    let full = tail;
    if (size > CHUNK && size <= SUB_MAX) {
      const fullBuf = Buffer.alloc(size);
      await fh.read(fullBuf, 0, size, 0);
      full = fullBuf.toString("utf8");
    }
    // prefer the most recent cwd record so /cd mid-session relocates the agent
    const cwd = jsonUnescape(lastMatch(tail, /"cwd"\s*:\s*"([^"]+)"/g)) ?? headCwd;
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

    // in-flight sub-agents: Task/Agent tool calls the session spawned that have
    // not returned yet. Two kinds, tracked differently because they close at
    // different times:
    //   - foreground: an assistant tool_use block (name Task/Agent) stays open
    //     until its matching tool_result lands.
    //   - background (run_in_background): the tool_result ARRIVES IMMEDIATELY as
    //     a launch ack ("agentId: <id>"), so it can't mark the work done. It is
    //     instead tracked by that agentId and closed when a <task-notification>
    //     reports it completed/failed.
    // The count rises on fan-out and falls back to 0 once everything settles.
    const fgPending = new Set<string>(); // foreground tool_use ids, still open
    const bgPendingTool = new Set<string>(); // background tool ids awaiting their ack
    const bgPendingId = new Set<string>(); // background agentIds, still running
    // `gh pr create` Bash tool_use ids awaiting their result. When the result
    // lands the PR exists, so we stamp `prCreatedAt` with that turn's time — the
    // discovery loop uses it to kick an immediate PR fetch instead of letting the
    // new PR wait out the poller's lazy ~60s tick.
    const prCreateTools = new Set<string>();
    let prCreatedAt = 0;
    const reNote = /<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>[\s\S]*?<status>\s*(?:completed|failed|cancelled|canceled|killed|error|stopped)\s*<\/status>/g;
    for (const raw of full.split("\n")) {
      const t = raw.trim();
      if (!t.startsWith("{")) continue;
      let rec: any;
      try { rec = JSON.parse(t); } catch { continue; }
      const content = rec.message?.content ?? rec.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "tool_use" && (b.name === "Task" || b.name === "Agent")) {
            if (b.input && b.input.run_in_background) bgPendingTool.add(b.id);
            else fgPending.add(b.id);
          } else if (b.type === "tool_use" && b.name === "Bash" &&
                     typeof b.input?.command === "string" && /\bgh\s+pr\s+(?:create|new)\b/.test(b.input.command)) {
            prCreateTools.add(b.id);
          } else if (b.type === "tool_result" && b.tool_use_id) {
            if (prCreateTools.has(b.tool_use_id)) {
              prCreateTools.delete(b.tool_use_id);
              const ts = Date.parse(rec.timestamp ?? "");
              if (Number.isFinite(ts)) prCreatedAt = Math.max(prCreatedAt, ts);
            }
            const txt = typeof b.content === "string" ? b.content : flatten(b.content);
            const ack = /agentId:\s*([A-Za-z0-9_-]+)/.exec(txt);
            if (bgPendingTool.has(b.tool_use_id) && ack) {
              bgPendingTool.delete(b.tool_use_id);
              bgPendingId.add(ack[1]);
            } else {
              fgPending.delete(b.tool_use_id); // foreground subagent returned
            }
          }
        }
      }
      // a finished background agent posts a <task-notification> as an injected turn
      if (t.includes("task-notification")) {
        reNote.lastIndex = 0;
        let nm: RegExpExecArray | null;
        while ((nm = reNote.exec(t))) bgPendingId.delete(nm[1]);
      }
    }
    const subagents = fgPending.size + bgPendingTool.size + bgPendingId.size;

    // context usage = the prompt window of the latest MAIN-THREAD assistant turn.
    // Mirrors Claude Code's own `/context`: input + the two cache buckets (all
    // tokens occupying the window), NOT output. We read it from the parsed
    // records below so sub-agent (sidechain) turns — which carry their own,
    // smaller usage — never masquerade as the session's real context.
    let contextTokens: number | undefined;

    let lastRole: string | undefined;
    let task: string | undefined;
    let lastAssistantText: string | undefined;
    // is the session mid-turn (working) rather than parked? The NEWEST real record
    // tells us: a `user` turn means a tool_result or prompt just landed and the
    // agent owes a reply; an `assistant` turn carrying a tool_use block means a
    // tool is in flight (no result has been written after it). Both mean WORKING
    // even when no byte has hit the transcript for a while — a long-running tool
    // (build/test) or a long model turn would otherwise read as idle (feet up).
    let working = false;
    let sawNewest = false;
    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t || !t.startsWith("{")) continue;
      try {
        const rec = JSON.parse(t);
        const role = rec.type ?? rec.message?.role;
        if (role === "user" || role === "assistant") {
          if (!sawNewest) {
            sawNewest = true;
            const c = rec.message?.content ?? rec.content;
            const hasToolUse = Array.isArray(c) && c.some((b: any) => b?.type === "tool_use");
            working = role === "user" || hasToolUse;
          }
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
    return { cwd, launchCwd: headCwd, lastRole, task, model, question, contextTokens, skills, subagents, working, prCreatedAt: prCreatedAt || undefined };
  } finally {
    await fh.close();
  }
}

/** True for non-human user turns Claude Code writes into the transcript:
 *  synthetic continuations, slash-command wrappers, hook/system-reminder blocks.
 *  These must never become an agent's displayed task. */
export function isSyntheticTask(text: string): boolean {
  if (text === "<synthetic>") return true;
  if (/^<(synthetic|command-|local-command|bash-(input|stdout|stderr)|system-reminder|user-prompt-submit-hook)/i.test(text)) return true;
  if (/^Caveat: The messages below were generated/i.test(text)) return true;
  return false;
}

/** Unescape a JSON string body captured by regex (we can't always JSON.parse —
 *  the record may straddle a read-chunk boundary). Critical for Windows paths,
 *  where backslashes are stored doubled. Returns undefined unchanged. */
export function jsonUnescape(s: string | undefined): string | undefined {
  if (s === undefined || s.indexOf("\\") === -1) return s;
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, esc: string) => {
    switch (esc[0]) {
      case "\\": return "\\";
      case '"': return '"';
      case "/": return "/";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case "u": return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return esc; // unknown escape → keep the char as-is
    }
  });
}

export function lastMatch(s: string, re: RegExp, accept?: (v: string) => boolean): string | undefined {
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

export function ago(mtime: number): string {
  const m = Math.floor((Date.now() - mtime) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
