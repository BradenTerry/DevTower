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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-disc-"));
    proj = path.join(root, "-fake-project");
    fs.mkdirSync(proj);
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-wt-"));
    waitingDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-wait-"));
    succDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-succ-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(waitingDir, { recursive: true, force: true });
    fs.rmSync(succDir, { recursive: true, force: true });
  });

  /** Drop a SessionStart(clear) succession marker for the new session uuid. */
  const writeSuccession = (uuid: string, cwd = wt) =>
    fs.writeFileSync(
      path.join(succDir, `${uuid}.json`),
      JSON.stringify({ cwd, source: "clear", ts: Date.now() })
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
