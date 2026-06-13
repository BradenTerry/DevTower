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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-disc-"));
    proj = path.join(root, "-fake-project");
    fs.mkdirSync(proj);
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-wt-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

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

  /** A perCwd liveness stub: every listed dir reports `n` running claude procs. */
  const live = (counts: Record<string, number>) => async () =>
    ({ mode: "perCwd" as const, counts: new Map(Object.entries(counts)) });

  /** Stand up a discovery wired to the fake tree + a liveness stub. */
  const discovery = (store: DevTowerStore, counts: Record<string, number>) =>
    new ClaudeDiscovery(store, { projectsRoot: root, liveCounts: live(counts) });

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
