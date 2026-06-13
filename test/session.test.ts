import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getSession, readTranscript } from "../src/session";

// Transcript JSONL is written by the Claude CLI and read back here. Line endings
// and partial/garbage lines are the cross-OS hazards.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-session-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(lines: object[], eol = "\n"): string {
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join(eol) + eol);
  return file;
}

describe("readTranscript", () => {
  it("extracts user text, assistant text, and tool uses", () => {
    const file = writeTranscript([
      { type: "user", message: { role: "user", content: "Fix the bug" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "On it." },
            { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
          ],
        },
      },
      { type: "result", result: "done" },
    ]);
    const msgs = readTranscript(file, 200);
    expect(msgs).toEqual([
      { kind: "user", text: "Fix the bug" },
      { kind: "assistant", text: "On it." },
      { kind: "tool", tool: "Edit", text: "src/a.ts" },
      { kind: "result", text: "done" },
    ]);
  });

  it("skips blank and malformed lines", () => {
    const file = path.join(dir, "bad.jsonl");
    fs.writeFileSync(
      file,
      '\n{ not json \n{"type":"user","message":{"role":"user","content":"hi"}}\n\n'
    );
    expect(readTranscript(file, 200)).toEqual([{ kind: "user", text: "hi" }]);
  });

  it("is robust to CRLF line endings", () => {
    const file = writeTranscript(
      [{ type: "user", message: { role: "user", content: "windows line" } }],
      "\r\n"
    );
    expect(readTranscript(file, 200)).toEqual([{ kind: "user", text: "windows line" }]);
  });

  it("honors the limit (keeps the newest N)", () => {
    const file = writeTranscript(
      Array.from({ length: 5 }, (_, i) => ({
        type: "user",
        message: { role: "user", content: `m${i}` },
      }))
    );
    const msgs = readTranscript(file, 2);
    expect(msgs.map((m) => m.text)).toEqual(["m3", "m4"]);
  });
});

describe("getSession", () => {
  it("prefers a live transcript when present", () => {
    const file = writeTranscript([
      { type: "user", message: { role: "user", content: "live" } },
    ]);
    const out = getSession({ transcriptPath: file, session: [{ kind: "user", text: "seed" }] } as any);
    expect(out).toEqual([{ kind: "user", text: "live" }]);
  });

  it("falls back to seeded session when no transcript path", () => {
    const seed = [{ kind: "assistant", text: "seeded" }];
    expect(getSession({ session: seed } as any)).toEqual(seed);
  });

  it("falls back to seeded session when transcript path is missing on disk", () => {
    const seed = [{ kind: "user", text: "seed" }];
    const out = getSession({ transcriptPath: path.join(dir, "ghost.jsonl"), session: seed } as any);
    expect(out).toEqual(seed);
  });

  it("returns [] when neither is available", () => {
    expect(getSession({} as any)).toEqual([]);
  });
});
