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
  discard,
  discardAll,
  discardPath,
  addToGitignore,
  commit,
  push,
  pull,
  fetch,
  stashList,
  stashSave,
  stashPop,
  stashApply,
  stashDrop,
  GitFile,
  StashEntry,
} from "./git";
import { openGitFileDiff, openMockFileDiff } from "./diffProvider";

type Node = GroupNode | DirNode | FileNode | InfoNode | StashGroupNode | StashNode;

type ViewMode = "tree" | "flat";
const VIEW_MODE_KEY = "devtower.changesViewMode";
const VIEW_MODE_CTX = "devtower.changesView";

class GroupNode extends vscode.TreeItem {
  constructor(label: string, count: number, public kind: "staged" | "unstaged") {
    super(`${label}`, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${count}`;
    this.contextValue = `group-${kind}`;
    this.iconPath = new vscode.ThemeIcon(kind === "staged" ? "check" : "diff-modified");
  }
}

/** A folder in the tree-mode layout. Compacted runs of single-child folders
 *  share one node (e.g. "src/webview"), matching VS Code's Source Control tree. */
class DirNode extends vscode.TreeItem {
  constructor(
    public cwd: string,
    public kind: "staged" | "unstaged",
    /** the folder's path relative to the worktree root, used to find its files */
    public full: string,
    label: string,
    count: number,
    public agentLabel: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${count}`;
    this.contextValue = `dir-${kind}`;
    this.iconPath = vscode.ThemeIcon.Folder;
    this.resourceUri = vscode.Uri.file(path.join(cwd, full));
  }
}

class FileNode extends vscode.TreeItem {
  constructor(
    public cwd: string,
    public file: GitFile,
    public staged: boolean,
    public agentLabel: string,
    /** tree mode conveys the folder via parent nodes, so the row hides its dir */
    hideDir = false
  ) {
    super(path.basename(file.path), vscode.TreeItemCollapsibleState.None);
    const dir = path.dirname(file.path);
    this.description = hideDir || dir === "." ? "" : dir;
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

/** Collapsed top-level group holding the repo's stash entries. */
class StashGroupNode extends vscode.TreeItem {
  readonly kind = "stashes";
  constructor(public cwd: string, count: number) {
    super("Stashes", vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${count}`;
    this.contextValue = "group-stashes";
    this.iconPath = new vscode.ThemeIcon("archive");
  }
}

/** One stash entry, with inline pop / apply / drop actions. */
class StashNode extends vscode.TreeItem {
  constructor(public cwd: string, public entry: StashEntry) {
    super(entry.message || entry.ref, vscode.TreeItemCollapsibleState.None);
    this.description = entry.ref;
    this.tooltip = `${entry.ref}: ${entry.message}`;
    this.contextValue = "stash";
    this.iconPath = new vscode.ThemeIcon("archive");
  }
}

function statusWord(letter: string): string {
  return (
    { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "untracked" }[
      letter
    ] ?? "changed"
  );
}

/** The single status letter a file's row should show, mirroring `git status`:
 *  untracked → "U", otherwise the worktree letter if it has one, else the index
 *  letter (so a staged-only change still reads "M"/"A"/...). */
function statusLetter(f: GitFile): string {
  if (f.untracked) return "U";
  const w = f.work.trim();
  return (w || f.index.trim() || "M").toUpperCase();
}

/** The built-in Git theme color used to tint a file by its status, so DevTower's
 *  Changes view matches VS Code's own Source Control coloring. */
function statusColor(letter: string): vscode.ThemeColor {
  const id =
    {
      M: "gitDecoration.modifiedResourceForeground",
      A: "gitDecoration.addedResourceForeground",
      D: "gitDecoration.deletedResourceForeground",
      R: "gitDecoration.renamedResourceForeground",
      C: "gitDecoration.renamedResourceForeground",
      U: "gitDecoration.untrackedResourceForeground",
    }[letter] ?? "gitDecoration.modifiedResourceForeground";
  return new vscode.ThemeColor(id);
}

/** Supplies the per-file badge + color shown on Changes rows (and propagated as a
 *  tinted dot onto parent folders), exactly like VS Code's Source Control. It is
 *  scoped to the current worktree's changes: any URI not in the live map returns
 *  undefined, so unrelated files (e.g. in the Explorer) are never decorated. */
class ChangeDecorations implements vscode.FileDecorationProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private map = new Map<string, vscode.FileDecoration>();

  /** Replace the decoration set and repaint every previously/ now decorated row. */
  set(map: Map<string, vscode.FileDecoration>): void {
    const touched = new Set([...this.map.keys(), ...map.keys()]);
    this.map = map;
    this._onDidChange.fire([...touched].map((s) => vscode.Uri.parse(s)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.map.get(uri.toString());
  }
}

export class ChangesProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private debounce?: ReturnType<typeof setTimeout>;
  private viewMode: ViewMode;

  constructor(
    private store: DevTowerStore,
    private memento: vscode.Memento,
    private deco: ChangeDecorations
  ) {
    this.viewMode = memento.get<ViewMode>(VIEW_MODE_KEY, "tree");
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

  get mode(): ViewMode {
    return this.viewMode;
  }

  /** Switch between the nested-folder tree and the flat file list, persisting the
   *  choice to the extension's global storage so it survives reloads/sessions. */
  setViewMode(mode: ViewMode): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    void this.memento.update(VIEW_MODE_KEY, mode);
    void vscode.commands.executeCommand("setContext", VIEW_MODE_CTX, mode);
    this.refresh();
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

  /** Rebuild the SCM-style badge/color map for the current worktree's files. A
   *  file changed in both index and worktree shares one URI, so the worktree
   *  letter wins (set last) — matching how the row reads at a glance. */
  private updateDecorations(cwd: string, staged: GitFile[], unstaged: GitFile[]): void {
    const map = new Map<string, vscode.FileDecoration>();
    const put = (f: GitFile) => {
      const letter = statusLetter(f);
      const uri = vscode.Uri.file(path.join(cwd, f.path)).toString();
      map.set(uri, {
        badge: letter,
        color: statusColor(letter),
        tooltip: statusWord(letter),
        propagate: true, // tint parent folders too, like the SCM tree
      });
    };
    staged.forEach(put);
    unstaged.forEach(put);
    this.deco.set(map);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const { cwd, label, agent } = this.currentCwd();
    if (!cwd && !agent) return [new InfoNode("Select a room or agent to see its changes", "list-selection")];

    const real = cwd ? await isRepo(cwd) : false;

    // top level
    if (!node) {
      if (real && cwd) {
        const st = await status(cwd);
        const stashes = await stashList(cwd);
        this.updateDecorations(cwd, st.staged, st.unstaged);
        const groups: Node[] = [];
        if (st.staged.length) groups.push(new GroupNode("Staged Changes", st.staged.length, "staged"));
        if (st.unstaged.length) groups.push(new GroupNode("Changes", st.unstaged.length, "unstaged"));
        if (stashes.length) groups.push(new StashGroupNode(cwd, stashes.length));
        if (!groups.length) return [new InfoNode("No changes in this worktree", "pass")];
        return groups;
      }
      this.deco.set(new Map()); // no real repo → drop any stale decorations
      // mock fallback (only for a selected agent with seeded mock data)
      if (!agent) return [new InfoNode("No changes in this worktree", "circle-slash")];
      if (!agent.files.length) return [new InfoNode("No changes yet", "circle-slash")];
      return [new InfoNode(`${agent.name} — mock changes (read-only)`, "beaker"), ...this.mockFiles(agent.id)];
    }

    // children of the stash group: one row per stash entry
    if (node instanceof StashGroupNode && real && cwd) {
      const stashes = await stashList(cwd);
      return stashes.map((s) => new StashNode(cwd, s));
    }

    // children of a group, or (tree mode) of a folder within it
    if ((node instanceof GroupNode || node instanceof DirNode) && real && cwd) {
      const st = await status(cwd);
      const list = node.kind === "staged" ? st.staged : st.unstaged;
      const prefix = node instanceof DirNode ? node.full : "";
      return this.layout(cwd, node.kind, list, prefix, label);
    }
    return [];
  }

  /** Build the children shown under a group (prefix "") or a folder. Flat mode
   *  lists every file at the top level; tree mode shows only the folders and
   *  files immediately under `prefix`, with single-child folder runs compacted. */
  private layout(
    cwd: string,
    kind: "staged" | "unstaged",
    files: GitFile[],
    prefix: string,
    label: string
  ): Node[] {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    if (this.viewMode === "flat") {
      return sorted.map((f) => new FileNode(cwd, f, kind === "staged", label));
    }
    const pfx = prefix ? prefix + "/" : "";
    const dirFiles = new Map<string, GitFile[]>();
    const filesHere: GitFile[] = [];
    for (const f of sorted) {
      if (prefix && !f.path.startsWith(pfx)) continue;
      const rest = f.path.slice(pfx.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        filesHere.push(f);
      } else {
        const name = rest.slice(0, slash);
        (dirFiles.get(name) ?? dirFiles.set(name, []).get(name)!).push(f);
      }
    }
    const out: Node[] = [];
    for (const name of [...dirFiles.keys()].sort((a, b) => a.localeCompare(b))) {
      const group = dirFiles.get(name)!;
      const { label: dlabel, full } = this.compact(group, pfx + name);
      out.push(new DirNode(cwd, kind, full, dlabel, group.length, label));
    }
    for (const f of filesHere) out.push(new FileNode(cwd, f, kind === "staged", label, true));
    return out;
  }

  /** Collapse a chain of folders that each hold exactly one subfolder (and no
   *  files of their own) into a single "a/b/c" node, like VS Code's SCM tree. */
  private compact(files: GitFile[], prefix: string): { label: string; full: string } {
    let full = prefix;
    let label = prefix.split("/").pop() ?? prefix;
    for (;;) {
      const pfx = full + "/";
      const names = new Set<string>();
      let fileHere = false;
      for (const f of files) {
        const rest = f.path.slice(pfx.length);
        const slash = rest.indexOf("/");
        if (slash === -1) fileHere = true;
        else names.add(rest.slice(0, slash));
      }
      if (fileHere || names.size !== 1) break;
      const only = [...names][0];
      full = pfx + only;
      label += "/" + only;
    }
    return { label, full };
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
  const deco = new ChangeDecorations();
  const provider = new ChangesProvider(store, context.globalState, deco);
  // seed the context key so the view/title toolbar shows the correct toggle
  void vscode.commands.executeCommand("setContext", VIEW_MODE_CTX, provider.mode);

  // Shared by all the Commit variants (Commit, Commit (Amend), Commit & Push,
  // Commit & Sync). Prompts for a message, commits the staged index (or, with
  // confirmation, all tracked edits when nothing is staged), then runs `after`
  // (push / pull+push) if the commit succeeds. Returns true on a commit.
  const runCommit = async (
    opts: { amend?: boolean; after?: (cwd: string) => Promise<void>; verb?: string } = {}
  ): Promise<boolean> => {
    const { cwd } = provider.currentCwd();
    if (!cwd) return false;
    const st = await status(cwd).catch(() => null);
    if (!st) return false;
    // commit the staged index; if nothing is staged, offer to commit every
    // tracked edit (`commit -a`) so a one-click commit still works
    let all = false;
    if (!st.staged.length) {
      if (!st.unstaged.length && !opts.amend) {
        vscode.window.showInformationMessage("DevTower: nothing to commit.");
        return false;
      }
      if (st.unstaged.length) {
        const pick = await vscode.window.showWarningMessage(
          "No staged changes. Commit all tracked changes?",
          { modal: true },
          "Commit All"
        );
        if (pick !== "Commit All") return false;
        all = true;
      }
    }
    const message = await vscode.window.showInputBox({
      prompt: opts.amend
        ? "Commit message (amend previous commit)"
        : all
          ? "Commit message (all tracked changes)"
          : "Commit message (staged changes)",
      placeHolder: "Describe your changes",
    });
    if (!message?.trim()) return false;
    try {
      await commit(cwd, message.trim(), all, opts.amend);
    } catch (e) {
      vscode.window.showErrorMessage(`DevTower: commit failed — ${String(e).slice(0, 200)}`);
      provider.refresh();
      return false;
    }
    if (opts.after) {
      try {
        await opts.after(cwd);
      } catch (e) {
        vscode.window.showWarningMessage(
          `DevTower: ${opts.verb ?? "post-commit"} failed — ${String(e).slice(0, 200)}`
        );
      }
    }
    provider.refresh();
    return true;
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("devtower.changes", provider),
    vscode.window.registerFileDecorationProvider(deco),

    vscode.commands.registerCommand("devtower.changesViewAsTree", () => provider.setViewMode("tree")),
    vscode.commands.registerCommand("devtower.changesViewAsList", () => provider.setViewMode("flat")),

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

    vscode.commands.registerCommand("devtower.discardFile", async (node: FileNode) => {
      const verb = node.file.untracked ? "Delete" : "Discard changes in";
      const pick = await vscode.window.showWarningMessage(
        `${verb} ${path.basename(node.file.path)}? This cannot be undone.`,
        { modal: true },
        node.file.untracked ? "Delete File" : "Discard Changes"
      );
      if (!pick) return;
      try {
        await discard(node.cwd, node.file);
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: discard failed — ${String(e).slice(0, 200)}`);
      }
      provider.refresh();
    }),
    vscode.commands.registerCommand("devtower.stageDir", async (node: DirNode) => {
      await stage(node.cwd, node.full); // `git add` takes a directory pathspec
      provider.refresh();
    }),
    vscode.commands.registerCommand("devtower.unstageDir", async (node: DirNode) => {
      await unstage(node.cwd, node.full);
      provider.refresh();
    }),
    vscode.commands.registerCommand("devtower.discardDir", async (node: DirNode) => {
      const pick = await vscode.window.showWarningMessage(
        `Discard all changes in ${node.full}? Untracked files are deleted. This cannot be undone.`,
        { modal: true },
        "Discard Changes"
      );
      if (pick !== "Discard Changes") return;
      try {
        await discardPath(node.cwd, node.full);
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: discard failed — ${String(e).slice(0, 200)}`);
      }
      provider.refresh();
    }),

    vscode.commands.registerCommand(
      "devtower.addToGitignore",
      async (node: FileNode | DirNode) => {
        let cwd: string, rel: string, isDir: boolean;
        if (node instanceof FileNode) {
          ({ cwd } = node);
          rel = node.file.path;
          isDir = false;
        } else if (node instanceof DirNode) {
          ({ cwd, full: rel } = node);
          isDir = true;
        } else {
          return;
        }
        try {
          await addToGitignore(cwd, rel, isDir);
        } catch (e) {
          vscode.window.showWarningMessage(`DevTower: could not update .gitignore — ${String(e).slice(0, 200)}`);
        }
        provider.refresh();
      }
    ),

    vscode.commands.registerCommand("devtower.discardAll", async () => {
      const { cwd } = provider.currentCwd();
      if (!cwd) return;
      const pick = await vscode.window.showWarningMessage(
        "Discard ALL changes in this worktree? Untracked files are deleted. This cannot be undone.",
        { modal: true },
        "Discard All"
      );
      if (pick !== "Discard All") return;
      try {
        await discardAll(cwd);
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: discard failed — ${String(e).slice(0, 200)}`);
      }
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
    vscode.commands.registerCommand("devtower.refreshChanges", () => provider.refresh()),
    vscode.commands.registerCommand("devtower.commit", () => runCommit()),
    vscode.commands.registerCommand("devtower.commitAmend", () => runCommit({ amend: true })),
    vscode.commands.registerCommand("devtower.commitPush", () =>
      runCommit({ after: (cwd) => push(cwd), verb: "push" })
    ),
    vscode.commands.registerCommand("devtower.commitSync", () =>
      runCommit({
        after: async (cwd) => {
          await pull(cwd);
          await push(cwd);
        },
        verb: "sync",
      })
    ),

    vscode.commands.registerCommand("devtower.collapseChanges", () =>
      vscode.commands.executeCommand("workbench.actions.treeView.devtower.changes.collapseAll")
    ),

    vscode.commands.registerCommand("devtower.push", async () => {
      const { cwd } = provider.currentCwd();
      if (!cwd) return;
      try {
        await push(cwd);
        vscode.window.showInformationMessage("DevTower: pushed.");
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: push failed — ${String(e).slice(0, 200)}`);
      }
      provider.refresh();
    }),

    vscode.commands.registerCommand("devtower.fetch", async () => {
      const { cwd } = provider.currentCwd();
      if (!cwd) return;
      try {
        await fetch(cwd);
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: fetch failed — ${String(e).slice(0, 200)}`);
      }
      provider.refresh();
    }),

    vscode.commands.registerCommand("devtower.stash", async () => {
      const { cwd } = provider.currentCwd();
      if (!cwd) return;
      const message = await vscode.window.showInputBox({
        prompt: "Stash message (optional)",
        placeHolder: "Leave blank for a default WIP stash",
      });
      if (message === undefined) return; // cancelled
      try {
        await stashSave(cwd, message.trim() || undefined);
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: stash failed — ${String(e).slice(0, 200)}`);
      }
      provider.refresh();
    }),

    vscode.commands.registerCommand("devtower.stashPop", async (node: StashNode) => {
      try {
        await stashPop(node.cwd, node.entry.ref);
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: stash pop failed — ${String(e).slice(0, 200)}`);
      }
      provider.refresh();
    }),
    vscode.commands.registerCommand("devtower.stashApply", async (node: StashNode) => {
      try {
        await stashApply(node.cwd, node.entry.ref);
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: stash apply failed — ${String(e).slice(0, 200)}`);
      }
      provider.refresh();
    }),
    vscode.commands.registerCommand("devtower.stashDrop", async (node: StashNode) => {
      const pick = await vscode.window.showWarningMessage(
        `Drop ${node.entry.ref}? This cannot be undone.`,
        { modal: true },
        "Drop"
      );
      if (pick !== "Drop") return;
      try {
        await stashDrop(node.cwd, node.entry.ref);
      } catch (e) {
        vscode.window.showWarningMessage(`DevTower: stash drop failed — ${String(e).slice(0, 200)}`);
      }
      provider.refresh();
    })
  );
  return provider;
}
