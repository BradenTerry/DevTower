import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { resolveCwd } from "../src/git";

// resolveCwd turns an agent's (possibly relative) worktree into an absolute path
// that exists. The absolute-vs-relative join is OS-sensitive, so exercise both.

const set = (paths: string[] | undefined) => (vscode as any).__setWorkspaceFolders(paths);
const agent = (worktree: string) => ({ worktree } as any);

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devtower-cwd-")));
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
    expect(resolved && fs.realpathSync(resolved)).toBe(fs.realpathSync(sub));
  });
});
