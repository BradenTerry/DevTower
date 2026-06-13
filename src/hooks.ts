import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { dlog } from "./debugLog";

/**
 * Hook-backed "raised hand" detection.
 *
 * The transcript alone cannot tell "awaiting permission" from "a slow tool is
 * still running" — both leave a dangling tool_use with no result and the file
 * goes quiet for both. So instead of guessing, DevTower consumes Claude Code's
 * `Notification` hook, which fires precisely when a session needs the user.
 *
 * The hook script (media/devtower-notify.js) drops a marker per session under
 *   ~/.claude/devtower/waiting/<session_id>.json  = { message, cwd, ts }
 * and the discovery scan treats a session whose marker is newer than its
 * transcript mtime as `waiting` (resumed sessions write a new transcript line,
 * pushing mtime past the marker, which drops the hand).
 *
 * Installing the hook edits the user's global ~/.claude/settings.json, so it is
 * always gated behind a one-time consent prompt — one prompt per hook.
 */

export const WAITING_DIR = path.join(os.homedir(), ".claude", "devtower", "waiting");
export const SUCCESSION_DIR = path.join(os.homedir(), ".claude", "devtower", "succession");
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const MARKER_MAX_AGE = 24 * 3_600_000; // prune markers for sessions long gone
// a /clear's successor session surfaces within a poll or two; if it never does
// (terminal closed right after) forget the marker so it can't later hijack an
// unrelated session that happens to start in the same worktree.
const SUCCESSION_MAX_AGE = 10 * 60_000;

export interface WaitMarker {
  message: string;
  cwd: string;
  ts: number;
}

/** A /clear drops one of these keyed by the NEW session's uuid (see
 *  media/devtower-session.js): the worktree the clear happened in, so discovery
 *  can rebind the new session to the dev whose old session just died there. */
export interface SuccessionMarker {
  cwd: string;
  source: string;
  ts: number;
}

/** Every hook DevTower needs. Adding one here makes the installer prompt for it
 *  (its own consent), so future hooks follow the same per-hook rule. */
interface HookSpec {
  /** stable id, also the globalState key suffix for a remembered "Not now" */
  id: string;
  /** Claude Code hook event name */
  event: string;
  /** the script (under the extension's media/) this hook runs */
  script: string;
  /** user-facing reason, shown in the consent prompt */
  reason: string;
}

const HOOKS: HookSpec[] = [
  {
    id: "notify",
    event: "Notification",
    script: "devtower-notify.js",
    reason:
      "DevTower wants to add a Notification hook to ~/.claude/settings.json so it can raise an agent's hand when it is waiting for your input (e.g. a permission prompt).",
  },
  {
    id: "session",
    event: "SessionStart",
    script: "devtower-session.js",
    reason:
      "DevTower wants to add a SessionStart hook to ~/.claude/settings.json so a dev stays in its place when you /clear it (otherwise the cleared session is seen as gone and a new stranger appears).",
  },
];

/** Read the waiting markers, keyed by session id, pruning stale ones. */
export async function readWaitingMarkers(dir = WAITING_DIR): Promise<Map<string, WaitMarker>> {
  const out = new Map<string, WaitMarker>();
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  for (const fn of files) {
    if (!fn.endsWith(".json")) continue;
    const id = fn.slice(0, -5);
    const full = path.join(dir, fn);
    try {
      const raw = await fs.promises.readFile(full, "utf8");
      const m = JSON.parse(raw) as WaitMarker;
      if (typeof m?.ts !== "number" || now - m.ts > MARKER_MAX_AGE) {
        await fs.promises.unlink(full).catch(() => {});
        continue;
      }
      out.set(id, { message: String(m.message ?? ""), cwd: String(m.cwd ?? ""), ts: m.ts });
    } catch {
      /* partial write or garbage — ignore this poll */
    }
  }
  return out;
}

/** Drop a session's marker once it has resumed (transcript moved past it). */
export function clearMarker(sessionId: string, dir = WAITING_DIR): void {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return;
  fs.promises.unlink(path.join(dir, sessionId + ".json")).catch(() => {});
}

/** Read the /clear succession markers, keyed by the new session id, pruning
 *  stale ones (a successor that never showed up). */
export async function readSuccessionMarkers(dir = SUCCESSION_DIR): Promise<Map<string, SuccessionMarker>> {
  const out = new Map<string, SuccessionMarker>();
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  for (const fn of files) {
    if (!fn.endsWith(".json")) continue;
    const id = fn.slice(0, -5);
    const full = path.join(dir, fn);
    try {
      const raw = await fs.promises.readFile(full, "utf8");
      const m = JSON.parse(raw) as SuccessionMarker;
      if (typeof m?.ts !== "number" || now - m.ts > SUCCESSION_MAX_AGE) {
        await fs.promises.unlink(full).catch(() => {});
        continue;
      }
      out.set(id, { cwd: String(m.cwd ?? ""), source: String(m.source ?? "clear"), ts: m.ts });
    } catch {
      /* partial write or garbage — ignore this poll */
    }
  }
  return out;
}

/** Drop a succession marker once its successor session has been rebound. */
export function clearSuccessionMarker(sessionId: string, dir = SUCCESSION_DIR): void {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return;
  fs.promises.unlink(path.join(dir, sessionId + ".json")).catch(() => {});
}

/** Consent-gated installer: ensure each hook is present in global settings,
 *  prompting once per missing hook and remembering a declined answer. Silently
 *  repairs the command path when the extension location changes. */
export async function ensureHooks(context: vscode.ExtensionContext): Promise<void> {
  for (const spec of HOOKS) {
    try {
      await ensureHook(context, spec);
    } catch (e) {
      dlog("hooks.ensure.error", { id: spec.id, err: String(e) });
    }
  }
}

/** Re-offer any hooks the user previously declined (backs the install command). */
export async function installHooksInteractive(context: vscode.ExtensionContext): Promise<void> {
  for (const spec of HOOKS) await context.globalState.update(declinedKey(spec), undefined);
  await ensureHooks(context);
  vscode.window.showInformationMessage("DevTower hooks are up to date.");
}

const declinedKey = (spec: HookSpec) => `devtower.hook.${spec.id}.declined`;

async function ensureHook(context: vscode.ExtensionContext, spec: HookSpec): Promise<void> {
  const scriptPath = path.join(context.extensionUri.fsPath, "media", spec.script);
  const command = `node "${scriptPath}"`;
  const settings = await readSettings();

  const existing = findHook(settings, spec);
  if (existing) {
    // already consented; just keep the command path current across updates
    if (existing.command !== command) {
      existing.command = command;
      await writeSettings(settings);
      dlog("hooks.path.updated", { id: spec.id });
    }
    return;
  }

  if (context.globalState.get<boolean>(declinedKey(spec))) return;

  const pick = await vscode.window.showInformationMessage(spec.reason, "Add hook", "Not now");
  if (pick !== "Add hook") {
    await context.globalState.update(declinedKey(spec), true);
    return;
  }

  addHook(settings, spec, command);
  await writeSettings(settings);
  await context.globalState.update(declinedKey(spec), undefined);
  dlog("hooks.installed", { id: spec.id });
}

// --- settings.json plumbing -------------------------------------------------

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };
type Settings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

async function readSettings(): Promise<Settings> {
  try {
    const raw = await fs.promises.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Settings) : {};
  } catch {
    return {}; // missing or unreadable → start fresh (write creates it)
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await fs.promises.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = SETTINGS_PATH + ".devtower.tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(settings, null, 2) + "\n");
  await fs.promises.rename(tmp, SETTINGS_PATH);
}

/** Find DevTower's command in a hook event by its script filename (not the full
 *  path, which moves between extension versions). */
function findHook(settings: Settings, spec: HookSpec): { command?: string } | undefined {
  const entries = settings.hooks?.[spec.event];
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    for (const h of entry.hooks ?? []) {
      if (typeof h.command === "string" && h.command.includes(spec.script)) return h;
    }
  }
  return undefined;
}

function addHook(settings: Settings, spec: HookSpec, command: string): void {
  settings.hooks ??= {};
  (settings.hooks[spec.event] ??= []).push({ hooks: [{ type: "command", command }] });
}
