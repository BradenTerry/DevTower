import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendRotating,
  __resetRowCounts,
  MAX_LOG_ROWS,
  MAX_LOG_ARCHIVES,
} from "../src/debugLog";

// Exercises the numbered log rotation directly against real temp files. The
// in-memory row counter is reset before each test so every case starts from a
// clean "fresh session" state.

let dir: string;
let log: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-log-"));
  log = path.join(dir, "debug.log");
  __resetRowCounts();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const linesOf = (p: string) =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean) : [];

describe("appendRotating", () => {
  it("does not rotate before the row cap is reached", () => {
    for (let i = 0; i < MAX_LOG_ROWS; i++) appendRotating(log, `line ${i}`);
    expect(linesOf(log)).toHaveLength(MAX_LOG_ROWS);
    expect(fs.existsSync(`${log}.1`)).toBe(false);
  });

  it("archives the active file to .1 once the cap is exceeded", () => {
    for (let i = 0; i < MAX_LOG_ROWS; i++) appendRotating(log, `old ${i}`);
    appendRotating(log, "new 0"); // crosses the threshold -> rotate, then write

    expect(linesOf(`${log}.1`)).toHaveLength(MAX_LOG_ROWS);
    expect(linesOf(`${log}.1`)[0]).toBe("old 0");
    expect(linesOf(log)).toEqual(["new 0"]);
  });

  it("shifts generations and caps the number of archives", () => {
    // Write enough to force MAX_LOG_ARCHIVES + 2 rotations.
    const generations = MAX_LOG_ARCHIVES + 2;
    const total = MAX_LOG_ROWS * generations + 1;
    for (let i = 0; i < total; i++) appendRotating(log, `e${i}`);

    // Only .1 .. .MAX_LOG_ARCHIVES survive; the oldest are deleted.
    expect(fs.existsSync(`${log}.${MAX_LOG_ARCHIVES}`)).toBe(true);
    expect(fs.existsSync(`${log}.${MAX_LOG_ARCHIVES + 1}`)).toBe(false);

    // Bounded total: active + MAX_LOG_ARCHIVES archives, each full, plus the one
    // straggler line in the active file.
    let kept = linesOf(log).length;
    for (let i = 1; i <= MAX_LOG_ARCHIVES; i++) kept += linesOf(`${log}.${i}`).length;
    expect(kept).toBe(MAX_LOG_ROWS * MAX_LOG_ARCHIVES + 1);

    // .1 is always the most recently archived (newer than .2).
    expect(Number(linesOf(`${log}.1`)[0].slice(1))).toBeGreaterThan(
      Number(linesOf(`${log}.2`)[0].slice(1))
    );
  });

  it("learns the existing line count on the first write of a session", () => {
    // Pre-seed a file already at the cap, then simulate a fresh session.
    fs.writeFileSync(
      log,
      Array.from({ length: MAX_LOG_ROWS }, (_, i) => `seed ${i}`).join("\n") + "\n"
    );
    __resetRowCounts();

    appendRotating(log, "after restart"); // should rotate, not blindly append
    expect(linesOf(`${log}.1`)).toHaveLength(MAX_LOG_ROWS);
    expect(linesOf(log)).toEqual(["after restart"]);
  });
});
