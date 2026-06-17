import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readWaitingMarkers, clearMarker, readSuccessionMarkers, clearSuccessionMarker, readEditMarkers, readSkillMarkers, readCommandMarkers, clearCommandMarker } from "../src/hooks";

/**
 * The Notification hook drops one marker per parked session; readWaitingMarkers
 * is what the tower polls to raise hands. Covers the happy read, pruning of
 * markers whose session is long gone, and clearMarker (called once a session
 * resumes).
 */
describe("waiting markers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-wait-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (id: string, m: object) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(m));

  it("reads a marker keyed by session id", async () => {
    write("sess-1", { message: "Allow Write?", cwd: "/repo", ts: Date.now() });
    const markers = await readWaitingMarkers(dir);
    expect(markers.get("sess-1")).toMatchObject({ message: "Allow Write?", cwd: "/repo" });
  });

  it("prunes and deletes a marker older than the max age", async () => {
    write("ancient", { message: "old", cwd: "/repo", ts: Date.now() - 48 * 3_600_000 });
    const markers = await readWaitingMarkers(dir);
    expect(markers.has("ancient")).toBe(false);
    expect(fs.existsSync(path.join(dir, "ancient.json"))).toBe(false); // swept off disk
  });

  it("ignores a half-written / garbage marker without throwing", async () => {
    fs.writeFileSync(path.join(dir, "partial.json"), "{not json");
    const markers = await readWaitingMarkers(dir);
    expect(markers.size).toBe(0);
  });

  it("clearMarker removes the session's marker", async () => {
    write("sess-2", { message: "x", cwd: "/repo", ts: Date.now() });
    clearMarker("sess-2", dir);
    await new Promise((r) => setTimeout(r, 10)); // unlink is fire-and-forget
    expect(fs.existsSync(path.join(dir, "sess-2.json"))).toBe(false);
  });

  it("missing dir reads as empty", async () => {
    const markers = await readWaitingMarkers(path.join(dir, "nope"));
    expect(markers.size).toBe(0);
  });
});

/**
 * The UserPromptSubmit hook drops a command marker when the operator types a
 * DevTower control command (/rename or /color). Covers the happy read, pruning a
 * stale marker, rejecting an unknown command word, and clearCommandMarker.
 */
describe("command markers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-cmd-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (id: string, m: object) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(m));

  it("reads a rename and a color command keyed by session id", async () => {
    write("sess-1", { cwd: "/repo", ts: Date.now(), cmd: "rename", arg: "Ada" });
    write("sess-2", { cwd: "/repo", ts: Date.now(), cmd: "color", arg: "teal" });
    const markers = await readCommandMarkers(dir);
    expect(markers.get("sess-1")).toMatchObject({ cmd: "rename", arg: "Ada" });
    expect(markers.get("sess-2")).toMatchObject({ cmd: "color", arg: "teal" });
  });

  it("prunes a stale marker off disk", async () => {
    write("old", { cwd: "/repo", ts: Date.now() - 60 * 60_000, cmd: "rename", arg: "x" });
    const markers = await readCommandMarkers(dir);
    expect(markers.has("old")).toBe(false);
    expect(fs.existsSync(path.join(dir, "old.json"))).toBe(false);
  });

  it("drops a marker with an unknown command word", async () => {
    write("bad", { cwd: "/repo", ts: Date.now(), cmd: "explode", arg: "x" });
    const markers = await readCommandMarkers(dir);
    expect(markers.has("bad")).toBe(false);
  });

  it("clearCommandMarker removes the session's marker", async () => {
    write("sess-3", { cwd: "/repo", ts: Date.now(), cmd: "color", arg: "blue" });
    clearCommandMarker("sess-3", dir);
    await new Promise((r) => setTimeout(r, 10)); // unlink is fire-and-forget
    expect(fs.existsSync(path.join(dir, "sess-3.json"))).toBe(false);
  });
});

/**
 * The SessionStart(clear) hook drops a succession marker keyed by the NEW
 * session id so discovery can rebind the cleared dev in place. Covers the happy
 * read, pruning of a successor that never surfaced, and clearSuccessionMarker
 * (called once the new session is rebound).
 */
describe("succession markers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-succ-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (id: string, m: object) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(m));

  it("reads a marker keyed by the new session id", async () => {
    write("new-uuid", { cwd: "/repo", source: "clear", ts: Date.now() });
    const markers = await readSuccessionMarkers(dir);
    expect(markers.get("new-uuid")).toMatchObject({ cwd: "/repo", source: "clear" });
  });

  it("prunes a successor that never surfaced (older than the max age)", async () => {
    write("stale", { cwd: "/repo", source: "clear", ts: Date.now() - 30 * 60_000 });
    const markers = await readSuccessionMarkers(dir);
    expect(markers.has("stale")).toBe(false);
    expect(fs.existsSync(path.join(dir, "stale.json"))).toBe(false); // swept off disk
  });

  it("clearSuccessionMarker removes the marker", async () => {
    write("bound", { cwd: "/repo", source: "clear", ts: Date.now() });
    clearSuccessionMarker("bound", dir);
    await new Promise((r) => setTimeout(r, 10)); // unlink is fire-and-forget
    expect(fs.existsSync(path.join(dir, "bound.json"))).toBe(false);
  });

  it("missing dir reads as empty", async () => {
    const markers = await readSuccessionMarkers(path.join(dir, "nope"));
    expect(markers.size).toBe(0);
  });
});

/**
 * The PostToolUse(edit) hook drops a marker per session that touches the working
 * tree, so a git change beams from the dev that made it. readEditMarkers is what
 * discovery folds into each agent's lastEditTs. Covers the happy read (incl. the
 * tool name), pruning of a stale marker (the change was attributed long ago), and
 * the missing-dir case.
 */
describe("edit markers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-edit-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (id: string, m: object) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(m));

  it("reads a fresh marker keyed by session id, with the tool", async () => {
    write("sess-1", { cwd: "/repo", ts: Date.now(), tool: "Edit" });
    const markers = await readEditMarkers(dir);
    expect(markers.get("sess-1")).toMatchObject({ cwd: "/repo", tool: "Edit" });
  });

  it("prunes and deletes a marker older than the max age", async () => {
    write("stale", { cwd: "/repo", ts: Date.now() - 5 * 60_000 }); // > 60s window
    const markers = await readEditMarkers(dir);
    expect(markers.has("stale")).toBe(false);
    expect(fs.existsSync(path.join(dir, "stale.json"))).toBe(false); // swept off disk
  });

  it("ignores a half-written / garbage marker without throwing", async () => {
    fs.writeFileSync(path.join(dir, "partial.json"), "{nope");
    const markers = await readEditMarkers(dir);
    expect(markers.size).toBe(0);
  });

  it("missing dir reads as empty", async () => {
    const markers = await readEditMarkers(path.join(dir, "nope"));
    expect(markers.size).toBe(0);
  });
});

/**
 * The PreToolUse(Skill) hook drops a marker the instant a session loads a skill,
 * purely to wake a refresh (the Skill tool drops no other marker). readSkillMarkers
 * is read each poll to fold its ts into activity time and to prune the markers a
 * Skill burst leaves behind. Covers the happy read (incl. the skill name), pruning
 * of a stale marker, garbage tolerance, and the missing-dir case.
 */
describe("skill markers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-skill-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (id: string, m: object) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(m));

  it("reads a fresh marker keyed by session id, with the skill", async () => {
    write("sess-1", { cwd: "/repo", ts: Date.now(), skill: "release" });
    const markers = await readSkillMarkers(dir);
    expect(markers.get("sess-1")).toMatchObject({ cwd: "/repo", skill: "release" });
  });

  it("prunes and deletes a marker older than the max age", async () => {
    write("stale", { cwd: "/repo", ts: Date.now() - 5 * 60_000, skill: "release" }); // > 60s window
    const markers = await readSkillMarkers(dir);
    expect(markers.has("stale")).toBe(false);
    expect(fs.existsSync(path.join(dir, "stale.json"))).toBe(false); // swept off disk
  });

  it("ignores a half-written / garbage marker without throwing", async () => {
    fs.writeFileSync(path.join(dir, "partial.json"), "{nope");
    const markers = await readSkillMarkers(dir);
    expect(markers.size).toBe(0);
  });

  it("missing dir reads as empty", async () => {
    const markers = await readSkillMarkers(path.join(dir, "nope"));
    expect(markers.size).toBe(0);
  });
});
