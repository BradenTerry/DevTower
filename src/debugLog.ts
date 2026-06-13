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
 */
let channel: vscode.OutputChannel | undefined;
let filePath: string | undefined;
let errorFile: string | undefined; // ALWAYS-ON error sink (independent of `enabled`)
let enabled = false;
let seq = 0;

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
  // turned the trace on. Rotate once at ~1 MB so the file can't grow without
  // bound: errors.log -> errors.log.old (a single generation kept).
  try {
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    errorFile = path.join(dir, "errors.log");
    const st = fs.statSync(errorFile);
    if (st.size > 1_000_000) fs.renameSync(errorFile, errorFile + ".old");
  } catch {
    // statSync throws ENOENT on first run (fine); any setup failure just disables
    // the file sink — the output channel still receives errors.
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

/** Append one structured event. No-op unless the log is enabled. */
export function dlog(event: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  const line = JSON.stringify({ t: new Date().toISOString(), n: ++seq, event, ...data });
  channel?.appendLine(line);
  if (filePath) {
    try {
      fs.appendFileSync(filePath, line + "\n");
    } catch {
      /* a transient write failure must never break the app */
    }
  }
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
    if (!f) continue;
    try {
      fs.appendFileSync(f, line + "\n");
    } catch {
      /* a transient write failure must never break the app */
    }
  }
}
