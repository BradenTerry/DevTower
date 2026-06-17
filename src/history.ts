import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Tail of Claude Code's global prompt history.
 *
 * `~/.claude/history.jsonl` records one JSON line per prompt submitted to ANY
 * session, in ANY project — the backing store for up-arrow / Ctrl-R recall.
 * Each line is `{ display, pastedContents, timestamp, project, sessionId }`.
 *
 * It is the only reliable signal for the BUILT-IN `/rename` and `/color`
 * commands: those are consumed by the host before the UserPromptSubmit hook
 * runs, so the command-marker path (media/devtower-prompt.js) never sees them.
 * They DO land here, keyed by `sessionId`, so discovery tails this file from a
 * byte offset captured at activation and mirrors each command onto its dev.
 */
export const HISTORY_FILE = path.join(os.homedir(), ".claude", "history.jsonl");

/** A `/rename` or `/color` typed as a built-in, recovered from a history line. */
export interface HistoryCommand {
  sessionId: string;
  cmd: "rename" | "color";
  /** raw argument after the command word (a name, or a colour value) */
  arg: string;
  ts: number;
}

/** Current byte size of the history file, or 0 if it does not exist yet. Used to
 *  seek to EOF on the first scan so pre-existing history is never replayed. */
export async function historyFileSize(file = HISTORY_FILE): Promise<number> {
  try {
    return (await fs.promises.stat(file)).size;
  } catch {
    return 0;
  }
}

const COMMAND_RE = /^\/(rename|color)\b[ \t]*(.*)$/i;

/** The exact palette the built-in /color accepts. Anything else is rejected by
 *  the host ("Invalid color ...") and never changes the session colour, so we
 *  must ignore it too — otherwise the shirt would change while the window did
 *  not. "default" clears the override back to the procedural shirt. */
const BUILTIN_COLORS = new Set([
  "red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan", "default",
]);

/** Read control commands appended since `fromOffset`, returning them with the
 *  new offset to read from next time. Only whole lines are consumed; a partial
 *  trailing line (no newline yet) is left for the next read. If the file shrank
 *  (rotated/truncated) the offset resets to 0 — replaying is harmless because an
 *  unbound session resolves to no dev and is skipped by the caller. */
export async function readHistoryCommands(
  file = HISTORY_FILE,
  fromOffset = 0
): Promise<{ commands: HistoryCommand[]; offset: number }> {
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return { commands: [], offset: 0 };
  }
  let start = fromOffset < 0 ? 0 : fromOffset;
  if (start > size) start = 0; // rotated/truncated since last read
  if (start === size) return { commands: [], offset: size };

  const fh = await fs.promises.open(file, "r");
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { commands: [], offset: start }; // no complete line yet
    const consumed = text.slice(0, lastNl);
    const offset = start + Buffer.byteLength(consumed, "utf8") + 1; // past the \n

    const commands: HistoryCommand[] = [];
    for (const line of consumed.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { display?: unknown; sessionId?: unknown; timestamp?: unknown };
        const display = typeof rec.display === "string" ? rec.display.trim() : "";
        const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
        if (!display || !sessionId) continue;
        const m = COMMAND_RE.exec(display);
        if (!m) continue;
        const cmd = m[1].toLowerCase() as "rename" | "color";
        const arg = m[2].trim();
        // mirror the built-in: a /color the host rejected never changed the
        // window, so it must not change the shirt either
        if (cmd === "color" && !BUILTIN_COLORS.has(arg.toLowerCase())) continue;
        commands.push({
          sessionId,
          cmd,
          arg,
          ts: typeof rec.timestamp === "number" ? rec.timestamp : 0,
        });
      } catch {
        /* a partial write or garbage line — ignore it */
      }
    }
    return { commands, offset };
  } finally {
    await fh.close();
  }
}
