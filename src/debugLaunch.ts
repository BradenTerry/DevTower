import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DevTowerStore } from "./store";
import { resolveDir } from "./git";

/**
 * Debug the currently selected directory using ITS OWN `.vscode/launch.json`.
 *
 * The selected worktree is mirrored by DevTower, not opened as a workspace
 * folder, so VS Code's native Run-and-Debug dropdown can't list its configs
 * (the dropdown only shows configs from open folders, and there is no API to
 * inject a non-open folder's configs into it). Instead we read that worktree's
 * launch.json ourselves, resolve the `${workspaceFolder}`-family variables to
 * the worktree, and hand the config to `vscode.debug.startDebugging` — which
 * runs a fully native debug session (Debug Console, breakpoints, call stack)
 * without touching the user's open folders.
 */

/** Tolerant JSONC parse: launch.json routinely has // comments, block comments
 *  and trailing commas. Strips them (respecting string literals) then JSON.parse. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") { inBlock = false; i += 2; } else i++;
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { inLine = true; i += 2; continue; }
    if (c === "/" && n === "*") { inBlock = true; i += 2; continue; }
    out += c;
    i++;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1"); // drop trailing commas
  return JSON.parse(out);
}

/** Deep-substitute the folder-scoped variables that won't resolve once the
 *  config is launched with no workspace folder. Other variables (${env:*},
 *  ${command:*}, ${file}) are left for VS Code to resolve at launch. */
export function resolveVars<T>(value: T, cwd: string): T {
  const map: Record<string, string> = {
    workspaceFolder: cwd,
    workspaceFolderBasename: path.basename(cwd),
    workspaceRoot: cwd, // legacy alias
    cwd,
    userHome: os.homedir(),
    pathSeparator: path.sep,
    "/": path.sep,
  };
  const sub = (s: string): string =>
    s
      // ${workspaceFolder:Name} (multi-root form) → the selected worktree
      .replace(/\$\{workspaceFolder:[^}]*\}/g, () => cwd)
      .replace(
        /\$\{(workspaceFolder|workspaceFolderBasename|workspaceRoot|cwd|userHome|pathSeparator|\/)\}/g,
        (m, k: string) => map[k] ?? m
      );
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return sub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) o[k] = walk((v as Record<string, unknown>)[k]);
      return o;
    }
    return v;
  };
  return walk(value) as T;
}

async function debugSelected(store: DevTowerStore): Promise<void> {
  const cwd = resolveDir(store.getFocusedWorktree());
  if (!cwd) {
    vscode.window.showInformationMessage(
      "DevTower: press a room's USE DIR button to pick a directory, then debug it."
    );
    return;
  }
  const name = path.basename(cwd);
  const file = path.join(cwd, ".vscode", "launch.json");
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch {
    vscode.window.showWarningMessage(`DevTower: no .vscode/launch.json in "${name}".`);
    return;
  }
  let parsed: { configurations?: vscode.DebugConfiguration[] };
  try {
    parsed = parseJsonc(raw) as { configurations?: vscode.DebugConfiguration[] };
  } catch {
    vscode.window.showErrorMessage(`DevTower: could not parse "${name}/.vscode/launch.json".`);
    return;
  }
  const configs = Array.isArray(parsed?.configurations) ? parsed.configurations : [];
  if (!configs.length) {
    vscode.window.showWarningMessage(`DevTower: launch.json in "${name}" has no configurations.`);
    return;
  }

  let choice = configs[0];
  if (configs.length > 1) {
    const pick = await vscode.window.showQuickPick(
      configs.map((c, i) => ({
        label: c.name || `Configuration ${i + 1}`,
        description: [c.type, c.request].filter(Boolean).join(" · "),
        index: i,
      })),
      { placeHolder: `Debug config to launch in "${name}"` }
    );
    if (!pick) return;
    choice = configs[pick.index];
  }

  const resolved = resolveVars(choice, cwd);
  // a config with no explicit cwd would otherwise default to the (absent) open
  // folder — pin it to the worktree so the program runs in the right place
  if (resolved.cwd === undefined) resolved.cwd = cwd;

  try {
    const ok = await vscode.debug.startDebugging(undefined, resolved);
    if (!ok) {
      vscode.window.showErrorMessage(`DevTower: failed to start "${resolved.name ?? "debug session"}".`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`DevTower: debug launch error: ${String(e)}`);
  }
}

/** Register the "Debug Selected Directory" command. */
export function registerDebug(context: vscode.ExtensionContext, store: DevTowerStore): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("devtower.debugSelected", () => debugSelected(store))
  );
}
