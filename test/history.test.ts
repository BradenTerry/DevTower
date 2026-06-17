import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readHistoryCommands, historyFileSize } from "../src/history";

describe("history.jsonl tailer", () => {
  let dir: string;
  let file: string;
  const line = (sessionId: string, display: string) =>
    JSON.stringify({ display, pastedContents: {}, timestamp: 1, project: "/p", sessionId }) + "\n";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-histtest-"));
    file = path.join(dir, "history.jsonl");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns 0 size and no commands for a missing file", async () => {
    expect(await historyFileSize(file)).toBe(0);
    expect(await readHistoryCommands(file, 0)).toEqual({ commands: [], offset: 0 });
  });

  it("parses /rename and /color, skips plain prompts, and advances the offset", async () => {
    fs.writeFileSync(
      file,
      line("s1", "/rename Ada") + line("s2", "just a normal prompt") + line("s3", "/color green")
    );
    const { commands, offset } = await readHistoryCommands(file, 0);
    expect(commands).toEqual([
      { sessionId: "s1", cmd: "rename", arg: "Ada", ts: 1 },
      { sessionId: "s3", cmd: "color", arg: "green", ts: 1 },
    ]);
    expect(offset).toBe(fs.statSync(file).size); // consumed everything (trailing \n)
  });

  it("only accepts the built-in /color palette; rejects (teal, hex) are ignored, default passes through", async () => {
    fs.writeFileSync(
      file,
      line("s1", "/color teal") + // not a built-in colour → host rejected it → ignore
        line("s2", "/color #1191") + // ditto
        line("s3", "/color RED") + // case-insensitive accept
        line("s4", "/color default") // the built-in's reset → passes through
    );
    const { commands } = await readHistoryCommands(file, 0);
    expect(commands).toEqual([
      { sessionId: "s3", cmd: "color", arg: "RED", ts: 1 },
      { sessionId: "s4", cmd: "color", arg: "default", ts: 1 },
    ]);
  });

  it("only matches a command at the start, allowing leading whitespace but not leading text", async () => {
    fs.writeFileSync(
      file,
      line("s1", "   /color red") + // leading whitespace → still the command
        line("s2", "test /color blue") + // command mid-line → NOT a command
        line("s3", "please /rename Foo") + // ditto
        line("s4", "/coloring is fun") + // word-boundary guard: /coloring != /color
        line("s5", "/rename Bob") // a clean command at the start
    );
    const { commands } = await readHistoryCommands(file, 0);
    expect(commands).toEqual([
      { sessionId: "s1", cmd: "color", arg: "red", ts: 1 },
      { sessionId: "s5", cmd: "rename", arg: "Bob", ts: 1 },
    ]);
  });

  it("reads only what was appended past the saved offset", async () => {
    fs.writeFileSync(file, line("s1", "/color red"));
    const first = await readHistoryCommands(file, 0);
    expect(first.commands).toHaveLength(1);

    fs.appendFileSync(file, line("s2", "/rename Bob"));
    const second = await readHistoryCommands(file, first.offset);
    expect(second.commands).toEqual([{ sessionId: "s2", cmd: "rename", arg: "Bob", ts: 1 }]);
  });

  it("leaves a partial trailing line (no newline yet) for the next read", async () => {
    const whole = line("s1", "/color red");
    fs.writeFileSync(file, whole + '{"display":"/rename Half'); // second line unterminated
    const r = await readHistoryCommands(file, 0);
    expect(r.commands).toEqual([{ sessionId: "s1", cmd: "color", arg: "red", ts: 1 }]);
    expect(r.offset).toBe(Buffer.byteLength(whole, "utf8")); // stopped after the complete line

    fs.appendFileSync(file, ' Life","sessionId":"s2","timestamp":1}\n'); // finish the line
    const r2 = await readHistoryCommands(file, r.offset);
    expect(r2.commands).toEqual([{ sessionId: "s2", cmd: "rename", arg: "Half Life", ts: 1 }]);
  });

  it("resets to the start when the file shrank (rotated/truncated)", async () => {
    fs.writeFileSync(file, line("s1", "/color red") + line("s2", "/color blue"));
    const big = fs.statSync(file).size;
    fs.writeFileSync(file, line("s3", "/rename Fresh")); // rotated: smaller than `big`
    const r = await readHistoryCommands(file, big);
    expect(r.commands).toEqual([{ sessionId: "s3", cmd: "rename", arg: "Fresh", ts: 1 }]);
  });
});
