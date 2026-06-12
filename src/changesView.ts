import * as vscode from "vscode";
import * as path from "path";
import { FleetStore } from "./fleet";
import {
  isRepo,
  resolveCwd,
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
      command: "fleet.openFileDiff",
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
      command: "fleet.openFileDiff",
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

  constructor(private store: FleetStore) {
    store.onDidChangeSelection(() => this.refresh());
    store.onChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const agent = this.store.getSelected();
    if (!agent) return [new InfoNode("Select an agent to see its changes", "list-selection")];

    const cwd = resolveCwd(agent);
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
      // mock fallback
      if (!agent.files.length) return [new InfoNode("No changes yet", "circle-slash")];
      return [new InfoNode(`${agent.name} — mock changes (read-only)`, "beaker"), ...this.mockFiles(agent.id)];
    }

    // children of a group
    if (node instanceof GroupNode && real && cwd) {
      const st = await status(cwd);
      const list = node.kind === "staged" ? st.staged : st.unstaged;
      return list
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => new FileNode(cwd, f, node.kind === "staged", agent.name));
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
  store: FleetStore
): ChangesProvider {
  const provider = new ChangesProvider(store);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("fleet.changes", provider),

    vscode.commands.registerCommand("fleet.openFileDiff", async (node: any) => {
      if (node instanceof FileNode) {
        await openGitFileDiff(node.cwd, node.file, node.agentLabel || "agent");
      } else if (node instanceof MockFileNode) {
        await openMockFileDiff(store, node.agentId, node.filePath);
      }
    }),

    vscode.commands.registerCommand("fleet.stageFile", async (node: FileNode) => {
      await stage(node.cwd, node.file.path);
      provider.refresh();
    }),
    vscode.commands.registerCommand("fleet.unstageFile", async (node: FileNode) => {
      await unstage(node.cwd, node.file.path);
      provider.refresh();
    }),

    vscode.commands.registerCommand("fleet.stageAll", async () => {
      const agent = store.getSelected();
      const cwd = agent && resolveCwd(agent);
      if (!cwd) return;
      await stageAll(cwd);
      provider.refresh();
    }),
    vscode.commands.registerCommand("fleet.unstageAll", async () => {
      const agent = store.getSelected();
      const cwd = agent && resolveCwd(agent);
      if (!cwd) return;
      await unstageAll(cwd);
      provider.refresh();
    }),
    vscode.commands.registerCommand("fleet.refreshChanges", () => provider.refresh())
  );
  return provider;
}
