import * as vscode from "vscode";
import * as path from "path";
import { DevTowerStore, reconstruct } from "./store";
import { show, GitFile } from "./git";

/**
 * Serves file content for the NATIVE diff editor.
 *   devtower-git:  real content at a git ref (`git show <ref>:<file>`)
 *   devtower-mock: reconstructed before/after for seeded mock agents
 *
 * The "after" side of a real diff is the working-tree file itself (a plain
 * file: URI), so edits in the diff editor write straight to disk.
 */
export const GIT_SCHEME = "devtower-git";
export const MOCK_SCHEME = "devtower-mock";

export class DiffProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private store: DevTowerStore) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.scheme === GIT_SCHEME) {
      const q = new URLSearchParams(uri.query);
      const cwd = decodeURIComponent(q.get("cwd") ?? "");
      const ref = q.get("ref") ?? "HEAD";
      const file = decodeURIComponent(q.get("file") ?? "");
      if (!cwd || !file) return "";
      return show(cwd, ref, file);
    }
    // mock scheme: /<agentId>/<encodedPath>?side=left|right
    const [, agentId, ...rest] = uri.path.split("/");
    const filePath = decodeURIComponent(rest.join("/"));
    const side = new URLSearchParams(uri.query).get("side") ?? "right";
    const file = this.store.get(agentId)?.files.find((f) => f.path === filePath);
    if (!file) return "";
    const { left, right } = reconstruct(file);
    return side === "left" ? left : right;
  }

  refresh(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }
}

function gitUri(cwd: string, file: string, ref: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${ref}/${encodeURIComponent(file)}`,
    query: `cwd=${encodeURIComponent(cwd)}&ref=${ref}&file=${encodeURIComponent(file)}`,
  });
}

/** Public HEAD-side URI for a worktree file, for SCM quick-diff gutters. */
export function gitHeadUri(cwd: string, file: string): vscode.Uri {
  return gitUri(cwd, file, "HEAD");
}

function mockUri(agentId: string, file: string, side: "left" | "right"): vscode.Uri {
  return vscode.Uri.from({
    scheme: MOCK_SCHEME,
    path: `/${agentId}/${encodeURIComponent(file)}`,
    query: `side=${side}`,
  });
}

/** Open a real changed file: HEAD (left) vs working tree (right). */
export async function openGitFileDiff(
  cwd: string,
  file: GitFile,
  label: string
): Promise<void> {
  const left = gitUri(cwd, file.path, "HEAD"); // empty for untracked -> add view
  const right = file.untracked
    ? vscode.Uri.file(path.join(cwd, file.path))
    : vscode.Uri.file(path.join(cwd, file.path));
  const title = `${label} ⌥ ${path.basename(file.path)} (HEAD ↔ working)`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
  });
}

/** Open a mock agent's reconstructed file diff. */
export async function openMockFileDiff(
  store: DevTowerStore,
  agentId: string,
  filePath: string
): Promise<void> {
  const agent = store.get(agentId);
  const file = agent?.files.find((f) => f.path === filePath);
  if (!agent || !file) return;
  const left = mockUri(agentId, filePath, "left");
  const right = mockUri(agentId, filePath, "right");
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${agent.name} ⌥ ${path.basename(filePath)}`,
    { preview: true, viewColumn: vscode.ViewColumn.Beside }
  );
}
