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
    updates: [] as { deleteCount: number; folders: string[] }[],
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
    updateFolders: (deleteCount, folders) => {
      state.updates.push({ deleteCount, folders: folders.map((f) => f.uri.fsPath) });
      state.folders = folders.map((f) => f.uri.fsPath); // simulate the reload result
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

  it("first USE DIR from a folder window opens the named DevTower workspace, worktree only", () => {
    const s = makeFake({ home: "/repo", folders: ["/repo"], file: undefined });
    mountWorktree("/repo/wt/a");
    // wrote the generated file, named DevTower.code-workspace, carrying the home root
    expect(s.writes).toHaveLength(1);
    expect(path.basename(s.writes[0].file)).toBe("DevTower.code-workspace");
    const json = JSON.parse(s.writes[0].content);
    expect(json.folders.map((f: any) => f.path)).toEqual(["/repo/wt/a"]); // root hidden by default
    expect(json.settings["devtower.homeRoot"]).toBe("/repo");
    // opened that workspace file (a reload), not a live folder mutation
    expect(s.opens).toHaveLength(1);
    expect(path.basename(s.opens[0])).toBe("DevTower.code-workspace");
    expect(s.updates).toHaveLength(0);
  });

  it("re-mounting the same worktree once managed is a no-op (no reload loop)", () => {
    const s = makeFake({ home: "/repo", folders: ["/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    expect(isManaged()).toBe(true);
    mountWorktree("/repo/wt/a");
    expect(s.updates).toHaveLength(0);
    expect(s.opens).toHaveLength(0);
  });

  it("re-mounting a path that differs only by a trailing separator is a no-op", () => {
    // The no-op guard compares via norm(), which strips trailing separators (and
    // case-folds on Windows/macOS). A worktree reached as "/repo/wt/a/" must match
    // the live "/repo/wt/a" so a re-mount after a reload doesn't churn the folders.
    const s = makeFake({ home: "/repo", folders: ["/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    mountWorktree("/repo/wt/a/");
    expect(s.updates).toHaveLength(0);
    expect(s.opens).toHaveLength(0);
  });

  it("switching worktrees while managed swaps the folder set (one reload)", () => {
    const s = makeFake({ home: "/repo", folders: ["/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    mountWorktree("/repo/wt/b");
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0].folders).toEqual(["/repo/wt/b"]);
    expect(s.opens).toHaveLength(0);
  });

  it("toggleRoot reveals the project root alongside the worktree", () => {
    const s = makeFake({ home: "/repo", folders: ["/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    mountWorktree("/repo/wt/a"); // establish selection, already correct → no-op
    expect(s.updates).toHaveLength(0);
    toggleRoot();
    expect(s.modes.get("/repo")).toBe(true);
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0].folders).toEqual(["/repo", "/repo/wt/a"]); // root first, worktree second
    // and the on-disk file now lists both, so a fresh open matches
    const lastWrite = JSON.parse(s.writes[s.writes.length - 1].content);
    expect(lastWrite.folders.map((f: any) => f.path)).toEqual(["/repo", "/repo/wt/a"]);
  });

  it("toggleRoot is reversible — back to worktree only", () => {
    const s = makeFake({ home: "/repo", folders: ["/repo", "/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    s.modes.set("/repo", true); // currently showing root
    mountWorktree("/repo/wt/a");
    toggleRoot();
    expect(s.modes.get("/repo")).toBe(false);
    expect(s.updates[s.updates.length - 1].folders).toEqual(["/repo/wt/a"]);
  });

  it("sets the Explorer-toggle context keys to match the live folders", () => {
    const s = makeFake({ home: "/repo", folders: ["/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
    mountWorktree("/repo/wt/a"); // already correct → syncContext runs
    expect(s.ctx.get("devtower.inManagedWorkspace")).toBe(true);
    expect(s.ctx.get("devtower.workspaceShowingRoot")).toBe(false);
  });

  it("unmount leaves the DevTower workspace and reopens the project root", () => {
    const s = makeFake({ home: "/repo", folders: ["/repo/wt/a"], file: "/gs/workspaces/x/DevTower.code-workspace" });
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
