import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * A gated, structured event log for debugging agent discovery, session binding,
 * the external/internal classification, terminals, and the scene. OFF by
 * default; enable with the `devtower.debugLog` setting (toggled live, no
 * reload). When on, every event is appended as one JSON line to BOTH:
 *   - a "DevTower Debug" output channel (View > Output), for live tailing, and
 *   - <workspace>/.devtower/debug.log (or ~/.devtower/debug.log with no folder),
 *     so a whole session can be diffed/grepped after the fact.
 *
 * Each line: { t: ISO time, n: monotonic seq, event: "category.name", ...data }.
 * Use dotted event names so a grep like `grep '"bind' debug.log` slices one
 * concern. Webview events (shred swaps, toon spawn/leave) are forwarded here via
 * a {type:"debug"} message so the extension + scene share one ordered timeline.
 *
 * Neither file grows without bound. Each is rotated like logrotate / Python's
 * RotatingFileHandler: once the active file reaches MAX_LOG_ROWS lines it is
 * archived (debug.log -> debug.log.1, shifting .1 -> .2 ...) and anything past
 * MAX_LOG_ARCHIVES generations is deleted. Total on-disk size per log is thus
 * bounded at roughly (MAX_LOG_ARCHIVES + 1) * MAX_LOG_ROWS lines.
 */
let channel: vscode.OutputChannel | undefined;
let filePath: string | undefined;
let errorFile: string | undefined; // ALWAYS-ON error sink (independent of `enabled`)
let enabled = false;
let seq = 0;

/** Rotate the active log once it reaches this many lines ("rows"). */
export const MAX_LOG_ROWS = 5000;
/** Keep at most this many rotated generations (.1 .. .N); older ones are deleted. */
export const MAX_LOG_ARCHIVES = 5;

// Per-file line count, learned from disk on first write of the session and then
// kept in memory so the hot append path never re-reads the file.
const rowCounts = new Map<string, number>();

function countLines(p: string): number {
  try {
    const buf = fs.readFileSync(p);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    return n;
  } catch {
    return 0; // missing/unreadable file: treat as empty
  }
}

/** Archive `p` -> `p.1`, shifting older generations up and dropping any beyond
 *  MAX_LOG_ARCHIVES. Best-effort: a rotation failure must never break logging. */
function rotateFile(p: string): void {
  try {
    const oldest = `${p}.${MAX_LOG_ARCHIVES}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = MAX_LOG_ARCHIVES - 1; i >= 1; i--) {
      const from = `${p}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${p}.${i + 1}`);
    }
    if (fs.existsSync(p)) fs.renameSync(p, `${p}.1`);
  } catch {
    /* a transient FS error must never break the app */
  }
}

/** Append one line to `p`, rotating first if it has reached MAX_LOG_ROWS. */
export function appendRotating(p: string, line: string): void {
  let count = rowCounts.get(p);
  if (count === undefined) count = countLines(p); // first write this session
  if (count >= MAX_LOG_ROWS) {
    rotateFile(p);
    count = 0;
  }
  try {
    fs.appendFileSync(p, line + "\n");
    rowCounts.set(p, count + 1);
  } catch {
    /* a transient write failure must never break the app */
  }
}

/** Forget cached line counts. Tests only — exported so a fresh session can be
 *  simulated without reloading the module. */
export function __resetRowCounts(): void {
  rowCounts.clear();
}

export function isDebugLogEnabled(): boolean {
  return enabled;
}

/** Absolute path of the always-on error log (undefined if it couldn't be set up). */
export function errorLogPath(): string | undefined {
  return errorFile;
}

/** Wire up the channel + config listener. Safe to call once on activate. */
export function initDebugLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("DevTower Debug");
  context.subscriptions.push(channel);

  // Errors are captured UNCONDITIONALLY (the verbose debugLog setting only gates
  // the chatty discovery/scene trace). They land in the extension's global
  // storage so a crash can be diagnosed after the fact, even when the user never
  // turned the trace on. The file is row-rotated by appendRotating (see elog),
  // so it can't grow without bound; we only set up the directory here.
  try {
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    errorFile = path.join(dir, "errors.log");
  } catch {
    // any setup failure just disables the file sink — the output channel still
    // receives errors.
    if (errorFile && !fs.existsSync(path.dirname(errorFile))) errorFile = undefined;
  }

  const apply = () => {
    const on = vscode.workspace.getConfiguration("devtower").get<boolean>("debugLog", false);
    if (on === enabled) return;
    if (on) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
      filePath = path.join(root, ".devtower", "debug.log");
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } catch {
        filePath = undefined;
      }
      enabled = true;
      dlog("debuglog.start", { pid: process.pid, file: filePath, vscode: vscode.version });
    } else {
      dlog("debuglog.stop", {});
      enabled = false;
    }
  };

  apply();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("devtower.debugLog")) apply();
    })
  );
}

/** Deterministic path of the verbose debug log, whether or not it exists yet
 *  (mirrors the resolution in initDebugLog so callers agree on the location). */
export function debugLogPath(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  return path.join(root, ".devtower", "debug.log");
}

/** True when a non-empty verbose debug log is on disk (so the UI can offer to
 *  view/clear it even after the trace has been turned off). */
export function debugLogExists(): boolean {
  const p = debugLogPath();
  try {
    return !!p && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** How many rotated archives (debug.log.1 .. debug.log.N) are on disk. */
export function debugLogArchiveCount(): number {
  const p = debugLogPath();
  if (!p) return 0;
  let n = 0;
  for (let i = 1; i <= MAX_LOG_ARCHIVES; i++) {
    try {
      if (fs.existsSync(`${p}.${i}`)) n++;
    } catch {
      /* a transient FS error must never break the app */
    }
  }
  return n;
}

/** Directory that holds the verbose debug log and its archives (.devtower). */
export function debugLogDir(): string | undefined {
  const p = debugLogPath();
  return p ? path.dirname(p) : undefined;
}

/** Reveal the live "DevTower Debug" output channel. */
export function showDebugChannel(): void {
  channel?.show(true);
}

/** Empty the verbose log: clear the output channel, truncate the active file and
 *  delete its rotated archives (debug.log.1 ..). The always-on errors.log is
 *  left untouched. */
export function clearDebugLog(): void {
  channel?.clear();
  const p = debugLogPath();
  if (!p) return;
  try {
    if (fs.existsSync(p)) fs.truncateSync(p, 0);
    for (let i = 1; i <= MAX_LOG_ARCHIVES; i++) {
      const archive = `${p}.${i}`;
      if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
    }
    rowCounts.set(p, 0);
  } catch {
    /* a transient FS error must never break the app */
  }
}

/** Append one structured event. No-op unless the log is enabled. */
export function dlog(event: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  const line = JSON.stringify({ t: new Date().toISOString(), n: ++seq, event, ...data });
  channel?.appendLine(line);
  if (filePath) appendRotating(filePath, line);
}

/**
 * Record an ERROR. Unlike dlog this is always on: it appends to the persistent
 * errors.log and the output channel regardless of the debugLog setting, and (so
 * the timelines stay merged) also into the verbose log when that is enabled.
 * `scope` is a dotted source tag, e.g. "webview" or "discovery.refresh".
 */
export function elog(scope: string, data?: Record<string, unknown>): void {
  const event = `error.${scope}`;
  const line = JSON.stringify({ t: new Date().toISOString(), n: ++seq, event, ...data });
  channel?.appendLine(line);
  for (const f of [errorFile, enabled ? filePath : undefined]) {
    if (f) appendRotating(f, line);
  }
}
