import * as vscode from "vscode";
import * as path from "path";
import { canonicalDir } from "./git";

/** One restorable editor tab. Only file-backed text, diff and notebook tabs are
 *  captured — webview/custom/terminal tabs have no reopenable URI, so they are
 *  skipped (left untouched) rather than lost. */
interface SavedTab {
  kind: "text" | "diff" | "notebook";
  uri: string;
  /** diff only: the left/right sides (uri holds the right/modified side). */
  original?: string;
  /** notebook only: the editor's view type (e.g. "jupyter-notebook"). */
  notebookType?: string;
  label?: string;
  viewColumn: number;
  pinned: boolean;
  preview: boolean;
  active: boolean;
}

const STORE_KEY = "devtower.tabsByDir";

/** Remembers which editor tabs are open per USE DIR directory and swaps them when
 *  the directory changes, so editors "follow" the mounted worktree. Gated behind
 *  `devtower.followTabsPerDir` (default on). Capture/close only ever touches tabs
 *  whose file lives under the directory being left; out-of-tree and unsaved-and-
 *  kept tabs are left exactly where they are. */
export class TabSessions {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private enabled(): boolean {
    return vscode.workspace.getConfiguration("devtower").get<boolean>("followTabsPerDir", true);
  }

  private all(): Record<string, SavedTab[]> {
    return this.context.globalState.get<Record<string, SavedTab[]>>(STORE_KEY, {});
  }

  private async save(dirCanon: string, tabs: SavedTab[]): Promise<void> {
    const map = this.all();
    if (tabs.length) map[dirCanon] = tabs;
    else delete map[dirCanon];
    await this.context.globalState.update(STORE_KEY, map);
  }

  /** Switch the working directory's tab set: capture+close the tabs belonging to
   *  `fromDir`, then reopen the ones saved for `toDir`. Returns false when the
   *  user cancels at the unsaved-changes prompt (the caller must then abort the
   *  whole directory switch). A no-op (returns true) when disabled or when the
   *  directory did not actually change. */
  async switchDir(fromDir: string | undefined, toDir: string): Promise<boolean> {
    if (!this.enabled()) return true;
    const to = canonicalDir(toDir);
    const from = fromDir ? canonicalDir(fromDir) : undefined;
    if (from && from === to) return true;

    if (from) {
      const ok = await this.captureAndClose(from);
      if (!ok) return false; // user cancelled at the dirty-files prompt
    }
    await this.restore(to);
    return true;
  }

  /** Reopen the tabs saved for a directory without capturing anything first.
   *  Used on startup when USE DIR is restored (there is no outgoing dir). */
  async restoreOnly(toDir: string): Promise<void> {
    if (!this.enabled()) return;
    await this.restore(canonicalDir(toDir));
  }

  /** True when `uri` is a file under `dirCanon`. */
  private under(uri: vscode.Uri | undefined, dirCanon: string): boolean {
    if (!uri || uri.scheme !== "file") return false;
    const p = canonicalDir(uri.fsPath);
    return p === dirCanon || p.startsWith(dirCanon + path.sep);
  }

  /** The reopenable URI + kind for a tab, or null for tabs we cannot restore
   *  (webview/custom/terminal). For diffs the modified (right) side is primary. */
  private describe(tab: vscode.Tab): Omit<SavedTab, "viewColumn" | "pinned" | "preview" | "active"> | null {
    const input = tab.input;
    if (input instanceof vscode.TabInputText)
      return { kind: "text", uri: input.uri.toString(), label: tab.label };
    if (input instanceof vscode.TabInputTextDiff)
      return { kind: "diff", uri: input.modified.toString(), original: input.original.toString(), label: tab.label };
    if (input instanceof vscode.TabInputNotebook)
      return { kind: "notebook", uri: input.uri.toString(), notebookType: input.notebookType, label: tab.label };
    return null;
  }

  /** The file URI used to test directory membership for a tab. */
  private primaryUri(tab: vscode.Tab): vscode.Uri | undefined {
    const input = tab.input;
    if (input instanceof vscode.TabInputText) return input.uri;
    if (input instanceof vscode.TabInputTextDiff) return input.modified;
    if (input instanceof vscode.TabInputNotebook) return input.uri;
    return undefined;
  }

  /** Snapshot the tabs under `dirCanon`, handle any unsaved ones via a modal, then
   *  close the clean (or now-saved) ones. Returns false if the user cancels. */
  private async captureAndClose(dirCanon: string): Promise<boolean> {
    const inDir: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all)
      for (const tab of group.tabs)
        if (this.describe(tab) && this.under(this.primaryUri(tab), dirCanon)) inDir.push(tab);

    const dirty = inDir.filter((t) => t.isDirty);
    if (dirty.length) {
      const resolved = await this.resolveDirty(dirty);
      if (resolved === "cancel") return false;
      // "discard": revert each dirty doc so the later close does not re-prompt.
      if (resolved === "discard") {
        for (const t of dirty) {
          const uri = this.primaryUri(t);
          if (!uri) continue;
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
            await vscode.commands.executeCommand("workbench.action.files.revert");
          } catch { /* doc gone; close below still drops the tab */ }
        }
      }
    }

    const saved: SavedTab[] = [];
    for (const tab of inDir) {
      const d = this.describe(tab);
      if (!d) continue;
      saved.push({
        ...d,
        viewColumn: tab.group.viewColumn,
        pinned: tab.isPinned,
        preview: tab.isPreview,
        active: tab.isActive,
      });
    }
    await this.save(dirCanon, saved);
    try { await vscode.window.tabGroups.close(inDir, true); } catch { /* best effort */ }
    return true;
  }

  /** Modal for unsaved tabs in the directory being left. */
  private async resolveDirty(dirty: vscode.Tab[]): Promise<"saved" | "discard" | "cancel"> {
    const names = dirty.map((t) => t.label).slice(0, 5).join(", ");
    const more = dirty.length > 5 ? ` and ${dirty.length - 5} more` : "";
    const choice = await vscode.window.showWarningMessage(
      `${dirty.length} unsaved file${dirty.length === 1 ? "" : "s"} in this directory (${names}${more}). Save before switching?`,
      { modal: true, detail: "Switching directories closes this directory's tabs." },
      "Save All",
      "Don't Save",
    );
    if (choice === "Save All") {
      for (const t of dirty) {
        const uri = this.primaryUri(t);
        if (!uri) continue;
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await doc.save();
        } catch { /* unsaveable (e.g. deleted); fall through to close */ }
      }
      return "saved";
    }
    if (choice === "Don't Save") {
      // Discarding is destructive — make the operator confirm the data loss before
      // we revert. Anything but the explicit confirm aborts the whole switch.
      const sure = await vscode.window.showWarningMessage(
        `Discard unsaved changes in ${dirty.length} file${dirty.length === 1 ? "" : "s"}?`,
        { modal: true, detail: "All unsaved changes will be lost. This cannot be undone." },
        "Discard Changes",
      );
      return sure === "Discard Changes" ? "discard" : "cancel";
    }
    return "cancel"; // Cancel / dismissed
  }

  /** Reopen the tabs saved for a directory. Skips any already-open URI so an
   *  unsaved tab that was intentionally left open is not duplicated. Every tab is
   *  reopened in the background (`preserveFocus`) and the editor that was active
   *  before the switch is re-revealed at the end, so USE DIR never yanks the user
   *  onto a restored tab — they stay on whatever they were already looking at. */
  private async restore(dirCanon: string): Promise<void> {
    const saved = this.all()[dirCanon];
    if (!saved?.length) return;

    const open = new Set<string>();
    for (const group of vscode.window.tabGroups.all)
      for (const tab of group.tabs) {
        const uri = this.primaryUri(tab);
        if (uri) open.add(uri.toString());
      }

    // The editor the user is currently looking at (undefined when a webview such
    // as the tower has focus). We restore focus to it once the tabs are back so
    // opening them in the background does not move the active editor.
    const priorActive = vscode.window.activeTextEditor;

    for (const t of saved) {
      if (open.has(t.uri)) continue;
      const column = t.viewColumn > 0 ? t.viewColumn : vscode.ViewColumn.Active;
      try {
        if (t.kind === "diff" && t.original) {
          await vscode.commands.executeCommand(
            "vscode.diff",
            vscode.Uri.parse(t.original),
            vscode.Uri.parse(t.uri),
            t.label,
            { viewColumn: column, preview: t.preview, preserveFocus: true },
          );
        } else if (t.kind === "notebook") {
          await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.parse(t.uri), t.notebookType ?? "default", {
            viewColumn: column,
            preview: t.preview,
            preserveFocus: true,
          });
        } else {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(t.uri));
          await vscode.window.showTextDocument(doc, { viewColumn: column, preview: t.preview, preserveFocus: true });
        }
        if (t.pinned) await vscode.commands.executeCommand("workbench.action.pinEditor");
      } catch { /* file moved/deleted since it was saved; skip it */ }
    }

    // Return to the tab the user had open before the switch (if it survived), so
    // the background reopens above did not leave a restored tab as the active
    // editor in their group.
    if (priorActive) {
      try {
        await vscode.window.showTextDocument(priorActive.document, {
          viewColumn: priorActive.viewColumn,
          preserveFocus: false,
        });
      } catch { /* its tab was closed during the switch; nothing to return to */ }
    }
  }
}
