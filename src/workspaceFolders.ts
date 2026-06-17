import * as vscode from "vscode";
import * as path from "path";
import { dlog } from "./debugLog";

/** Mount a room's worktree as a real VS Code workspace folder so the NATIVE
 *  Explorer, quick-open (Cmd+P) and search (ripgrep) operate on it — not just
 *  DevTower's own Selected Directory view.
 *
 *  USE DIR owns exactly ONE folder at a time: switching to another room swaps it
 *  rather than accumulating. The original folder the window was opened at
 *  (index 0) is never touched — VS Code restarts the whole extension host when
 *  the FIRST workspace folder changes, which would tear down every agent session
 *  DevTower is running. So the managed folder is always appended/removed at the
 *  end; folder[0] is sacred. */

// The single worktree folder DevTower currently has mounted via USE DIR, if any.
let managedDir: string | undefined;

function sameDir(a: string, b: string): boolean {
  // VS Code matches workspace folders by exact fsPath; normalize trailing
  // separators so a stored dir and a live folder uri compare equal.
  const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, "");
  return norm(a) === norm(b);
}

/** Index of the open workspace folder rooted at `dir`, or -1 if none. */
function folderIndex(dir: string): number {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.findIndex((f) => sameDir(f.uri.fsPath, dir));
}

/** True if `dir` is currently a workspace folder (at any position). */
export function isWorkspaceFolder(dir: string): boolean {
  return folderIndex(dir) >= 0;
}

/** Remove the workspace folder rooted at `dir`, unless it is folder[0] (removing
 *  the root restarts the extension host) or is not present. Returns true if the
 *  folder set was changed. */
function removeFolder(dir: string): boolean {
  const idx = folderIndex(dir);
  if (idx <= 0) {
    dlog("workspaceFolder.remove.skip", { dir, idx, reason: idx < 0 ? "not-present" : "is-root" });
    return false;
  }
  const ok = vscode.workspace.updateWorkspaceFolders(idx, 1);
  dlog("workspaceFolder.remove", { dir, idx, ok });
  return ok;
}

/** Make `dir` the single USE DIR workspace folder: drop whatever was mounted
 *  before, then append `dir`. No-op (returns false) when:
 *   - there is no open workspace to extend (adding folder[0] would restart the
 *     extension host and kill agents — not worth it for the file-tree win), or
 *   - `dir` is already the mounted folder. */
export function setWorkspaceFolder(dir: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    dlog("workspaceFolder.set.skip", { dir, reason: "no-open-workspace" });
    return false;
  }
  if (managedDir && sameDir(managedDir, dir) && folderIndex(dir) >= 0) {
    dlog("workspaceFolder.set.skip", { dir, reason: "already-mounted" });
    return false;
  }
  if (managedDir) removeFolder(managedDir); // swap out the previous USE DIR folder
  managedDir = dir;
  if (folderIndex(dir) >= 0) {
    // already a folder for another reason (e.g. the user added it) — adopt it.
    dlog("workspaceFolder.set.adopt", { dir });
    return true;
  }
  const at = vscode.workspace.workspaceFolders?.length ?? folders.length;
  const ok = vscode.workspace.updateWorkspaceFolders(at, 0, {
    uri: vscode.Uri.file(dir),
    name: path.basename(dir),
  });
  dlog("workspaceFolder.set", { dir, at, ok });
  return ok;
}

/** Unmount the current USE DIR folder, if any. Returns true if it was removed. */
export function clearWorkspaceFolder(): boolean {
  if (!managedDir) return false;
  const ok = removeFolder(managedDir);
  dlog("workspaceFolder.clear", { dir: managedDir, ok });
  managedDir = undefined;
  return ok;
}

/** Test-only: reset the module's notion of the mounted folder. */
export function __resetManaged(): void {
  managedDir = undefined;
}
