import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { ClaudeDiscovery } from "../src/claude";
import { DevTowerStore, resolveShirtColor } from "../src/store";

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
  let activeDir: string; // fake ~/.claude/devtower/active
  let histFile: string; // fake ~/.claude/history.jsonl

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-disc-"));
    proj = path.join(root, "-fake-project");
    fs.mkdirSync(proj);
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-wt-"));
    waitingDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-wait-"));
    succDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-succ-"));
    resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-resume-"));
    endedDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-ended-"));
    activeDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-active-"));
    histFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "devtower-hist-")), "history.jsonl");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(waitingDir, { recursive: true, force: true });
    fs.rmSync(succDir, { recursive: true, force: true });
    fs.rmSync(resumeDir, { recursive: true, force: true });
    fs.rmSync(endedDir, { recursive: true, force: true });
    fs.rmSync(activeDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(histFile), { recursive: true, force: true });
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

  /** Drop a SessionStart(resume) activity marker: a just-reopened session that
   *  hasn't written to its transcript yet. `tsOffsetSec` relative to now. */
  const writeActive = (uuid: string, cwd = wt, tsOffsetSec = 0) =>
    fs.writeFileSync(
      path.join(activeDir, `${uuid}.json`),
      JSON.stringify({ cwd, ts: Date.now() + tsOffsetSec * 1000 })
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
      activeDir,
      historyFile: histFile,
    });

  /** Append a built-in /rename or /color to the fake global history.jsonl, the
   *  one signal those host-consumed commands leave behind. */
  const appendHistory = (uuid: string, display: string, project = wt) =>
    fs.appendFileSync(
      histFile,
      JSON.stringify({ display, pastedContents: {}, timestamp: Date.now(), project, sessionId: uuid }) + "\n"
    );

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

  it("a placeholder awaiting its pinned session does NOT adopt a stranger in the same worktree (ghost-on-spawn)", async () => {
    // The bug the debug logs surfaced: a +DEV placeholder launched with a pinned
    // --session-id, but a DIFFERENT (ambient/external) session in the same cwd
    // wrote its transcript FIRST. The worktree heuristic grabbed that stranger,
    // stranding the placeholder's real launched session as an external ghost.
    // The placeholder must wait for case-1 (its exact id) instead.
    const store = newStore();
    const stranger = randomUUID(); // an outside session already live in the cwd
    const pinned = randomUUID(); // the session DevTower launched for the placeholder
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 2]]) };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, resumeDir, endedDir,
      liveCounts: async () => liveSnapshot,
    });
    placeholder(store, "isle-a1", wt);
    disc.expectSession("isle-a1", pinned);

    // poll 1: only the stranger is on disk (and freshest, so the old heuristic
    // would have taken it). The placeholder must stay unbound; the stranger is
    // its own external agent — NOT adopted into the placeholder.
    writeSession(wt, 0, stranger);
    await disc.refresh();
    const sid = (u: string) => "cc-" + u.slice(0, 8);
    expect(new Set(store.list().map((a) => a.id))).toEqual(new Set(["isle-a1", sid(stranger)]));
    expect(store.get("isle-a1")!.transcriptPath).toBeUndefined(); // still waiting
    expect(store.get("isle-a1")!.external).toBeFalsy();
    expect(store.get(sid(stranger))!.external).toBe(true); // stays an outside session

    // poll 2: the pinned session finally lands → case-1 binds it to the
    // placeholder; the stranger remains a separate external agent.
    writeSession(wt, 0, pinned);
    await disc.refresh();
    expect(store.get("isle-a1")!.transcriptPath).toBe(path.join(proj, `${pinned}.jsonl`));
    expect(store.get("isle-a1")!.external).toBeFalsy();
    expect(store.get(sid(stranger))!.external).toBe(true);
    expect(store.list()).toHaveLength(2); // placeholder (now owned) + the stranger
  });

  it("after /clear, the stale launch transcript does not resurface as a ghost once its marker is consumed", async () => {
    // The bug the logs surfaced: a dev /clears (launch L → successor C, rebound via
    // the succession MARKER). The marker is consumed on that poll. On the NEXT poll
    // the remap is gone, so L (still live by argv) re-steals the cwd slot from C —
    // C is dropped, the dev is culled, and L resurfaces as an external ghost. The
    // launch→current tie must be reconstructed from the bound agent, surviving the
    // marker.
    const store = newStore();
    const launch = randomUUID(); // the terminal's --session-id, stable across /clear
    const succ = randomUUID(); // the new transcript /clear minted
    const sid = (u: string) => "cc-" + u.slice(0, 8);
    // argv keeps reporting the LAUNCH id across /clear; one live process in the cwd
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 1]]), sessionIds: new Set([launch]) };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, resumeDir, endedDir,
      liveCounts: async () => liveSnapshot,
    });

    // poll 1: placeholder binds its pinned launch session
    placeholder(store, "isle-a1", wt);
    disc.expectSession("isle-a1", launch);
    writeSession(wt, 0, launch);
    await disc.refresh();
    expect(store.get("isle-a1")!.transcriptPath).toBe(path.join(proj, `${launch}.jsonl`));

    // poll 2: /clear → succession marker rebinds the new session C onto the dev
    writeSuccession(succ, wt, launch);
    writeSession(wt, 0, succ);
    await disc.refresh();
    expect(store.get("isle-a1")!.transcriptPath).toBe(path.join(proj, `${succ}.jsonl`));
    expect(store.get("isle-a1")!.external).toBeFalsy();

    // poll 3: marker is gone, but BOTH transcripts remain on disk and argv still
    // reports the launch id. The dev must stay bound to C; the stale launch
    // transcript must NOT resurface as a ghost.
    await disc.refresh();
    const a = store.get("isle-a1")!;
    expect(a.transcriptPath).toBe(path.join(proj, `${succ}.jsonl`));
    expect(a.external).toBeFalsy();
    expect(store.get(sid(launch))).toBeUndefined(); // no ghost for the dead launch transcript
    expect(store.list()).toHaveLength(1); // just the one dev, no twin
  });

  it("a placeholder /clear'd before its first prompt adopts the successor, no ghost (/clear-before-first-prompt)", async () => {
    // The reported bug: spawn a dev (`claude --session-id <launch>`) and /clear it
    // before ever prompting. The pinned launch session never writes a transcript;
    // its successor C is minted with a fresh uuid and a succession marker carrying
    // the launch id. case-1 only matched the pinned uuid exactly, so the placeholder
    // waited forever and C surfaced as an external ghost. It must instead recognize
    // C as the placeholder's session via the launch id the marker carries.
    const store = newStore();
    const launch = randomUUID(); // the terminal's --session-id (stays in argv across /clear)
    const succ = randomUUID(); // the uuid /clear minted; the launch session wrote nothing
    const sid = (u: string) => "cc-" + u.slice(0, 8);
    // one live process in the cwd; argv reports the launch id, never the pinned
    // transcript (it never existed)
    const liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 1]]), sessionIds: new Set([launch]) };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, resumeDir, endedDir,
      liveCounts: async () => liveSnapshot,
    });
    placeholder(store, "isle-a1", wt);
    disc.expectSession("isle-a1", launch); // launched `claude --session-id <launch>`

    // /clear before the first prompt: only the successor C is on disk, with a
    // succession marker tying it back to the launch id. The launch transcript
    // never appears.
    writeSuccession(succ, wt, launch);
    writeSession(wt, 0, succ);
    await disc.refresh();

    // the placeholder adopts C in place: owned, no external twin, no ghost
    expect(store.list()).toHaveLength(1);
    const a = store.get("isle-a1")!;
    expect(a.transcriptPath).toBe(path.join(proj, `${succ}.jsonl`));
    expect(a.external).toBeFalsy();
    expect(a.name).toBe("isle-a1");
    expect(store.get(sid(succ))).toBeUndefined(); // C never surfaced as a stranger
    // marker consumed, expectation cleared
    await new Promise((r) => setTimeout(r, 10)); // unlink is fire-and-forget
    expect(fs.existsSync(path.join(succDir, `${succ}.json`))).toBe(false);

    // a SECOND /clear now flows through the normal succession path (the dev has a
    // launch id), staying in place — no regression
    const succ2 = randomUUID();
    writeSuccession(succ2, wt, launch);
    writeSession(wt, 0, succ2);
    await disc.refresh();
    expect(store.list()).toHaveLength(1);
    expect(store.get("isle-a1")!.transcriptPath).toBe(path.join(proj, `${succ2}.jsonl`));
    expect(store.get("isle-a1")!.external).toBeFalsy();
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

  it("shows complete (a green check), not a raised hand, for the idle 'waiting for input' ping", async () => {
    // The Notification hook fires for BOTH a permission prompt and the idle ping.
    // The idle ping just means the turn ended with nothing pending — a finished
    // task, not a question — so it must read complete, never waiting.
    const store = newStore();
    const disc = discovery(store, { [wt]: 1 });
    const ext = writeSession(wt, 0);
    writeMarker(ext, "Claude is waiting for your input"); // fresh, past the mtime

    await disc.refresh();

    const a = store.list()[0];
    expect(a.state).toBe("complete");
    expect(a.question).toBeUndefined(); // no question to answer
  });

  it("raises the hand when the turn asks a question then trails it with elaboration", async () => {
    // The idle ping fires (turn ended), but the assistant's last paragraph posed
    // a question followed by a long clause of detail after the "?". A short tail
    // window misses it and wrongly shows complete; it must read as waiting.
    const uuid = randomUUID();
    const file = path.join(proj, `${uuid}.jsonl`);
    const text =
      "Two ways forward.\n\n" +
      "Want me to do option 1? I'd rename the operator command to /shirt <colour> " +
      "(keeping /rename as-is) and wire it through the four spots above.";
    fs.writeFileSync(file,
      JSON.stringify({ type: "user", cwd: wt, message: { role: "user", content: "fix it" } }) + "\n" +
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: text } }) + "\n");
    writeMarker(uuid, "Claude is waiting for your input"); // idle ping, fresh

    const store = newStore();
    await discovery(store, { [wt]: 1 }, [uuid]).refresh();

    const a = store.get("cc-" + uuid.slice(0, 8))!;
    expect(a.state).toBe("waiting");
    expect(a.question).toBe("Want me to do option 1?");
  });

  it("a just-resumed session reads active even before it writes to its transcript", async () => {
    // A finished session: it last spoke a STATEMENT and went quiet for minutes, so
    // on its own it reads idle. Reopening it (SessionStart resume) writes nothing
    // to the transcript until the first prompt, so the activity marker is the only
    // signal it came back — without folding it in, a resumed dev shows idle while
    // you read/type. The transcript ends on an assistant statement so the baseline
    // is genuinely idle (not "working" or "waiting").
    const uuid = randomUUID();
    const file = path.join(proj, `${uuid}.jsonl`);
    fs.writeFileSync(file,
      JSON.stringify({ type: "user", cwd: wt, message: { role: "user", content: "ship it" } }) + "\n" +
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Done, pushed." } }) + "\n");
    const quiet = Date.now() / 1000 - 300; // 5 min since the last write
    fs.utimesSync(file, quiet, quiet);
    const id = "cc-" + uuid.slice(0, 8);

    // baseline: silent finished session, no resume marker → idle
    const store1 = newStore();
    await discovery(store1, { [wt]: 1 }, [uuid]).refresh();
    expect(store1.get(id)?.state).toBe("idle");

    // resume drops a fresh activity marker → reads active despite the stale mtime
    writeActive(uuid);
    const store2 = newStore();
    await discovery(store2, { [wt]: 1 }, [uuid]).refresh();
    expect(store2.get(id)?.state).toBe("active");
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

  it("flags the shred trip on a /clear BEFORE the new session's first prompt (no successor transcript yet)", async () => {
    // /clear right after a task, before typing anything: the brand-new session
    // writes no transcript, so the succession bind can't fire. The marker (keyed by
    // the new uuid, carrying the terminal's launch id) is enough to know the dev
    // cleared — bump clearedSession now so the scene runs the trip instead of the
    // dev sitting reading its book forever until the next prompt.
    const sid = (u: string) => "cc-" + u.slice(0, 8);
    const store = newStore();
    const u1 = randomUUID();
    // argv --session-id is u1 and stays u1 across the clear
    let liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 1]]), sessionIds: new Set([u1]) };
    const disc = new ClaudeDiscovery(store, {
      projectsRoot: root, waitingDir, successionDir: succDir, liveCounts: async () => liveSnapshot,
    });
    writeSession(wt, 0, u1);
    await disc.refresh();
    expect(store.get(sid(u1))!.launchId).toBe(u1);
    expect(store.get(sid(u1))!.clearedSession).toBeUndefined();

    // /clear → u2 minted, but NO transcript for it yet (session not prompted). Only
    // the marker lands, carrying launch id u1.
    const u2 = randomUUID();
    writeSuccession(u2, wt, u1);
    await disc.refresh();

    expect(store.list()).toHaveLength(1); // same dev, no stranger, not culled
    expect(store.get(sid(u1))!.clearedSession).toBe(u2); // → scene runs the trip now
    // the marker is NOT consumed — it must persist so the real bind still fires once
    // the successor's transcript finally lands
    expect(fs.existsSync(path.join(succDir, `${u2}.json`))).toBe(true);

    // the successor's transcript finally appears (operator prompted it). The real
    // succession bind resolves to the SAME id, so clearedSession is unchanged.
    writeSession(wt, 0, u2);
    liveSnapshot = { mode: "perCwd" as const, counts: new Map([[wt, 1]]), sessionIds: new Set([u1]) };
    await disc.refresh();
    expect(store.get(sid(u1))!.clearedSession).toBe(u2); // unchanged → trip not replayed
    expect(store.get(sid(u1))!.transcriptPath).toBe(path.join(proj, `${u2}.jsonl`));
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

  // ---- owned-launch persistence: survive a window reload without ghosting ----

  /** An in-memory stand-in for context.workspaceState, JSON-cloned on write so a
   *  later mutation of the stored object can't leak (mirrors VS Code serializing). */
  const fakePersist = () => {
    const m = new Map<string, unknown>();
    return {
      get: <T,>(k: string, def: T): T => (m.has(k) ? (JSON.parse(JSON.stringify(m.get(k))) as T) : def),
      set: (k: string, v: unknown) => void m.set(k, JSON.parse(JSON.stringify(v))),
    };
  };

  /** discovery wired to the fake tree AND a persistence sink. */
  const discoveryP = (store: DevTowerStore, counts: Record<string, number>, persist: ReturnType<typeof fakePersist>) =>
    new ClaudeDiscovery(store, {
      projectsRoot: root, liveCounts: live(counts), waitingDir,
      successionDir: succDir, resumeDir, endedDir, persist,
    });

  it("a window reload re-adopts a launched dev as OWNED, not an external ghost", async () => {
    const persist = fakePersist();
    const uuid = randomUUID();

    // session 1: launch a dev and bind it owned
    const store1 = newStore();
    const disc1 = discoveryP(store1, { [wt]: 1 }, persist);
    placeholder(store1, "isle-a1", wt);
    disc1.expectSession("isle-a1", uuid);
    writeSession(wt, 0, uuid);
    await disc1.refresh();
    expect(store1.get("isle-a1")!.external).toBeFalsy();

    // RELOAD: a fresh store + discovery (every in-memory tie wiped) sharing the
    // persisted launches. Without restore() the lingering transcript would
    // rediscover as cc-<uuid> external — the ghost. With it, the dev rebinds owned.
    const store2 = newStore();
    const disc2 = discoveryP(store2, { [wt]: 1 }, persist);
    disc2.restore();
    await disc2.refresh();

    const ghost = "cc-" + uuid.slice(0, 8);
    expect(store2.get(ghost)).toBeUndefined(); // no external twin
    const a = store2.get("isle-a1")!;
    expect(a).toBeTruthy();
    expect(a.external).toBeFalsy(); // owned, not a ghost
    expect(a.transcriptPath).toBe(path.join(proj, `${uuid}.jsonl`));
    expect(store2.list()).toHaveLength(1);
  });

  it("retiring an owned dev (terminal closed) suppresses its transcript — no ghost, even across a reload", async () => {
    const persist = fakePersist();
    const uuid = randomUUID();

    const store1 = newStore();
    const disc1 = discoveryP(store1, { [wt]: 1 }, persist);
    placeholder(store1, "isle-a1", wt);
    disc1.expectSession("isle-a1", uuid);
    writeSession(wt, 0, uuid);
    await disc1.refresh();
    expect(store1.get("isle-a1")).toBeTruthy();

    // the operator closes the terminal → retire the owned dev. Its transcript
    // lingers on disk but must not resurface as an external ghost on the next poll.
    disc1.retireOwned("isle-a1");
    expect(store1.get("isle-a1")).toBeUndefined();
    await disc1.refresh();
    expect(store1.list()).toHaveLength(0); // no cc-<uuid> ghost

    // RELOAD: the retirement must persist, so the lingering transcript stays
    // suppressed and the dev is NOT restored as a placeholder.
    const store2 = newStore();
    const disc2 = discoveryP(store2, { [wt]: 1 }, persist);
    disc2.restore();
    await disc2.refresh();
    expect(store2.list()).toHaveLength(0);
  });

  it("mirrors the BUILT-IN /rename and /color from history.jsonl onto the bound dev", async () => {
    // The host consumes these before any hook runs, so they only surface in
    // ~/.claude/history.jsonl. DevTower tails it and mirrors them onto the dev.
    const store = newStore();
    const disc = discovery(store, { [wt]: 1 });
    placeholder(store, "isle-a1", wt);
    const uuid = randomUUID();
    disc.expectSession("isle-a1", uuid);
    writeSession(wt, 0, uuid);

    // a (valid) /color typed BEFORE DevTower started watching must NOT replay
    appendHistory(uuid, "/color green");
    await disc.refresh(); // binds the session AND seeks history to EOF
    expect(store.get("isle-a1")!.shirtColor).toBeUndefined();

    const renamed: { id: string; name: string }[] = [];
    disc.onRenamed((e) => renamed.push(e));
    appendHistory(uuid, "/rename Ada Lovelace");
    appendHistory(uuid, "/color teal"); // not a built-in colour → host rejected → ignored
    appendHistory(uuid, "/color red");
    await disc.refresh();

    expect(store.get("isle-a1")!.name).toBe("Ada Lovelace");
    expect(store.get("isle-a1")!.shirtColor).toBe(resolveShirtColor("red"));
    expect(renamed).toEqual([{ id: "isle-a1", name: "Ada Lovelace" }]);

    // the built-in's /color default resets the override back to procedural
    appendHistory(uuid, "/color default");
    await disc.refresh();
    expect(store.get("isle-a1")!.shirtColor).toBeUndefined();
  });

  it("ignores history lines for sessions DevTower does not track", async () => {
    const store = newStore();
    const disc = discovery(store, { [wt]: 1 });
    placeholder(store, "isle-a1", wt);
    const mine = randomUUID();
    disc.expectSession("isle-a1", mine);
    writeSession(wt, 0, mine);
    await disc.refresh(); // bind + seek history EOF

    appendHistory(randomUUID(), "/rename Somebody Else"); // a different, unbound session
    await disc.refresh();

    expect(store.get("isle-a1")!.name).toBe("isle-a1"); // untouched
  });
});

/**
 * The hook-driven liveness source (the production default `hookLiveCounts`, used
 * when no `liveCounts` is injected). DevTower no longer scans running processes:
 * the `started` marker dir IS the registry of live sessions, a `SessionStart`
 * drops one and a `SessionEnd` removes it. These tests exercise that path
 * directly (no liveCounts stub) so the marker → liveness wiring is covered.
 */
describe("ClaudeDiscovery hook-driven liveness (no process scan)", () => {
  let root: string, proj: string, wt: string, startedDir: string, endedDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-hl-"));
    proj = path.join(root, "-fake-project");
    fs.mkdirSync(proj);
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-hlwt-"));
    startedDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-started-"));
    endedDir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-hlended-"));
  });
  afterEach(() => {
    for (const d of [root, wt, startedDir, endedDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const newStore = () => new DevTowerStore({ subscriptions: [] } as any);
  const sid = (u: string) => "cc-" + u.slice(0, 8);

  /** Write a transcript <uuid>.jsonl reporting `cwd`, mtime `agoSec` ago. */
  const writeSession = (cwd: string, uuid = randomUUID(), agoSec = 0): string => {
    const file = path.join(proj, `${uuid}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: "user", cwd, message: { role: "user", content: "go" } }) + "\n");
    if (agoSec) {
      const t = Date.now() / 1000 - agoSec;
      fs.utimesSync(file, t, t);
    }
    return uuid;
  };
  /** Drop a SessionStart `started` (liveness) marker for `uuid`. */
  const writeStarted = (uuid: string, cwd = wt, source = "startup", launchId?: string) =>
    fs.writeFileSync(
      path.join(startedDir, `${uuid}.json`),
      JSON.stringify({ cwd, source, ts: Date.now(), ...(launchId ? { launchId } : {}) })
    );
  /** Drop a SessionEnd `ended` marker AND remove the `started` marker (what the
   *  SessionEnd hook does on a genuine exit). */
  const writeEnded = (uuid: string, cwd = wt) => {
    fs.writeFileSync(path.join(endedDir, `${uuid}.json`), JSON.stringify({ cwd, reason: "prompt_input_exit", ts: Date.now() }));
    fs.rmSync(path.join(startedDir, `${uuid}.json`), { force: true });
  };

  /** Discovery wired to the fake tree but NO liveCounts → uses hookLiveCounts. */
  const disc = (store: DevTowerStore) =>
    new ClaudeDiscovery(store, { projectsRoot: root, startedDir, endedDir });

  it("surfaces a session only once its SessionStart marker exists", async () => {
    const store = newStore();
    const d = disc(store);
    const u = writeSession(wt);

    // a transcript with NO started marker is not a live session → not surfaced
    await d.refresh();
    expect(store.list()).toHaveLength(0);

    // the SessionStart hook fires → marker drops → it surfaces (external)
    writeStarted(u);
    await d.refresh();
    expect(store.list().map((a) => a.id)).toEqual([sid(u)]);
    expect(store.get(sid(u))!.external).toBe(true);
  });

  it("retires the session when its SessionEnd marker fires (started marker removed)", async () => {
    const store = newStore();
    const d = disc(store);
    const u = writeSession(wt);
    writeStarted(u);
    await d.refresh();
    expect(store.list().map((a) => a.id)).toEqual([sid(u)]);

    // genuine exit: the transcript lingers (freshest by mtime) but the session is
    // gone — the SessionEnd marker removes its liveness, so the dev leaves.
    writeEnded(u);
    await d.refresh();
    expect(store.list()).toHaveLength(0);
  });

  it("keeps two co-located sessions live independently by their markers", async () => {
    const store = newStore();
    const d = disc(store);
    const u1 = writeSession(wt), u2 = writeSession(wt);
    writeStarted(u1);
    writeStarted(u2);
    await d.refresh();
    expect(new Set(store.list().map((a) => a.id))).toEqual(new Set([sid(u1), sid(u2)]));

    // exit only u1 → u2 stays, even though u1's transcript is equally fresh
    writeEnded(u1);
    await d.refresh();
    expect(store.list().map((a) => a.id)).toEqual([sid(u2)]);
  });

  it("supersedes a /clear predecessor by launch id (only the successor stays live)", async () => {
    const store = newStore();
    const d = disc(store);
    const launch = randomUUID();
    // launch session: started marker's launchId == its own uuid (DevTower-launched)
    writeSession(wt, launch);
    writeStarted(launch, wt, "startup", launch);
    await d.refresh();
    expect(store.list().map((a) => a.id)).toEqual([sid(launch)]);

    // /clear mints a successor under the SAME launch id; SessionEnd(reason=clear)
    // does NOT fire, so the predecessor's started marker lingers — the newest
    // marker per launch id must win, dropping the dead launch transcript.
    const succ = writeSession(wt);
    writeStarted(succ, wt, "clear", launch);
    await d.refresh();

    const ids = new Set(store.list().map((a) => a.id));
    expect(ids.has(sid(succ))).toBe(true); // successor is live
    expect(ids.has(sid(launch))).toBe(false); // dead launch transcript gone
    // the superseded predecessor marker was swept from the registry
    await new Promise((r) => setTimeout(r, 10)); // clearStartMarker is fire-and-forget
    expect(fs.existsSync(path.join(startedDir, `${launch}.json`))).toBe(false);
  });

  // ---- searchActive: the HUD ⟳ button / startup transcript sweep -------------

  it("searchActive surfaces a recently-active session with no SessionStart marker", async () => {
    const store = newStore();
    const d = disc(store);
    const u = writeSession(wt, randomUUID(), 30); // active 30s ago, NO started marker

    // a plain refresh ignores it (no hook said it's live)
    await d.refresh();
    expect(store.list()).toHaveLength(0);

    // the ⟳ button / startup search sweeps it up as a live (external) agent
    await d.searchActive();
    expect(store.list().map((a) => a.id)).toEqual([sid(u)]);
    expect(store.get(sid(u))!.external).toBe(true);
  });

  it("searchActive ignores a session whose transcript is past the active window", async () => {
    const store = newStore();
    const d = disc(store);
    writeSession(wt, randomUUID(), 30 * 60); // 30 min stale → not active

    await d.searchActive();
    expect(store.list()).toHaveLength(0);
  });

  it("a searchActive-discovered session persists across a later plain refresh", async () => {
    const store = newStore();
    const d = disc(store);
    const u = writeSession(wt, randomUUID(), 5);
    await d.searchActive();
    expect(store.list().map((a) => a.id)).toEqual([sid(u)]);

    // a subsequent hook-driven refresh (e.g. a marker elsewhere woke it) keeps the
    // discovered session — scanLive is unioned into liveness on every refresh.
    await d.refresh();
    expect(store.list().map((a) => a.id)).toEqual([sid(u)]);
  });

  it("searchActive forgets a discovered session once it goes idle past the window", async () => {
    const store = newStore();
    const d = disc(store);
    const u = writeSession(wt, randomUUID(), 5);
    await d.searchActive();
    expect(store.list().map((a) => a.id)).toEqual([sid(u)]);

    // its transcript goes quiet (now older than the window); a fresh search drops it
    const stale = Date.now() / 1000 - 30 * 60;
    fs.utimesSync(path.join(proj, `${u}.jsonl`), stale, stale);
    await d.searchActive();
    expect(store.list()).toHaveLength(0);
  });
});
