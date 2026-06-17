import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { dlog } from "./debugLog";

/** USE DIR mounts a room's worktree as the window's VS Code workspace so the
 *  NATIVE Explorer, quick-open (Cmd+P) and search (ripgrep) operate on it.
 *
 *  Rather than appending the worktree to the folder the window was opened at
 *  (which silently converts the window into an UNTITLED multi-root workspace and,
 *  worse, switches `workspaceState` to a fresh store — orphaning every owned
 *  agent as a ghost), DevTower opens a stable, NAMED `DevTower.code-workspace`
 *  file. Because its path is constant per project, the window keeps one identity
 *  across worktree swaps, and the title reads "DevTower" instead of "Untitled".
 *
 *  The workspace shows the worktree, with the project root hidden by default —
 *  a title-bar toggle in the Explorer flips between "worktree only" and
 *  "root + worktree". Switching the visible folder set changes folder[0], which
 *  VS Code can only honor by reloading the window; that reload is safe because
 *  agent ownership now lives in `globalState` (see extension.ts), not in the
 *  per-workspace store. */

const WS_FILE_NAME = "DevTower.code-workspace";
const MODE_KEY = "devtower.workspaceShowRoot"; // globalState: home -> showRoot bool

/** The home root persisted into the managed workspace so it survives the mode
 *  swaps that hide it from the Explorer. Mirrored into package.json config. */
export const HOME_ROOT_SETTING = "devtower.homeRoot";

/** Everything the module touches outside its own logic, injected so the apply
 *  flow (file writes, folder mutation, window reopen, context keys) is unit
 *  testable without a live extension host. */
export interface WsHost {
  /** Absolute fsPaths of the currently open workspace folders, in order. */
  currentFolders(): string[];
  /** fsPath of the open `.code-workspace` file, or undefined for a folder window. */
  workspaceFile(): string | undefined;
  /** Where DevTower may write its generated workspace files. */
  globalStorageDir(): string;
  /** Project root backing the current window (config override else folder[0]). */
  homeRoot(): string | undefined;
  /** Persisted "show root" mode for a home root (default false: worktree only). */
  getMode(home: string): boolean;
  setMode(home: string, showRoot: boolean): void;
  writeFile(file: string, content: string): void;
  /** Replace the live folder set; VS Code reloads when folder[0] changes. */
  updateFolders(deleteCount: number, folders: { uri: vscode.Uri; name: string }[]): void;
  openWorkspace(file: vscode.Uri): void;
  setContext(key: string, value: boolean): void;
}

let host: WsHost | undefined;
let selectedWorktree: string | undefined;

/** Fold a path for IDENTITY comparison only (never for a value written to disk):
 *  normalize separators, strip the trailing one, and lower-case on case-insensitive
 *  platforms. Mirrors git.ts `canonicalDir` so `C:\repo\wt` and `c:\repo\wt` compare
 *  equal — otherwise `applyWorkspace`'s no-op guard would miss on Windows and force a
 *  redundant folder swap (a window reload) every time the worktree is re-mounted. */
function norm(p: string): string {
  const n = path.normalize(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? n.toLowerCase() : n;
}
function sameDir(a: string, b: string): boolean {
  return norm(a) === norm(b);
}
function foldersEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((p, i) => sameDir(p, b[i]));
}

/** Stable per-project path for the generated workspace file. The FILE NAME is
 *  always `DevTower.code-workspace` (that is what VS Code shows as the workspace
 *  name); the parent dir is keyed by a hash of the home root so two projects
 *  never share one file. */
function wsFilePath(home: string): string {
  const h = crypto.createHash("sha1").update(norm(home)).digest("hex").slice(0, 12);
  return path.join(host!.globalStorageDir(), "workspaces", h, WS_FILE_NAME);
}

function wsFileContent(folders: string[], home: string): string {
  return JSON.stringify(
    {
      folders: folders.map((p) => ({ name: path.basename(p), path: p })),
      settings: { [HOME_ROOT_SETTING]: home },
    },
    null,
    2
  );
}

/** True when the current window is a DevTower-managed workspace (its home root
 *  came from the persisted setting, i.e. we opened the generated file). */
export function isManaged(): boolean {
  const file = host?.workspaceFile();
  return !!file && path.basename(file) === WS_FILE_NAME;
}

/** The project root backing the current window. Stable across mode swaps: when
 *  the root is hidden the setting still carries it, so callers (workspace key,
 *  ownership persistence) keep one identity per project. */
export function homeRoot(): string | undefined {
  return host?.homeRoot();
}

/** Wire the real extension-host implementations and seed the toggle's context
 *  keys from whatever workspace the window opened into. */
export function initWorkspace(context: vscode.ExtensionContext): void {
  host = makeHost(context);
  syncContext();
  dlog("workspace.init", { managed: isManaged(), home: homeRoot(), folders: host.currentFolders() });
}

/** Push the Explorer-toggle context keys to match the live folder set. */
function syncContext(): void {
  if (!host) return;
  const home = host.homeRoot();
  const showingRoot = !!home && host.currentFolders().some((f) => sameDir(f, home));
  host.setContext("devtower.inManagedWorkspace", isManaged());
  host.setContext("devtower.workspaceShowingRoot", showingRoot);
}

/** Make `dir` the mounted worktree at the current view mode, opening or swapping
 *  the DevTower workspace as needed. No-op when the window is already showing the
 *  desired folder set (so re-mounting on activate never loops a reload). */
export function mountWorktree(dir: string): void {
  selectedWorktree = dir;
  applyWorkspace();
}

/** Unmount the worktree: leave the DevTower workspace and reopen the project root
 *  as a plain folder window. No-op outside a managed workspace. */
export function unmountWorktree(): void {
  selectedWorktree = undefined;
  if (!host || !isManaged()) return;
  const home = host.homeRoot();
  if (!home) return;
  dlog("workspace.unmount", { home });
  host.openWorkspace(vscode.Uri.file(home));
}

/** Flip the Explorer between "worktree only" and "root + worktree" and reapply.
 *  Bound to the title-bar toggle. */
export function toggleRoot(): void {
  if (!host) return;
  const home = host.homeRoot();
  if (!home) return;
  const next = !host.getMode(home);
  host.setMode(home, next);
  dlog("workspace.toggleRoot", { home, showRoot: next });
  applyWorkspace();
}

/** Reconcile the live workspace with (selectedWorktree, mode). Writes the file
 *  so a fresh open reflects the choice, then either mutates the live folders or
 *  opens the workspace — both reload when folder[0] changes; idempotent when the
 *  set already matches. */
function applyWorkspace(): void {
  if (!host || !selectedWorktree) return;
  const home = host.homeRoot();
  if (!home) {
    // No root to anchor to (bare window): adding folder[0] would restart the
    // host for no Explorer win — skip, matching the old no-open-workspace guard.
    dlog("workspace.apply.skip", { reason: "no-home" });
    return;
  }
  const showRoot = host.getMode(home);
  const desired = showRoot ? [home, selectedWorktree] : [selectedWorktree];
  const file = vscode.Uri.file(wsFilePath(home));
  host.writeFile(file.fsPath, wsFileContent(desired, home));

  const current = host.currentFolders();
  if (isManaged() && foldersEqual(current, desired)) {
    syncContext(); // already correct — no reload, just keep the toggle in sync
    dlog("workspace.apply.noop", { home, showRoot, desired });
    return;
  }
  if (isManaged()) {
    // Same workspace, different folders: replace the whole set. Changing
    // folder[0] reloads the window; on reactivate this re-applies as a no-op.
    host.updateFolders(
      current.length,
      desired.map((p) => ({ uri: vscode.Uri.file(p), name: path.basename(p) }))
    );
    syncContext(); // keep the toggle correct if VS Code applied folders without a reload
    dlog("workspace.apply.swap", { home, showRoot, from: current, to: desired });
  } else {
    // Folder window (or some other workspace): open the named DevTower file.
    host.openWorkspace(file);
    dlog("workspace.apply.open", { home, showRoot, file: file.fsPath, desired });
  }
}

/** Production host: real VS Code + node fs. */
function makeHost(context: vscode.ExtensionContext): WsHost {
  return {
    currentFolders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    workspaceFile: () => vscode.workspace.workspaceFile?.fsPath,
    globalStorageDir: () => context.globalStorageUri.fsPath,
    homeRoot: () => {
      const set = vscode.workspace.getConfiguration("devtower").get<string>("homeRoot");
      if (set && set.trim()) return set;
      return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    },
    getMode: (home) => context.globalState.get<boolean>(`${MODE_KEY}::${norm(home)}`, false),
    setMode: (home, showRoot) => void context.globalState.update(`${MODE_KEY}::${norm(home)}`, showRoot),
    writeFile: (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    updateFolders: (deleteCount, folders) => {
      vscode.workspace.updateWorkspaceFolders(0, deleteCount, ...folders);
    },
    openWorkspace: (file) => {
      void vscode.commands.executeCommand("vscode.openFolder", file, { forceReuseWindow: true });
    },
    setContext: (key, value) => {
      void vscode.commands.executeCommand("setContext", key, value);
    },
  };
}

/** Test-only seam: inject a fake host and reset selection. */
export function __setHost(h: WsHost | undefined): void {
  host = h;
  selectedWorktree = undefined;
}
