import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { resolveCwd, canonicalDir } from "../src/git";

// resolveCwd turns an agent's (possibly relative) worktree into an absolute path
// that exists. The absolute-vs-relative join is OS-sensitive, so exercise both.

const set = (paths: string[] | undefined) => (vscode as any).__setWorkspaceFolders(paths);
const agent = (worktree: string) => ({ worktree } as any);

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "devtower-cwd-")));
});
afterEach(() => {
  (vscode as any).__reset();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveCwd", () => {
  it("returns undefined when the agent has no worktree", () => {
    expect(resolveCwd(agent(""))).toBeUndefined();
  });

  it("returns an existing absolute worktree unchanged", () => {
    set(undefined);
    expect(resolveCwd(agent(tmp))).toBe(tmp);
  });

  it("returns undefined for an absolute path that does not exist", () => {
    set(undefined);
    const missing = path.join(tmp, "nope", "gone");
    expect(resolveCwd(agent(missing))).toBeUndefined();
  });

  it("resolves a relative worktree against the first workspace folder", () => {
    const sub = path.join(tmp, "packages", "api");
    fs.mkdirSync(sub, { recursive: true });
    set([tmp]);
    const resolved = resolveCwd(agent(path.join("packages", "api")));
    expect(resolved && fs.realpathSync.native(resolved)).toBe(fs.realpathSync.native(sub));
  });
});

// canonicalDir folds the path forms that diverge between a reserved room's stored
// path and the transcript's cwd, so the /cd relocation match (and room de-dup) is
// reliable. The symlink case is the exact bug: a reserved /Users/... vs Claude's
// canonical /private/... never matched under raw `===`.
describe("canonicalDir", () => {
  it("strips a trailing separator", () => {
    expect(canonicalDir(tmp + path.sep)).toBe(canonicalDir(tmp));
  });

  it("folds equivalent forms of the same directory", () => {
    expect(canonicalDir(path.join(tmp, "sub", ".."))).toBe(canonicalDir(tmp));
  });

  it("resolves symlinks so a linked path and its target match (the /cd bug)", () => {
    const link = `${tmp}-link`;
    fs.symlinkSync(tmp, link);
    try {
      expect(canonicalDir(link)).toBe(canonicalDir(tmp));
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("folds case on case-insensitive platforms", () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return;
    expect(canonicalDir(tmp.toUpperCase())).toBe(canonicalDir(tmp));
  });
});
