import { describe, it, expect, beforeEach } from "vitest";
import * as path from "path";
import {
  mountWorktree,
  unmountWorktree,
  toggleRoot,
  isManaged,
  homeRoot,
  __setHost,
  type WsHost,
} from "../src/workspaceFolders";

/** A recording fake of the extension-host seam so the apply flow can be driven
 *  without a live VS Code. updateFolders/openWorkspace mutate `folders`/`file`
 *  the way a real reload would, so a follow-up mount re-applies as a no-op. */
function makeFake(opts: { home?: string; folders?: string[]; file?: string }) {
  const state = {
    folders: opts.folders ?? [],
    file: opts.file as string | undefined,
    home: opts.home,
    modes: new Map<string, boolean>(),
    writes: [] as { file: string; content: string }[],
    updates: [] as { start: number; deleteCount: number; folders: string[] }[],
    dirs: [] as string[],
    opens: [] as string[],
    ctx: new Map<string, boolean>(),
  };
  const host: WsHost = {
    currentFolders: () => state.folders,
    workspaceFile: () => state.file,
    globalStorageDir: () => "/gs",
    homeRoot: () => state.home,
    getMode: (h) => state.modes.get(h) ?? false,
    setMode: (h, v) => void state.modes.set(h, v),
    writeFile: (file, content) => state.writes.push({ file, content }),
    ensureDir: (dir) => state.dirs.push(dir),
    updateFolders: (start, deleteCount, folders) => {
      state.updates.push({ start, deleteCount, folders: folders.map((f) => f.uri.fsPath) });
      // splice like the real updateWorkspaceFolders — only a folder[0] change reloads
      state.folders.splice(start, deleteCount, ...folders.map((f) => f.uri.fsPath));
    },
    openWorkspace: (uri) => {
      state.opens.push(uri.fsPath);
      state.file = uri.fsPath; // simulate landing in the opened workspace
      if (path.basename(uri.fsPath) === "DevTower.code-workspace") {
        // a fresh open of the generated file would load the folders we just wrote
        const last = state.writes[state.writes.length - 1];
        if (last) state.folders = JSON.parse(last.content).folders.map((f: any) => f.path);
      } else {
        state.folders = [uri.fsPath];
      }
    },
    setContext: (k, v) => void state.ctx.set(k, v),
  };
  __setHost(host);
  return state;
}

describe("workspaceFolders", () => {
  beforeEach(() => __setHost(undefined));

  // Built the same way the source does (path.join), so the separator matches the
  // host platform — a hardcoded "/gs/anchor" fails on Windows where join uses "\".
  const ANCHOR = path.join("/gs", "anchor");

  it("first USE DIR from a folder window opens the named DevTower workspace, anchor + worktree", () => {
    const s = makeFake({ home: "/repo", folders: ["/repo"], file: undefined });
    mountWorktree("/repo/wt/a");
    // created the empty anchor dir before mounting it
    expect(s.dirs).toContain(ANCHOR);
    // wrote the generated file, named DevTower.code-workspace, carrying the home root
    expect(s.writes).toHaveLength(1);
    expect(path.basename(s.writes[0].file)).toBe("DevTower.code-workspace");
    const json = JSON.parse(s.writes[0].content);
    expect(json.folders.map((f: any) => f.path)).toEqual([ANCHOR, "/repo/wt/a"]); // anchor pinned, root hidden
    expect(json.folders[0].name).toBe("(DevTower)"); // anchor's Explorer label
    expect(json.settings["devtower.homeRoot"]).toBe("/repo");
    // opened that workspace file (the one unavoidable reload), not a live mutation
    expect(s.opens).toHaveLength(1);
    expect(path.basename(s.opens[0])).toBe("DevTower.code-workspace");
    expect(s.updates).toHaveLength(0);
  });

  it("re-mounting the same worktree once managed is a no-op (no reload loop)", () => {
    const s = makeFake({ home: "/repo", folders: [ANCHOR, "/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    expect(isManaged()).toBe(true);
    mountWorktree("/repo/wt/a");
    expect(s.updates).toHaveLength(0);
    expect(s.opens).toHaveLength(0);
  });

  it("re-mounting a path that differs only by a trailing separator is a no-op", () => {
    // The no-op guard compares via norm(), which strips trailing separators (and
    // case-folds on Windows/macOS). A worktree reached as "/repo/wt/a/" must match
    // the live "/repo/wt/a" so a re-mount after a reload doesn't churn the folders.
    const s = makeFake({ home: "/repo", folders: [ANCHOR, "/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    mountWorktree("/repo/wt/a/");
    expect(s.updates).toHaveLength(0);
    expect(s.opens).toHaveLength(0);
  });

  it("switching worktrees swaps only the worktree slot, leaving folder[0] (no reload)", () => {
    const s = makeFake({ home: "/repo", folders: [ANCHOR, "/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    mountWorktree("/repo/wt/b");
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0].start).toBe(1); // anchor at folder[0] untouched → VS Code won't reload
    expect(s.updates[0].folders).toEqual(["/repo/wt/b"]);
    expect(s.folders).toEqual([ANCHOR, "/repo/wt/b"]);
    expect(s.opens).toHaveLength(0);
  });

  it("a legacy anchor-less workspace adopts the anchor once, then swaps are reload-free", () => {
    // pre-anchor workspaces have just [worktree]; the first mount must reinstate
    // the anchor at folder[0] (a one-time reload), and from then on stay pinned.
    const s = makeFake({ home: "/repo", folders: ["/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    mountWorktree("/repo/wt/a");
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0].start).toBe(0); // folder[0] changes → the one migration reload
    expect(s.folders).toEqual([ANCHOR, "/repo/wt/a"]);
  });

  it("toggleRoot reveals the project root between the anchor and the worktree", () => {
    const s = makeFake({ home: "/repo", folders: [ANCHOR, "/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    mountWorktree("/repo/wt/a"); // establish selection, already correct → no-op
    expect(s.updates).toHaveLength(0);
    toggleRoot();
    expect(s.modes.get("/repo")).toBe(true);
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0].start).toBe(1); // anchor stays at folder[0] → no reload
    expect(s.folders).toEqual([ANCHOR, "/repo", "/repo/wt/a"]); // anchor, root, worktree
    // and the on-disk file now lists all three, so a fresh open matches
    const lastWrite = JSON.parse(s.writes[s.writes.length - 1].content);
    expect(lastWrite.folders.map((f: any) => f.path)).toEqual([ANCHOR, "/repo", "/repo/wt/a"]);
  });

  it("toggleRoot is reversible — back to worktree only", () => {
    const s = makeFake({ home: "/repo", folders: [ANCHOR, "/repo", "/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    s.modes.set("/repo", true); // currently showing root
    mountWorktree("/repo/wt/a");
    toggleRoot();
    expect(s.modes.get("/repo")).toBe(false);
    expect(s.updates[s.updates.length - 1].start).toBe(1); // still pinned at folder[0]
    expect(s.folders).toEqual([ANCHOR, "/repo/wt/a"]);
  });

  it("sets the Explorer-toggle context keys to match the live folders", () => {
    const s = makeFake({ home: "/repo", folders: [ANCHOR, "/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    mountWorktree("/repo/wt/a"); // already correct → syncContext runs
    expect(s.ctx.get("devtower.inManagedWorkspace")).toBe(true);
    expect(s.ctx.get("devtower.workspaceShowingRoot")).toBe(false);
  });

  it("unmount leaves the DevTower workspace and reopens the project root", () => {
    const s = makeFake({ home: "/repo", folders: [ANCHOR, "/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    unmountWorktree();
    expect(s.opens).toEqual(["/repo"]);
  });

  it("does nothing when there is no project root to anchor (bare window)", () => {
    const s = makeFake({ home: undefined, folders: [], file: undefined });
    mountWorktree("/somewhere/wt/a");
    expect(s.writes).toHaveLength(0);
    expect(s.opens).toHaveLength(0);
    expect(s.updates).toHaveLength(0);
  });

  it("homeRoot reflects the host", () => {
    makeFake({ home: "/repo", folders: ["/repo"] });
    expect(homeRoot()).toBe("/repo");
  });
});
