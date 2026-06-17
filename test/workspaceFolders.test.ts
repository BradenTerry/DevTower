import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
  setWorkspaceFolder,
  clearWorkspaceFolder,
  isWorkspaceFolder,
  __resetManaged,
} from "../src/workspaceFolders";

// `__setWorkspaceFolders`/`__reset` are test helpers on the hand-written vscode stub.
const setFolders = (vscode as any).__setWorkspaceFolders as (p: string[] | undefined) => void;
const reset = (vscode as any).__reset as () => void;
const paths = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

describe("workspaceFolders", () => {
  beforeEach(() => {
    reset();
    __resetManaged();
  });

  it("appends the worktree as a folder after the root, never at index 0", () => {
    setFolders(["/repo"]);
    expect(setWorkspaceFolder("/repo/.claude/worktrees/a")).toBe(true);
    expect(paths()).toEqual(["/repo", "/repo/.claude/worktrees/a"]);
  });

  it("owns ONE folder at a time — switching rooms swaps it, not accumulates", () => {
    setFolders(["/repo"]);
    setWorkspaceFolder("/repo/wt/a");
    setWorkspaceFolder("/repo/wt/b");
    expect(paths()).toEqual(["/repo", "/repo/wt/b"]);
  });

  it("is idempotent — re-mounting the current folder is a no-op", () => {
    setFolders(["/repo"]);
    setWorkspaceFolder("/repo/wt/a");
    expect(setWorkspaceFolder("/repo/wt/a")).toBe(false);
    expect(paths()).toEqual(["/repo", "/repo/wt/a"]);
  });

  it("matches folders regardless of a trailing separator", () => {
    setFolders(["/repo"]);
    setWorkspaceFolder("/repo/wt/a/");
    expect(isWorkspaceFolder("/repo/wt/a")).toBe(true);
    expect(setWorkspaceFolder("/repo/wt/a")).toBe(false);
  });

  it("does nothing when no workspace is open (adding folder[0] would restart the host)", () => {
    setFolders(undefined);
    expect(setWorkspaceFolder("/repo/wt/a")).toBe(false);
    expect(vscode.workspace.workspaceFolders).toBeUndefined();
  });

  it("clear unmounts the current folder and leaves the root intact", () => {
    setFolders(["/repo"]);
    setWorkspaceFolder("/repo/wt/a");
    expect(clearWorkspaceFolder()).toBe(true);
    expect(paths()).toEqual(["/repo"]);
  });

  it("clear with nothing mounted is a no-op", () => {
    setFolders(["/repo"]);
    expect(clearWorkspaceFolder()).toBe(false);
    expect(paths()).toEqual(["/repo"]);
  });

  it("never removes the root when swapping or clearing", () => {
    setFolders(["/repo"]);
    setWorkspaceFolder("/repo/wt/a");
    setWorkspaceFolder("/repo/wt/b");
    clearWorkspaceFolder();
    expect(paths()).toEqual(["/repo"]);
  });
});
