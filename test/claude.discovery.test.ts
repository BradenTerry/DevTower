import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { ClaudeDiscovery } from "../src/claude";
import { DevTowerStore } from "../src/store";

/**
 * Exercises ClaudeDiscovery.refresh() end to end against a fake ~/.claude
 * projects tree and a stubbed process-liveness source. The focus is BINDING: a
 * panel-created placeholder must adopt exactly the Claude session DevTower
 * launched for it (pinned via --session-id), so several placeholders can share
 * one worktree — the operator spins up N devs in a room and prompts each — and
 * each lights up its own placeholder instead of cross-wiring or spawning a
 * duplicate external agent.
 */
describe("ClaudeDiscovery binding", () => {
  let root: string; // fake ~/.claude/projects
  let proj: string; // one encoded-project subdir
  let wt: string; // a worktree the placeholders live in
  let waitingDir: string; // fake ~/.claude/devtower/waiting
  let succDir: string; // fake ~/.claude/devtower/succession
  let resumeDir: string; // fake ~/.claude/devtower/resume
  let endedDir: string; // fake ~/.claude/devtower/ended

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-disc-"));
    proj = path.join(root, "-fake-project");
    fs.mkdirSync(proj);
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-wt-"));
    waitingDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-wait-"));
    succDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-succ-"));
    resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-resume-"));
    endedDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-ended-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(waitingDir, { recursive: true, force: true });
    fs.rmSync(succDir, { recursive: true, force: true });
    fs.rmSync(resumeDir, { recursive: true, force: true });
    fs.rmSync(endedDir, { recursive: true, force: true });
  });

  /** Drop a SessionStart(clear) succession marker for the new session uuid,
   *  optionally carrying the cleared terminal's launch id. */
  const writeSuccession = (uuid: string, cwd = wt, launchId?: string) =>
    fs.writeFileSync(
      path.join(succDir, `${uuid}.json`),
      JSON.stringify({ cwd, source: "clear", ts: Date.now(), ...(launchId ? { launchId } : {}) })
    );

  /** Drop a SessionStart(resume) marker: a DevTower terminal launched with
   *  `--session-id <launchId>` resumed the pre-existing session `uuid`. */
  const writeResume = (uuid: string, launchId: string, cwd = wt) =>
    fs.writeFileSync(
      path.join(resumeDir, `${uuid}.json`),
      JSON.stringify({ cwd, source: "resume", ts: Date.now(), launchId })
    );

  /** Drop a SessionEnd-hook marker for a session that genuinely exited. */
  const writeEnded = (uuid: string, cwd = wt, reason = "prompt_input_exit", launchId?: string) =>
    fs.writeFileSync(
      path.join(endedDir, `${uuid}.json`),
      JSON.stringify({ cwd, reason, ts: Date.now(), ...(launchId ? { launchId } : {}) })
    );

  /** Drop a Notification-hook marker for a session, `tsOffsetSec` relative to now. */
  const writeMarker = (uuid: string, message: string, tsOffsetSec = 5) =>
    fs.writeFileSync(
      path.join(waitingDir, `${uuid}.json`),
      JSON.stringify({ message, cwd: wt, ts: Date.now() + tsOffsetSec * 1000 })
    );

  const newStore = () => new DevTowerStore({ subscriptions: [] } as any);

  /** Write a transcript <uuid>.jsonl reporting `cwd`, with a controllable mtime
   *  (seconds ago). Returns the session uuid. */
  const writeSession = (cwd: string, agoSec = 0, uuid = randomUUID()): string => {
    const file = path.join(proj, `${uuid}.jsonl`);
    const line = JSON.stringify({ type: "user", cwd, message: { role: "user", content: "do the thing" } });
    fs.writeFileSync(file, line + "\n");
    if (agoSec) {
      const t = Date.now() / 1000 - agoSec;
      fs.utimesSync(file, t, t);
    }
    return uuid;
  };

  /** A perCwd liveness stub: every listed dir reports `n` running claude procs.
   *  Optionally pin the live processes' session-ids (their `--session-id` argv). */
  const live = (counts: Record<string, number>, sessionIds?: string[]) => async () =>
    ({
      mode: "perCwd" as const,
      counts: new Map(Object.entries(counts)),
      ...(sessionIds ? { sessionIds: new Set(sessionIds) } : {}),
    });

  /** Stand up a discovery wired to the fake tree + a liveness stub. */
  const discovery = (store: DevTowerStore, counts: Record<string, number>, sessionIds?: string[]) =>
    new ClaudeDiscovery(store, {
      projectsRoot: root,
      liveCounts: live(counts, sessionIds),
      waitingDir,
      successionDir: succDir,
      resumeDir,
      endedDir,
    });

  /** Create a panel placeholder exactly as addDev does (no transcript yet). */
  const placeholder = (store: DevTowerStore, id: string, worktree: string) =>
    store.apply({ id, name: id, repo: "isle", worktree, branch: "main", state: "idle", task: "Ready" });

  it("binds a placeholder to the session it launched (no duplicate, no leave)", async () => {
    const store = newStore();
    const disc = discovery(store, { [wt]: 1 });
    placeholder(store, "isle-a1", wt);
    const uuid = randomUUID();
    disc.expectSession("isle-a1", uuid);
    writeSession(wt, 0, uuid);

    await disc.refresh();

    const all = store.list();
    expect(all).toHaveLength(1); // merged in place — no second agent spawned
    const a = store.get("isle-a1")!;
    expect(a.transcriptPath).toBe(path.join(proj, `${uuid}.jsonl`));
    expect(a.external).toBeFalsy(); // DevTower owns it, not an outside session
    expect(a.name).toBe("isle-a1"); // keeps the placeholder identity
  });

  it("binds each of several placeholders in one worktree to its OWN session, regardless of prompt order", async () => {
    const store = newStore();
    const disc = discovery(store, { [wt]: 2 });
    placeholder(store, "isle-a1", wt);
    placeholder(store, "isle-a2", wt);
    const u1 = randomUUID();
    const u2 = randomUUID();
    disc.expectSession("isle-a1", u1);
    disc.expectSession("isle-a2", u2);
    // a2 was launched second but is PROMPTED first → its transcript is newer.
    // A worktree/time heuristic would mis-bind it to a1; the pinned id must not.
    writeSession(wt, 0, u2); // newest
    writeSession(wt, 30, u1); // older

    await disc.refresh();

    expect(store.list()).toHaveLength(2);
    expect(store.get("isle-a1")!.transcriptPath).toBe(path.join(proj, `${u1}.jsonl`));
    expect(store.get("isle-a2")!.transcriptPath).toBe(path.join(proj, `${u2}.jsonl`));
    expect(store.get("isle-a1")!.external).toBeFalsy();
    expect(store.get("isle-a2")!.external).toBeFalsy();
  });

  it("keeps live sessions by --session-id, so exiting one drops THAT one (not the oldest by mtime)", async () => {
    // three sessions share one worktree. The naive "keep N newest by mtime" rule
    // breaks when the newest one exits: its final write leaves it freshest, so an
    // older but still-live sibling gets evicted instead. Pinning by session-id
    // (the running processes' --session-id argv) drops exactly the exited one.
    const store = newStore();
    const u1 = randomUUID(), u2 = randomUUID(), u3 = randomUUID();
    writeSession(wt, 20, u1); // oldest
    writeSession(wt, 10, u2);
    writeSession(wt, 0, u3);  // newest (and the one we'll exit)
    const sid = (u: string) => "cc-" + u.slice(0, 8);

    // one persistent discovery whose liveness we mutate between polls (mirrors the
    // single long-lived instance in the extension, which is what tracks departures)
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 3]]), sessionIds: new Set([u1, u2, u3]) };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, liveCounts: async () => liveSnapshot,
    });

    // all three running → all three present
    await disc.refresh();
    expect(new Set(store.list().map((a) => a.id)))
      .toEqual(new Set([sid(u1), sid(u2), sid(u3)]));

    // u3 exits: only two processes remain (u1, u2), but u3's transcript is still
    // on disk AND newest by mtime. It must be the one that leaves.
    liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 2]]), sessionIds: new Set([u1, u2]) };
    await disc.refresh();
    const remaining = new Set(store.list().map((a) => a.id));
    expect(remaining).toEqual(new Set([sid(u1), sid(u2)]));
    expect(remaining.has(sid(u3))).toBe(false);
  });

  it("retires exactly the /exit'd dev via the SessionEnd marker, even where mtime would keep it", async () => {
    // The trap the hook fixes: two sessions share a worktree and liveness gives
    // only a COUNT (no --session-id pinning, e.g. argv unreadable). When the
    // NEWEST exits, its final /exit write leaves its transcript freshest, so the
    // count/mtime passes keep the dead one and evict the live sibling. The
    // SessionEnd marker names the exited uuid exactly → that dev leaves, the live
    // one stays.
    const store = newStore();
    const u1 = randomUUID(), u2 = randomUUID();
    writeSession(wt, 20, u1); // older, still live
    writeSession(wt, 0, u2);  // newest — the one we /exit
    const sid = (u: string) => "cc-" + u.slice(0, 8);

    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 2]]) };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, endedDir, liveCounts: async () => liveSnapshot,
    });

    await disc.refresh();
    expect(new Set(store.list().map((a) => a.id))).toEqual(new Set([sid(u1), sid(u2)]));

    // u2 exits: one process remains (u1), but u2's transcript is freshest by mtime.
    liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 1]]) };
    writeEnded(u2);
    await disc.refresh();

    expect(new Set(store.list().map((a) => a.id))).toEqual(new Set([sid(u1)]));
    // marker consumed once acted on
    expect(fs.existsSync(path.join(endedDir, `${u2}.json`))).toBe(false);

    // and u2's lingering (freshest) transcript must not re-evict the live u1 on a
    // later poll, after the marker is gone — the retire is remembered.
    await disc.refresh();
    expect(new Set(store.list().map((a) => a.id))).toEqual(new Set([sid(u1)]));
  });

  it("retires a placeholder that /exits before its first prompt (no transcript written yet)", async () => {
    // A brand-new session writes no transcript until prompted, so a placeholder
    // /exit'd before its first prompt has no transcriptPath/launchId to match.
    // DevTower knows which placeholder it launched the --session-id into, so the
    // SessionEnd marker still sends it home. (Quitting the terminal already drops
    // it via terminal-close; /exit leaves the shell open, so this path is needed.)
    const store = newStore();
    const disc = discovery(store, {}); // nothing live
    placeholder(store, "isle-a1", wt);
    const uuid = randomUUID();
    disc.expectSession("isle-a1", uuid); // launched `claude --session-id <uuid>`
    writeEnded(uuid); // user typed /exit before prompting

    await disc.refresh();

    expect(store.list()).toHaveLength(0); // the dev left
    expect(fs.existsSync(path.join(endedDir, `${uuid}.json`))).toBe(false); // swept
  });

  it("ignores a SessionEnd marker whose session is still a live process (stale/racing marker)", async () => {
    // a marker must never cull a running dev: if the named uuid is still in the
    // live --session-id set, the exit hasn't really happened — drop the marker.
    const store = newStore();
    const u1 = randomUUID();
    writeSession(wt, 0, u1);
    const sid = (u: string) => "cc-" + u.slice(0, 8);
    const disc = discovery(store, { [wt]: 1 }, [u1]);

    await disc.refresh();
    expect(store.list().map((a) => a.id)).toEqual([sid(u1)]);

    writeEnded(u1); // stale: u1 is still live
    await disc.refresh();
    expect(store.list().map((a) => a.id)).toEqual([sid(u1)]); // still here
    expect(fs.existsSync(path.join(endedDir, `${u1}.json`))).toBe(false); // swept
  });

  it("does not surface a stale prior transcript while a placeholder waits for its real session", async () => {
    const store = newStore();
    const disc = discovery(store, { [wt]: 1 });
    placeholder(store, "isle-a1", wt);
    disc.expectSession("isle-a1", randomUUID()); // launched now; its session has no cwd yet
    // an OLD session from a previous run sits in the same worktree (borrowing the
    // live process slot). It must not show up as a separate external twin.
    writeSession(wt, 3600);

    await disc.refresh();

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("isle-a1");
    expect(store.get("isle-a1")!.transcriptPath).toBeUndefined(); // still waiting, unbound
  });

  it("keeps an already-running external agent when a dev is added to its worktree", async () => {
    // an outside session is already discovered + shown as external (ghosted)
    const store = newStore();
    const disc = discovery(store, { [wt]: 1 });
    const ext = writeSession(wt, 0);
    await disc.refresh();
    const extId = store.list()[0].id;
    expect(store.get(extId)!.external).toBe(true);

    // now the operator adds a dev to that same worktree and it goes quiet (its
    // transcript stops updating, e.g. paused at a debugger) → mtime falls behind
    // the new launch. The external agent must NOT be culled.
    placeholder(store, "isle-a1", wt);
    disc.expectSession("isle-a1", randomUUID());
    const t = Date.now() / 1000 - 120; // external session now 2 min stale
    fs.utimesSync(path.join(proj, `${ext}.jsonl`), t, t);

    await disc.refresh();

    expect(store.get(extId)).toBeDefined(); // still here — not "external agent left"
    expect(store.get(extId)!.external).toBe(true);
  });

  it("raises the hand for a fresh Notification marker even within the 2-min active window", async () => {
    const store = newStore();
    const disc = discovery(store, { [wt]: 1 });
    const ext = writeSession(wt, 0); // brand new transcript → would normally be "active"
    writeMarker(ext, "Claude needs your permission to use Write"); // ts in the future of mtime

    await disc.refresh();

    const a = store.list()[0];
    expect(a.state).toBe("waiting"); // hook overrides the active mask
    expect(a.question).toBe("Claude needs your permission to use Write");
  });

  it("drops the hand (and sweeps the marker) once the session resumes past the marker", async () => {
    const store = newStore();
    const disc = discovery(store, { [wt]: 1 });
    const ext = writeSession(wt, 0);
    // marker predates the transcript's mtime → the session already moved on
    writeMarker(ext, "stale prompt", -5);

    await disc.refresh();

    expect(store.list()[0].state).not.toBe("waiting");
    await new Promise((r) => setTimeout(r, 10)); // clearMarker is fire-and-forget
    expect(fs.existsSync(path.join(waitingDir, `${ext}.json`))).toBe(false);
  });

  /** Write a sub-agent transcript under <uuid>/subagents/, mtime `agoSec` ago —
   *  the separate file a foreground spawn writes while the parent stays frozen. */
  const writeSubagent = (uuid: string, agoSec = 0) => {
    const dir = path.join(proj, uuid, "subagents");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "agent-deadbeef.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "assistant", isSidechain: true }) + "\n");
    if (agoSec) {
      const t = Date.now() / 1000 - agoSec;
      fs.utimesSync(file, t, t);
    }
  };

  it("drops the hand once a sub-agent advances past the marker, though the parent transcript is frozen", async () => {
    // The bug: a permission prompt raised the hand, the operator answered, then the
    // session ran a foreground sub-agent. The parent transcript stays silent for the
    // whole spawn (the sub-agent writes its OWN file), so the answered marker keeps
    // marker.ts ahead of the parent mtime and the hand sticks up until the spawn ends.
    const store = newStore();
    const disc = discovery(store, { [wt]: 1 });
    const ext = writeSession(wt, 30); // parent went quiet 30s ago (blocked on the spawn)
    writeMarker(ext, "Claude needs your permission to read files", -10); // answered 10s before the freeze
    writeSubagent(ext, 0); // sub-agent is actively writing now → past the marker

    await disc.refresh();

    expect(store.list()[0].state).not.toBe("waiting"); // hand falls: the session moved on
    await new Promise((r) => setTimeout(r, 10)); // clearMarker is fire-and-forget
    expect(fs.existsSync(path.join(waitingDir, `${ext}.json`))).toBe(false);
  });

  it("holds the hand when a sub-agent is blocked on its own permission (its file frozen too)", async () => {
    // The mirror case: the sub-agent itself is parked on a prompt, so neither the
    // parent NOR the sub-agent file is advancing. A marker newer than both must keep
    // the hand up — folding in sub-agent activity must not mask a real pending prompt.
    const store = newStore();
    const disc = discovery(store, { [wt]: 1 });
    const ext = writeSession(wt, 30);
    writeSubagent(ext, 20); // sub-agent also quiet (blocked)
    writeMarker(ext, "Claude needs your permission to read files", 5); // fresh, past all activity

    await disc.refresh();

    const a = store.list()[0];
    expect(a.state).toBe("waiting");
    expect(a.question).toBe("Claude needs your permission to read files");
  });

  it("keeps a dev in place across /clear, rebinding the new session to it", async () => {
    // a dev is launched and adopts its session
    const store = newStore();
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 1]]), sessionIds: new Set<string>() };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, liveCounts: async () => liveSnapshot,
    });
    placeholder(store, "isle-a1", wt);
    const u1 = randomUUID();
    disc.expectSession("isle-a1", u1);
    liveSnapshot = { mode: "perCwd", counts: new Map([[wt, 1]]), sessionIds: new Set([u1]) };
    writeSession(wt, 0, u1);
    await disc.refresh();
    expect(store.get("isle-a1")!.transcriptPath).toBe(path.join(proj, `${u1}.jsonl`));

    // user runs /clear: old session retired, NEW uuid minted (no link back), and
    // the SessionStart(clear) hook leaves a succession marker for the new uuid.
    const u2 = randomUUID();
    writeSuccession(u2, wt);
    liveSnapshot = { mode: "perCwd", counts: new Map([[wt, 1]]), sessionIds: new Set([u2]) };
    writeSession(wt, 0, u2);
    await disc.refresh();

    // SAME dev, now driving the new session — not culled, no stranger spawned
    const all = store.list();
    expect(all).toHaveLength(1);
    const a = store.get("isle-a1")!;
    expect(a.transcriptPath).toBe(path.join(proj, `${u2}.jsonl`));
    expect(a.external).toBeFalsy();
    expect(a.name).toBe("isle-a1");
    // marker consumed once rebound
    await new Promise((r) => setTimeout(r, 10)); // unlink is fire-and-forget
    expect(fs.existsSync(path.join(succDir, `${u2}.json`))).toBe(false);
  });

  it("resume picker: binds the resumed foreign session to the waiting placeholder (no twin, no orphan)", async () => {
    // a dev is spawned in worktree wt: `claude --session-id <launchX>` launched,
    // placeholder waiting on launchX. The operator then picks a DIFFERENT,
    // pre-existing session (uuidY, originally from another branch wt2) from
    // Claude's resume picker. The SessionStart(resume) hook leaves a marker
    // linking uuidY back to launchX.
    const wt2 = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-wt2-"));
    try {
      const store = newStore();
      const launchX = randomUUID();
      // the resuming claude runs with --session-id launchX; its transcript is uuidY
      const liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt2, 1]]), sessionIds: new Set([launchX]) };
      const disc = new ClaudeDiscovery(store, {
        projectsRoot: root, waitingDir, successionDir: succDir, resumeDir, liveCounts: async () => liveSnapshot,
      });
      placeholder(store, "isle-a1", wt);
      disc.expectSession("isle-a1", launchX);
      const uuidY = randomUUID();
      writeSession(wt2, 0, uuidY); // resumed transcript reports its original branch
      writeResume(uuidY, launchX);

      await disc.refresh();

      // exactly one agent: the placeholder, now driving the resumed session in place
      const all = store.list();
      expect(all).toHaveLength(1);
      const a = store.get("isle-a1")!;
      expect(a.transcriptPath).toBe(path.join(proj, `${uuidY}.jsonl`));
      expect(a.external).toBeFalsy(); // adopted into the dev, not a stranger
      expect(a.worktree).toBe(wt); // stays in the room the operator dropped it into
      expect(store.get("cc-" + uuidY.slice(0, 8))).toBeUndefined(); // no twin
      // marker consumed once bound
      await new Promise((r) => setTimeout(r, 10));
      expect(fs.existsSync(path.join(resumeDir, `${uuidY}.json`))).toBe(false);
    } finally {
      fs.rmSync(wt2, { recursive: true, force: true });
    }
  });

  it("resume picker: culls a twin that already surfaced before the redirect was applied", async () => {
    // a poll lands AFTER the resumed session is on disk but BEFORE the resume
    // marker is read: it surfaces as an external twin in its own branch while the
    // placeholder still waits. The next poll (marker present) must fold them into
    // one dev — twin gone, placeholder bound.
    const wt2 = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-wt2-"));
    try {
      const store = newStore();
      const launchX = randomUUID();
      const liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt2, 1]]), sessionIds: new Set([launchX]) };
      const disc = new ClaudeDiscovery(store, {
        projectsRoot: root, waitingDir, successionDir: succDir, resumeDir, liveCounts: async () => liveSnapshot,
      });
      placeholder(store, "isle-a1", wt);
      disc.expectSession("isle-a1", launchX);
      const uuidY = randomUUID();
      writeSession(wt2, 0, uuidY);

      // poll 1: no marker yet → twin appears beside the still-waiting placeholder
      await disc.refresh();
      expect(store.list()).toHaveLength(2);
      expect(store.get("cc-" + uuidY.slice(0, 8))!.external).toBe(true);
      expect(store.get("isle-a1")!.transcriptPath).toBeUndefined();

      // poll 2: marker present → twin culled, placeholder adopts the session
      writeResume(uuidY, launchX);
      await disc.refresh();

      const all = store.list();
      expect(all).toHaveLength(1);
      const a = store.get("isle-a1")!;
      expect(a.transcriptPath).toBe(path.join(proj, `${uuidY}.jsonl`));
      expect(a.external).toBeFalsy();
      expect(store.get("cc-" + uuidY.slice(0, 8))).toBeUndefined();
    } finally {
      fs.rmSync(wt2, { recursive: true, force: true });
    }
  });

  it("parks the cleared dev for the poll that lands in the gap before its successor surfaces", async () => {
    // the marker exists but the new transcript hasn't been written yet (a poll
    // landing in the sub-second gap). The dev must NOT be culled — it waits.
    const store = newStore();
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 1]]), sessionIds: new Set<string>() };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, liveCounts: async () => liveSnapshot,
    });
    placeholder(store, "isle-a1", wt);
    const u1 = randomUUID();
    disc.expectSession("isle-a1", u1);
    liveSnapshot = { mode: "perCwd", counts: new Map([[wt, 1]]), sessionIds: new Set([u1]) };
    writeSession(wt, 0, u1);
    await disc.refresh();

    // /clear fired (marker dropped) but the successor transcript isn't on disk yet,
    // and the old session's process is already gone → nothing live this poll.
    const u2 = randomUUID();
    writeSuccession(u2, wt);
    liveSnapshot = { mode: "perCwd", counts: new Map([[wt, 0]]), sessionIds: new Set<string>() };
    await disc.refresh();
    expect(store.get("isle-a1")).toBeDefined(); // parked, not culled

    // next poll: the successor is live → it rebinds to the same dev
    liveSnapshot = { mode: "perCwd", counts: new Map([[wt, 1]]), sessionIds: new Set([u2]) };
    writeSession(wt, 0, u2);
    await disc.refresh();
    expect(store.list()).toHaveLength(1);
    expect(store.get("isle-a1")!.transcriptPath).toBe(path.join(proj, `${u2}.jsonl`));
  });

  it("keeps an EXTERNAL session in place across /clear and flags the shred trip", async () => {
    // an outside terminal session started with --session-id (its launch id == its
    // first transcript uuid). /clear must keep the SAME ghost dev, stay external,
    // and signal the scene to run the shredder walk — not surface a stranger.
    const sid = (u: string) => "cc-" + u.slice(0, 8);
    const store = newStore();
    const u1 = randomUUID();
    // the process's argv --session-id is u1 and stays u1 across clears
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 1]]), sessionIds: new Set([u1]) };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, liveCounts: async () => liveSnapshot,
    });
    writeSession(wt, 0, u1);
    await disc.refresh();
    expect(store.get(sid(u1))!.external).toBe(true);
    expect(store.get(sid(u1))!.launchId).toBe(u1); // launch id captured

    // /clear: u2 minted, marker carries the terminal's launch id u1. The argv is
    // still u1 (unchanged across /clear), so PASS 1 must pin u2, not stale u1.
    const u2 = randomUUID();
    writeSession(wt, 0, u2);
    writeSuccession(u2, wt, u1);
    await disc.refresh();

    const all = store.list();
    expect(all).toHaveLength(1); // same dev, no stranger
    const a = store.get(sid(u1))!;
    expect(a.transcriptPath).toBe(path.join(proj, `${u2}.jsonl`));
    expect(a.external).toBe(true); // still an outside session
    expect(a.clearedSession).toBe(u2); // → scene runs the shred trip
    await new Promise((r) => setTimeout(r, 10)); // unlink is fire-and-forget
    expect(fs.existsSync(path.join(succDir, `${u2}.json`))).toBe(false); // marker consumed
  });

  it("rebinds across /clear by launch id even when the cleared session was newer than a live sibling", async () => {
    // the pile-up shape: the cleared session (u1) is NEWER by mtime than a still
    // idle sibling (uSib), so neither budget nor mtime can tell which one cleared.
    // The marker's launch id makes it deterministic: u1's terminal continues as u3.
    const sid = (u: string) => "cc-" + u.slice(0, 8);
    const store = newStore();
    const uSib = randomUUID(), u1 = randomUUID();
    // both started with --session-id; their argv launch ids are uSib and u1
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 2]]), sessionIds: new Set([uSib, u1]) };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, liveCounts: async () => liveSnapshot,
    });
    writeSession(wt, 100, uSib); // idle sibling (older)
    writeSession(wt, 50, u1); // the session that will be cleared (newer)
    await disc.refresh();
    expect(new Set(store.list().map((x) => x.id))).toEqual(new Set([sid(uSib), sid(u1)]));

    // /clear u1 → u3. argv launch ids are unchanged ({uSib, u1}); marker.launchId = u1.
    const u3 = randomUUID();
    writeSession(wt, 0, u3);
    writeSuccession(u3, wt, u1);
    await disc.refresh();

    const ids = new Set(store.list().map((x) => x.id));
    expect(ids).toEqual(new Set([sid(uSib), sid(u1)])); // sibling kept, u1 rebound — no sid(u3) stranger
    expect(store.get(sid(uSib))!.transcriptPath).toBe(path.join(proj, `${uSib}.jsonl`)); // sibling untouched
    const a = store.get(sid(u1))!;
    expect(a.transcriptPath).toBe(path.join(proj, `${u3}.jsonl`));
    expect(a.clearedSession).toBe(u3);
    await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(path.join(succDir, `${u3}.json`))).toBe(false);
  });

  it("rebinds /clear onto the dev that actually cleared, not a still-live sibling (no launch id)", async () => {
    // two BARE outside sessions (no --session-id, so no launch id in the marker).
    // The cleared dev's transcript freezes while the busy sibling keeps writing —
    // the sibling is rescued as live, leaving the cleared dev the LONE orphan, so
    // the successor binds to it. The live sibling must not be dragged into a swap
    // (the ghost-and-switch the user saw).
    const sid = (u: string) => "cc-" + u.slice(0, 8);
    const store = newStore();
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 2]]), sessionIds: new Set<string>() };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, liveCounts: async () => liveSnapshot,
    });
    const uClear = writeSession(wt, 30);
    const uSib = writeSession(wt, 20);
    await disc.refresh();
    expect(new Set(store.list().map((x) => x.id))).toEqual(new Set([sid(uClear), sid(uSib)]));

    // /clear on uClear → uNew. The sibling keeps writing (its mtime advances); the
    // cleared transcript freezes. Marker has no launch id (bare session).
    const uNew = randomUUID();
    writeSession(wt, 0, uNew);
    touch(uSib); // sibling still alive → rescued, stays out of the orphan set
    writeSuccession(uNew, wt);
    await disc.refresh();

    const ids = new Set(store.list().map((x) => x.id));
    expect(ids).toEqual(new Set([sid(uClear), sid(uSib)])); // no sid(uNew) stranger, no cull
    expect(store.get(sid(uSib))!.transcriptPath).toBe(path.join(proj, `${uSib}.jsonl`)); // sibling untouched
    expect(store.get(sid(uSib))!.clearedSession).toBeUndefined(); // sibling did NOT shred
    const cleared = store.get(sid(uClear))!;
    expect(cleared.transcriptPath).toBe(path.join(proj, `${uNew}.jsonl`)); // the cleared dev advanced
    expect(cleared.clearedSession).toBe(uNew); // and it is the one that shreds
  });

  /** Bump a transcript's mtime forward (simulates the session writing again). */
  const touch = (uuid: string, inSec = 5) => {
    const t = Date.now() / 1000 + inSec;
    fs.utimesSync(path.join(proj, `${uuid}.jsonl`), t, t);
  };

  it("does not cull a still-writing external ghost when the per-cwd process count flaps", async () => {
    // two plain outside sessions (no --session-id to pin them) share one cwd. The
    // process scan momentarily under-reports (2 → 1), but BOTH transcripts are
    // still being written — neither may be culled, or they thrash out/in each poll
    // and surface as duplicate ghosts during the leave/spawn overlap.
    const sid = (u: string) => "cc-" + u.slice(0, 8);
    const store = newStore();
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 2]]), sessionIds: new Set<string>() };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, liveCounts: async () => liveSnapshot,
    });
    const u1 = writeSession(wt, 0);
    const u2 = writeSession(wt, 0);
    await disc.refresh();
    expect(new Set(store.list().map((a) => a.id))).toEqual(new Set([sid(u1), sid(u2)]));

    // both keep writing (mtime advances) while the count dips to 1
    touch(u1); touch(u2);
    liveSnapshot = { mode: "perCwd", counts: new Map([[wt, 1]]), sessionIds: new Set<string>() };
    await disc.refresh();
    expect(new Set(store.list().map((a) => a.id))).toEqual(new Set([sid(u1), sid(u2)]));
  });

  it("still drops a plain external session that actually exits (its transcript freezes)", async () => {
    // same two-ghost setup, but this time u2 genuinely exits: the count drops to 1
    // and only u1's transcript advances. u2 is frozen, so it must leave (the rescue
    // only protects sessions proven alive by a fresh write, not the exited one).
    const sid = (u: string) => "cc-" + u.slice(0, 8);
    const store = newStore();
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 2]]), sessionIds: new Set<string>() };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, liveCounts: async () => liveSnapshot,
    });
    const u1 = writeSession(wt, 0);
    const u2 = writeSession(wt, 0);
    await disc.refresh();
    expect(new Set(store.list().map((a) => a.id))).toEqual(new Set([sid(u1), sid(u2)]));

    touch(u1); // only u1 lives on
    liveSnapshot = { mode: "perCwd", counts: new Map([[wt, 1]]), sessionIds: new Set<string>() };
    await disc.refresh();
    const ids = new Set(store.list().map((a) => a.id));
    expect(ids).toEqual(new Set([sid(u1)]));
    expect(ids.has(sid(u2))).toBe(false);
  });

  it("still shows a genuine outside session (no placeholder) as external", async () => {
    const store = newStore();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-other-"));
    try {
      const disc = discovery(store, { [other]: 1 });
      writeSession(other, 0);

      await disc.refresh();

      const all = store.list();
      expect(all).toHaveLength(1);
      expect(all[0].external).toBe(true);
      expect(all[0].transcriptPath).toBeTruthy();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
