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
export const RESUME_DIR = path.join(os.homedir(), ".claude", "devtower", "resume");
export const ENDED_DIR = path.join(os.homedir(), ".claude", "devtower", "ended");
// SessionStart(resume) drops one of these for ANY resumed session (see
// media/devtower-session.js). Resuming reopens an existing transcript and does
// not write a line until the first prompt, so a just-resumed session keeps its
// old mtime and would read as idle. Discovery folds a fresh marker's ts into the
// session's activity time so a resumed dev reads active until it writes for real.
export const ACTIVE_DIR = path.join(os.homedir(), ".claude", "devtower", "active");
// PostToolUse(edit) drops one of these per session that edits the working tree
// (see media/devtower-edit.js): which session last modified a worktree, so the
// cable beam can stream from the dev that actually made the change instead of the
// first dev in the room.
export const EDITED_DIR = path.join(os.homedir(), ".claude", "devtower", "edited");
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const MARKER_MAX_AGE = 24 * 3_600_000; // prune markers for sessions long gone
// a /clear's successor session surfaces within a poll or two; if it never does
// (terminal closed right after) forget the marker so it can't later hijack an
// unrelated session that happens to start in the same worktree.
const SUCCESSION_MAX_AGE = 10 * 60_000;
// a resume-picker redirect is consumed on the first poll that sees the resumed
// transcript; if its session never surfaces (terminal closed right after) forget
// the marker so it can't later hijack an unrelated launch reusing the same id.
const RESUME_MAX_AGE = 10 * 60_000;
// an exit retires its dev on the very next poll; the marker is cleared then. The
// age cap only guards against a marker whose poll never ran (extension asleep) —
// keep it short so a stale one can't retire a same-uuid session resumed later.
const ENDED_MAX_AGE = 10 * 60_000;
// how long a resume keeps a silent session reading "active": long enough to cover
// reading the resumed context and composing the first prompt, short enough that a
// resumed-then-abandoned session settles back to idle on its own.
const ACTIVE_MAX_AGE = 3 * 60_000;
// an edit marker is only interesting while it is fresh enough to attribute a
// just-detected git change to it; after that the dev's own activity carries on.
const EDITED_MAX_AGE = 60_000;

export interface WaitMarker {
  message: string;
  cwd: string;
  ts: number;
}

/** A PostToolUse(edit) marker: which session last touched the working tree. */
export interface EditMarker {
  cwd: string;
  ts: number;
  tool?: string;
}

/** A /clear drops one of these keyed by the NEW session's uuid (see
 *  media/devtower-session.js): the worktree the clear happened in, so discovery
 *  can rebind the new session to the dev whose old session just died there. */
export interface SuccessionMarker {
  cwd: string;
  source: string;
  ts: number;
  /** the cleared terminal's launch id — the `--session-id` its claude process
   *  was started with, stable across every /clear. Discovery matches it to the
   *  dev driving that terminal, so the rebind is deterministic even when several
   *  live sessions share the cwd. Absent for bare sessions / old markers. */
  launchId?: string;
}

/** Every hook DevTower can manage. Adding one here makes it show up on the
 *  Settings > Hooks tab (a toggle the user enables/disables) and, the first time
 *  a build ships it, triggers a one-time "review in Settings" nudge. */
interface HookSpec {
  /** stable id, also the globalState key suffix for legacy declined answers */
  id: string;
  /** Claude Code hook event name */
  event: string;
  /** the script (under the extension's media/) this hook runs */
  script: string;
  /** the hook's real name = its Claude Code event, shown on the Hooks tab. A hook
   *  is just an event + its payload, so it's named for the event it listens to,
   *  not one behavior — DevTower can parse the same event for several things. */
  label: string;
  /** what DevTower parses this event's payload for (may be several things), shown
   *  under its name on the Hooks settings tab */
  description: string;
  /** optional tool matcher (for PreToolUse/PostToolUse), so the hook only fires
   *  for the tools it cares about instead of spawning node on every tool call */
  matcher?: string;
}

const HOOKS: HookSpec[] = [
  {
    id: "notify",
    event: "Notification",
    script: "devtower-notify.js",
    label: "Notification",
    description:
      "Fires when Claude needs you. DevTower raises the dev's hand the instant it parks on a permission prompt or a question, instead of guessing from the transcript.",
  },
  {
    id: "session",
    event: "SessionStart",
    script: "devtower-session.js",
    label: "SessionStart",
    description:
      "Fires when a session starts, resumes, or is /cleared. DevTower keeps a dev in place across /clear (no stranger appears) and marks a resumed dev active right away.",
  },
  {
    id: "sessionEnd",
    event: "SessionEnd",
    script: "devtower-session-end.js",
    label: "SessionEnd",
    description:
      "Fires when a session exits. DevTower sends that exact dev home immediately, instead of inferring the exit from running-process counts (which picks the wrong dev when several share a folder).",
  },
  {
    id: "prompt",
    event: "UserPromptSubmit",
    script: "devtower-prompt.js",
    label: "UserPromptSubmit",
    description:
      "Fires the instant you submit a prompt. DevTower marks the dev active right away instead of waiting for its first transcript line, so the run/idle counts react immediately.",
  },
  {
    id: "edit",
    event: "PostToolUse",
    script: "devtower-edit.js",
    matcher: "Write|Edit|MultiEdit|NotebookEdit",
    label: "PostToolUse",
    description:
      "Fires after a file-editing tool runs (Write, Edit, MultiEdit, NotebookEdit). DevTower attributes the change to the dev that made it, so the cable beam streams from the right desk when several devs share a room.",
  },
];

/** What the Settings > Hooks tab renders for each managed hook. */
export interface HookInfo {
  id: string;
  event: string;
  label: string;
  description: string;
  installed: boolean;
}

const KNOWN_HOOKS_KEY = "devtower.hooks.known";

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
      out.set(id, {
        cwd: String(m.cwd ?? ""),
        source: String(m.source ?? "clear"),
        ts: m.ts,
        launchId: m.launchId ? String(m.launchId).toLowerCase() : undefined,
      });
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

/** A SessionStart(resume) in a DevTower-launched terminal drops one of these,
 *  keyed by the RESUMED session's uuid (see media/devtower-session.js). When the
 *  operator spawns a dev (which launches `claude --session-id <launchId>`) and
 *  then picks a DIFFERENT, pre-existing session from Claude's resume picker, the
 *  resumed transcript keeps its own uuid — so the placeholder waiting on
 *  `launchId` would never bind it, and the resumed session would surface as a
 *  separate stranger in its original worktree. The launch id links the resumed
 *  session back to that waiting placeholder so discovery adopts it in place. */
export interface ResumeMarker {
  cwd: string;
  ts: number;
  /** the resuming terminal's launch id — the `--session-id` its claude process
   *  was started with, i.e. the placeholder DevTower is waiting to bind. */
  launchId: string;
}

/** Read the resume-redirect markers, keyed by the resumed session id, pruning
 *  stale ones (a resume whose transcript never surfaced before it aged out). */
export async function readResumeMarkers(dir = RESUME_DIR): Promise<Map<string, ResumeMarker>> {
  const out = new Map<string, ResumeMarker>();
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  for (const fn of files) {
    if (!fn.endsWith(".json")) continue;
    const id = fn.slice(0, -5);
    const full = path.join(dir, fn);
    try {
      const raw = await fs.promises.readFile(full, "utf8");
      const m = JSON.parse(raw) as ResumeMarker;
      if (typeof m?.ts !== "number" || now - m.ts > RESUME_MAX_AGE || !m.launchId) {
        await fs.promises.unlink(full).catch(() => {});
        continue;
      }
      out.set(id, { cwd: String(m.cwd ?? ""), ts: m.ts, launchId: String(m.launchId).toLowerCase() });
    } catch {
      /* partial write or garbage — ignore this poll */
    }
  }
  return out;
}

/** Drop a resume marker once its resumed session has been bound to a dev. */
export function clearResumeMarker(sessionId: string, dir = RESUME_DIR): void {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return;
  fs.promises.unlink(path.join(dir, sessionId + ".json")).catch(() => {});
}

/** A SessionStart(resume) drops one of these, keyed by the resumed session's
 *  uuid: a "just came back" signal independent of transcript writes. */
export interface ActiveMarker {
  cwd: string;
  ts: number;
}

/** Read the resume-activity markers, keyed by session id, returning the ts so a
 *  caller can fold it into the session's activity time. Stale ones are pruned so
 *  the marker can't keep a long-finished session reading active. */
export async function readActiveMarkers(dir = ACTIVE_DIR): Promise<Map<string, ActiveMarker>> {
  const out = new Map<string, ActiveMarker>();
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  for (const fn of files) {
    if (!fn.endsWith(".json")) continue;
    const id = fn.slice(0, -5);
    const full = path.join(dir, fn);
    try {
      const raw = await fs.promises.readFile(full, "utf8");
      const m = JSON.parse(raw) as ActiveMarker;
      if (typeof m?.ts !== "number" || now - m.ts > ACTIVE_MAX_AGE) {
        await fs.promises.unlink(full).catch(() => {});
        continue;
      }
      out.set(id, { cwd: String(m.cwd ?? ""), ts: m.ts });
    } catch {
      /* partial write or garbage — ignore this poll */
    }
  }
  return out;
}

/** Read the edit markers, keyed by session id, pruning stale ones. Used to
 *  attribute a just-detected git change to the session that made it (the cable
 *  beam's source dev). */
export async function readEditMarkers(dir = EDITED_DIR): Promise<Map<string, EditMarker>> {
  const out = new Map<string, EditMarker>();
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  for (const fn of files) {
    if (!fn.endsWith(".json")) continue;
    const id = fn.slice(0, -5);
    const full = path.join(dir, fn);
    try {
      const raw = await fs.promises.readFile(full, "utf8");
      const m = JSON.parse(raw) as EditMarker;
      if (typeof m?.ts !== "number" || now - m.ts > EDITED_MAX_AGE) {
        await fs.promises.unlink(full).catch(() => {});
        continue;
      }
      out.set(id, { cwd: String(m.cwd ?? ""), ts: m.ts, tool: m.tool ? String(m.tool) : undefined });
    } catch {
      /* partial write or garbage — ignore this poll */
    }
  }
  return out;
}

/** A genuine session exit (not /clear or resume) drops one of these keyed by the
 *  exiting session's uuid (see media/devtower-session-end.js), so discovery can
 *  retire the dev bound to that exact transcript instead of inferring the exit
 *  from running-process counts. */
export interface EndMarker {
  cwd: string;
  reason: string;
  ts: number;
  /** the exited terminal's launch id (its --session-id argv) — a secondary match
   *  for the dev when its bound transcript already moved on via /clear. */
  launchId?: string;
}

/** Read the session-end markers, keyed by the exited session id, pruning stale
 *  ones (a poll that never ran while a marker sat unconsumed). */
export async function readEndMarkers(dir = ENDED_DIR): Promise<Map<string, EndMarker>> {
  const out = new Map<string, EndMarker>();
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  for (const fn of files) {
    if (!fn.endsWith(".json")) continue;
    const id = fn.slice(0, -5);
    const full = path.join(dir, fn);
    try {
      const raw = await fs.promises.readFile(full, "utf8");
      const m = JSON.parse(raw) as EndMarker;
      if (typeof m?.ts !== "number" || now - m.ts > ENDED_MAX_AGE) {
        await fs.promises.unlink(full).catch(() => {});
        continue;
      }
      out.set(id, {
        cwd: String(m.cwd ?? ""),
        reason: String(m.reason ?? ""),
        ts: m.ts,
        launchId: m.launchId ? String(m.launchId).toLowerCase() : undefined,
      });
    } catch {
      /* partial write or garbage — ignore this poll */
    }
  }
  return out;
}

/** Drop a session-end marker once its dev has been retired. Awaitable so the
 *  poll can guarantee the marker is gone before it resolves (a still-present
 *  marker would re-fire the retire). */
export function clearEndMarker(sessionId: string, dir = ENDED_DIR): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return Promise.resolve();
  return fs.promises.unlink(path.join(dir, sessionId + ".json")).catch(() => {});
}

const declinedKey = (spec: HookSpec) => `devtower.hook.${spec.id}.declined`;

/** The `node "<...>/media/<script>"` command this hook runs. Rebuilt each call
 *  so it tracks the extension's install path across updates. */
function hookCommand(context: vscode.ExtensionContext, spec: HookSpec): string {
  return `node "${path.join(context.extensionUri.fsPath, "media", spec.script)}"`;
}

/** Install state of every hook DevTower manages, for the Settings > Hooks tab. */
export async function listHooks(): Promise<HookInfo[]> {
  const settings = await readSettings();
  return HOOKS.map((spec) => ({
    id: spec.id,
    event: spec.event,
    label: spec.label,
    description: spec.description,
    installed: !!findHook(settings, spec),
  }));
}

/** Enable or disable a single hook by adding/removing it from global
 *  settings.json. Returns the resulting installed state. */
export async function setHookEnabled(
  context: vscode.ExtensionContext,
  id: string,
  enabled: boolean
): Promise<boolean> {
  const spec = HOOKS.find((h) => h.id === id);
  if (!spec) return false;
  const settings = await readSettings();
  const existing = findHook(settings, spec);
  if (enabled) {
    const command = hookCommand(context, spec);
    if (existing) {
      if (existing.command === command) return true;
      existing.command = command; // repair a stale path
    } else {
      addHook(settings, spec, command);
    }
    await writeSettings(settings);
    await context.globalState.update(declinedKey(spec), undefined);
    dlog("hooks.enabled", { id });
    return true;
  }
  if (existing) {
    removeHook(settings, spec);
    await writeSettings(settings);
    dlog("hooks.disabled", { id });
  }
  return false;
}

/** Enable or disable every managed hook in one settings.json write. */
export async function setAllHooksEnabled(
  context: vscode.ExtensionContext,
  enabled: boolean
): Promise<void> {
  const settings = await readSettings();
  let changed = false;
  for (const spec of HOOKS) {
    const existing = findHook(settings, spec);
    if (enabled) {
      const command = hookCommand(context, spec);
      if (!existing) {
        addHook(settings, spec, command);
        changed = true;
      } else if (existing.command !== command) {
        existing.command = command;
        changed = true;
      }
      await context.globalState.update(declinedKey(spec), undefined);
    } else if (existing) {
      removeHook(settings, spec);
      changed = true;
    }
  }
  if (changed) await writeSettings(settings);
  dlog("hooks.setAll", { enabled });
}

/** On activation: repair the command path of already-installed hooks, then, if a
 *  build has shipped a hook the user has never seen, nudge them once to review it
 *  on the Settings > Hooks tab (where they enable all / disable all / one by one).
 *  Never installs anything without the user choosing to. */
export async function syncHooks(context: vscode.ExtensionContext): Promise<void> {
  try {
    const settings = await readSettings();
    let changed = false;
    for (const spec of HOOKS) {
      const existing = findHook(settings, spec);
      if (!existing) continue;
      const command = hookCommand(context, spec);
      if (existing.command !== command) {
        existing.command = command;
        changed = true;
        dlog("hooks.path.updated", { id: spec.id });
      }
    }
    if (changed) await writeSettings(settings);

    const known = new Set(context.globalState.get<string[]>(KNOWN_HOOKS_KEY, []));
    // a hook the user already installed or explicitly declined in a prior version
    // is not "new" — only prompt for ones they have never been offered at all.
    const isNew = (spec: HookSpec) =>
      !known.has(spec.id) &&
      !findHook(settings, spec) &&
      !context.globalState.get<boolean>(declinedKey(spec));
    const fresh = HOOKS.filter(isNew);

    // record every current hook as known so each new one only nudges once
    if (HOOKS.some((s) => !known.has(s.id))) {
      await context.globalState.update(KNOWN_HOOKS_KEY, HOOKS.map((s) => s.id));
    }
    if (fresh.length === 0) return;

    const n = fresh.length;
    const pick = await vscode.window.showInformationMessage(
      `DevTower has ${n} new ${n === 1 ? "hook" : "hooks"} you can enable (${fresh
        .map((s) => s.label)
        .join(", ")}). They edit ~/.claude/settings.json.`,
      "Review in Settings",
      "Not now"
    );
    if (pick === "Review in Settings") {
      void vscode.commands.executeCommand("devtower.openSettings", "hooks");
    }
  } catch (e) {
    dlog("hooks.sync.error", { err: String(e) });
  }
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
  // A PostToolUse/PreToolUse hook carries a tool matcher so it only fires for the
  // tools it cares about (no node spawn on every Read/Bash); other events omit it.
  const entry: HookEntry = spec.matcher
    ? { matcher: spec.matcher, hooks: [{ type: "command", command }] }
    : { hooks: [{ type: "command", command }] };
  (settings.hooks[spec.event] ??= []).push(entry);
}

/** Strip DevTower's command (matched by script filename) from an event, dropping
 *  any now-empty entries and the event key itself if nothing else uses it. Other
 *  tools' hooks on the same event are left untouched. */
function removeHook(settings: Settings, spec: HookSpec): void {
  const entries = settings.hooks?.[spec.event];
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (entry.hooks) {
      entry.hooks = entry.hooks.filter(
        (h) => !(typeof h.command === "string" && h.command.includes(spec.script))
      );
    }
  }
  const kept = entries.filter((e) => (e.hooks?.length ?? 0) > 0);
  if (kept.length) settings.hooks![spec.event] = kept;
  else delete settings.hooks![spec.event];
}
