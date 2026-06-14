import * as vscode from "vscode";
import * as path from "path";
import { DevTowerStore, Agent } from "./store";
import {
  isRepo,
  resolveCwd,
  resolveDir,
  status,
  stage,
  unstage,
  stageAll,
  unstageAll,
  GitFile,
} from "./git";
import { openGitFileDiff, openMockFileDiff } from "./diffProvider";

type Node = GroupNode | FileNode | InfoNode;

class GroupNode extends vscode.TreeItem {
  constructor(label: string, count: number, public kind: "staged" | "unstaged") {
    super(`${label}`, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${count}`;
    this.contextValue = `group-${kind}`;
    this.iconPath = new vscode.ThemeIcon(kind === "staged" ? "check" : "diff-modified");
  }
}

class FileNode extends vscode.TreeItem {
  constructor(
    public cwd: string,
    public file: GitFile,
    public staged: boolean,
    public agentLabel: string
  ) {
    super(path.basename(file.path), vscode.TreeItemCollapsibleState.None);
    const dir = path.dirname(file.path);
    this.description = dir === "." ? "" : dir;
    this.resourceUri = vscode.Uri.file(path.join(cwd, file.path));
    this.contextValue = staged ? "staged" : "unstaged";
    const letter = file.untracked ? "U" : staged ? file.index : file.work;
    this.tooltip = `${file.path} — ${statusWord(letter)}`;
    this.command = {
      command: "devtower.openFileDiff",
      title: "Open Diff",
      arguments: [this],
    };
  }
}

class MockFileNode extends vscode.TreeItem {
  constructor(public agentId: string, public filePath: string, add: number, del: number) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
    const dir = path.dirname(filePath);
    this.description = `${dir === "." ? "" : dir + "  "}+${add} −${del}`;
    this.resourceUri = vscode.Uri.file(filePath);
    this.contextValue = "mock";
    this.command = {
      command: "devtower.openFileDiff",
      title: "Open Diff",
      arguments: [this],
    };
  }
}

class InfoNode extends vscode.TreeItem {
  constructor(label: string, icon = "info") {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

function statusWord(letter: string): string {
  return (
    { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "untracked" }[
      letter
    ] ?? "changed"
  );
}

export class ChangesProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private debounce?: ReturnType<typeof setTimeout>;

  constructor(private store: DevTowerStore) {
    // selection / focus are user actions → refresh now. onChange fires on every
    // agent state event (many per second while a session is busy), so coalesce
    // it: each getChildren shells out to `git status`, and re-querying the tree
    // faster than git can answer leaves it stuck on a spinner ("frozen").
    store.onDidChangeSelection(() => this.refresh());
    store.onDidChangeFocusWorktree(() => this.refresh());
    store.onChange(() => this.refreshSoon());
  }

  refresh(): void {
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = undefined; }
    this._onDidChange.fire();
  }

  /** Coalesce a burst of change events into a single refresh. */
  private refreshSoon(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this._onDidChange.fire();
    }, 300);
  }

  /** The worktree whose changes to show: a focused room wins, else the agent.
   *  `agent` is the selected agent (for the mock fallback when no room focus). */
  currentCwd(): { cwd: string | undefined; label: string; agent?: Agent } {
    const focused = resolveDir(this.store.getFocusedWorktree());
    const agent = this.store.getSelected();
    const cwd = focused ?? (agent ? resolveCwd(agent) : undefined);
    const label = focused ? path.basename(focused) : agent?.name ?? "room";
    return { cwd, label, agent: focused ? undefined : agent };
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const { cwd, label, agent } = this.currentCwd();
    if (!cwd && !agent) return [new InfoNode("Select a room or agent to see its changes", "list-selection")];

    const real = cwd ? await isRepo(cwd) : false;

    // top level
    if (!node) {
      if (real && cwd) {
        const st = await status(cwd);
        const groups: Node[] = [];
        if (st.staged.length) groups.push(new GroupNode("Staged Changes", st.staged.length, "staged"));
        if (st.unstaged.length) groups.push(new GroupNode("Changes", st.unstaged.length, "unstaged"));
        if (!groups.length) return [new InfoNode("No changes in this worktree", "pass")];
        return groups;
      }
      // mock fallback (only for a selected agent with seeded mock data)
      if (!agent) return [new InfoNode("No changes in this worktree", "circle-slash")];
      if (!agent.files.length) return [new InfoNode("No changes yet", "circle-slash")];
      return [new InfoNode(`${agent.name} — mock changes (read-only)`, "beaker"), ...this.mockFiles(agent.id)];
    }

    // children of a group
    if (node instanceof GroupNode && real && cwd) {
      const st = await status(cwd);
      const list = node.kind === "staged" ? st.staged : st.unstaged;
      return list
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => new FileNode(cwd, f, node.kind === "staged", label));
    }
    return [];
  }

  private mockFiles(agentId: string): Node[] {
    const agent = this.store.get(agentId);
    if (!agent) return [];
    return agent.files.map((f) => new MockFileNode(agentId, f.path, f.add, f.del) as unknown as Node);
  }
}

/** Register the changes tree + its stage/unstage/open commands. */
export function registerChanges(
  context: vscode.ExtensionContext,
  store: DevTowerStore
): ChangesProvider {
  const provider = new ChangesProvider(store);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("devtower.changes", provider),

    vscode.commands.registerCommand("devtower.openFileDiff", async (node: any) => {
      if (node instanceof FileNode) {
        await openGitFileDiff(node.cwd, node.file, node.agentLabel || "agent");
      } else if (node instanceof MockFileNode) {
        await openMockFileDiff(store, node.agentId, node.filePath);
      }
    }),

    vscode.commands.registerCommand("devtower.stageFile", async (node: FileNode) => {
      await stage(node.cwd, node.file.path);
      provider.refresh();
    }),
    vscode.commands.registerCommand("devtower.unstageFile", async (node: FileNode) => {
      await unstage(node.cwd, node.file.path);
      provider.refresh();
    }),

    vscode.commands.registerCommand("devtower.stageAll", async () => {
      const { cwd } = provider.currentCwd();
      if (!cwd) return;
      await stageAll(cwd);
      provider.refresh();
    }),
    vscode.commands.registerCommand("devtower.unstageAll", async () => {
      const { cwd } = provider.currentCwd();
      if (!cwd) return;
      await unstageAll(cwd);
      provider.refresh();
    }),
    vscode.commands.registerCommand("devtower.refreshChanges", () => provider.refresh())
  );
  return provider;
}
