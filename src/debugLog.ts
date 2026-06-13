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
let enabled = false;
let seq = 0;

export function isDebugLogEnabled(): boolean {
  return enabled;
}

/** Wire up the channel + config listener. Safe to call once on activate. */
export function initDebugLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("DevTower Debug");
  context.subscriptions.push(channel);

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
