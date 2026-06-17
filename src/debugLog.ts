import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * A gated, structured event log for debugging agent discovery, session binding,
 * the external/internal classification, terminals, and the scene. OFF by
 * default; enable with the `devtower.debugLog` setting (toggled live, no
 * reload). When on, every event is appended as one JSON line to BOTH:
 *   - a "DevTower Debug" output channel (View > Output), for live tailing, and
 *   - the extension's global storage dir (debug.log), so a whole session can be
 *     diffed/grepped after the fact without leaving files in the workspace.
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
let storageDir: string | undefined; // extension global storage dir, set on init
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

  // Both the always-on errors.log and the optional verbose debug.log live in the
  // extension's global storage (VS Code manages the directory, nothing leaks into
  // the workspace, and it survives across projects).
  try {
    storageDir = context.globalStorageUri.fsPath;
    fs.mkdirSync(storageDir, { recursive: true });
    errorFile = path.join(storageDir, "errors.log");
  } catch {
    if (errorFile && !fs.existsSync(path.dirname(errorFile))) errorFile = undefined;
  }

  const apply = () => {
    const cfg = vscode.workspace.getConfiguration("devtower");
    const on = cfg.get<boolean>("debugLog", false);
    if (on !== enabled) {
      if (on) {
        filePath = storageDir ? path.join(storageDir, "debug.log") : undefined;
        enabled = true;
        dlog("debuglog.start", { pid: process.pid, file: filePath, vscode: vscode.version });
      } else {
        dlog("debuglog.stop", {});
        enabled = false;
      }
    }
    // External-call tracking is its own opt-in. Enabling restarts the window;
    // disabling clears the now-frozen tally so a later re-enable starts clean.
    const execOn = cfg.get<boolean>("externalCallStats", false);
    if (execOn !== execEnabled) {
      execEnabled = execOn;
      if (execOn) execSince = Date.now();
      else execStats.clear();
    }
  };

  apply();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("devtower.debugLog") || e.affectsConfiguration("devtower.externalCallStats")) apply();
    })
  );
}

/** Absolute path of the verbose debug log (in extension global storage). */
export function debugLogPath(): string | undefined {
  return storageDir ? path.join(storageDir, "debug.log") : undefined;
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

/** Directory that holds the verbose debug log and its archives. */
export function debugLogDir(): string | undefined {
  return storageDir;
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

/* ============ External-call tracking ============ */
// Every child process the extension spawns (git, gh, ps/lsof/PowerShell) and every
// agent launch command flows through recordExec, so the Settings > Debug tab can
// show WHAT external calls are firing and HOW OFTEN — the data needed to see why
// the extension host is busy. Opt-in via `devtower.externalCallStats` (like the
// debugLog / perfHud toggles): off, recordExec is a no-op so neither the tally nor
// the exec.* detail lines are kept.

export type ExecStat = {
  count: number;
  totalMs: number;
  maxMs: number;
  errors: number;
  lastMs: number;
  lastTs: string;
};
const execStats = new Map<string, ExecStat>();
let execSince = Date.now();
let execEnabled = false; // devtower.externalCallStats (applied in initDebugLog)

/** True when external-call tracking is opted in, so callers/UI can reflect it. */
export function externalCallStatsEnabled(): boolean {
  return execEnabled;
}

/** "git status", "gh api", … — git and gh take their subcommand as the first arg,
 *  so group by it. Other tools (ps/lsof/powershell/launch) group by family only:
 *  their args carry varying pids/scripts that would fragment the tally. */
function execKey(kind: string, args: string[]): string {
  if ((kind === "git" || kind === "gh") && args[0] && !args[0].startsWith("-")) return `${kind} ${args[0]}`;
  return kind;
}

/** Record one external call: updates the always-on tally and emits a gated detail
 *  line. `kind` is the program family (git/gh/ps/powershell/launch). */
export function recordExec(kind: string, args: string[], cwd: string | undefined, durMs: number, ok: boolean): void {
  if (!execEnabled) return; // tracking opted out — keep neither the tally nor the detail line
  const key = execKey(kind, args);
  const s = execStats.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, errors: 0, lastMs: 0, lastTs: "" };
  s.count++;
  s.totalMs += durMs;
  s.maxMs = Math.max(s.maxMs, durMs);
  s.lastMs = durMs;
  if (!ok) s.errors++;
  s.lastTs = new Date().toISOString();
  execStats.set(key, s);
  dlog(`exec.${kind}`, { cmd: key, args: args.slice(0, 12).join(" ").slice(0, 240), cwd, ms: Math.round(durMs), ok });
}

/** Time a child-process-backed promise and record it. `ok` defaults to "the
 *  promise resolved"; pass `okOf` for callers that resolve a sentinel on failure. */
export async function trackExec<T>(
  kind: string,
  args: string[],
  cwd: string | undefined,
  run: () => Promise<T>,
  okOf?: (result: T) => boolean,
): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await run();
    recordExec(kind, args, cwd, Date.now() - t0, okOf ? okOf(r) : true);
    return r;
  } catch (e) {
    recordExec(kind, args, cwd, Date.now() - t0, false);
    throw e;
  }
}

/** Snapshot of the external-call tally since the last reset, sorted by count. */
export function execStatsSnapshot(): {
  sinceMs: number;
  total: number;
  rows: Array<{ cmd: string; count: number; totalMs: number; avgMs: number; maxMs: number; errors: number; lastTs: string }>;
} {
  const rows = [...execStats.entries()]
    .map(([cmd, s]) => ({
      cmd,
      count: s.count,
      totalMs: Math.round(s.totalMs),
      avgMs: Math.round(s.totalMs / Math.max(1, s.count)),
      maxMs: Math.round(s.maxMs),
      errors: s.errors,
      lastTs: s.lastTs,
    }))
    .sort((a, b) => b.count - a.count);
  return { sinceMs: Date.now() - execSince, total: rows.reduce((n, r) => n + r.count, 0), rows };
}

/** Clear the tally and restart the window (the Debug tab's Reset button). */
export function resetExecStats(): void {
  execStats.clear();
  execSince = Date.now();
}

/** Dump the external-call tally to the DevTower Debug output channel and reveal
 *  it. Works regardless of the debugLog setting (it's an explicit request). */
export function showExecStats(): void {
  if (!channel) return;
  const s = execStatsSnapshot();
  const pad = (v: unknown, n: number) => String(v).padStart(n);
  channel.appendLine(`── DevTower external calls — ${s.total} in the last ${Math.round(s.sinceMs / 1000)}s ──`);
  channel.appendLine(`  ${"command".padEnd(22)} ${pad("count", 7)} ${pad("avg ms", 7)} ${pad("max ms", 7)} ${pad("total ms", 9)} ${pad("err", 5)}`);
  for (const r of s.rows) {
    channel.appendLine(`  ${r.cmd.padEnd(22)} ${pad(r.count, 7)} ${pad(r.avgMs, 7)} ${pad(r.maxMs, 7)} ${pad(r.totalMs, 9)} ${pad(r.errors, 5)}`);
  }
  if (!s.rows.length) {
    channel.appendLine(
      execEnabled
        ? "  (no external calls recorded yet)"
        : "  (tracking is off — enable devtower.externalCallStats, or Settings > Debug > Track external calls)"
    );
  }
  channel.show(true);
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
