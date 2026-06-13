import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readWaitingMarkers, clearMarker, readSuccessionMarkers, clearSuccessionMarker } from "../src/hooks";

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
