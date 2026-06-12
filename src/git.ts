import { execFile } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { Agent } from "./store";

export interface GitFile {
  /** repo-relative path */
  path: string;
  /** index (staged) status letter, " " if none */
  index: string;
  /** worktree (unstaged) status letter, " " if none */
  work: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  root: string;
  branch: string;
  staged: GitFile[];
  unstaged: GitFile[];
}

export function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export async function topLevel(cwd: string): Promise<string> {
  return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  try {
    return (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    return "HEAD";
  }
}

/**
 * Resolve an agent's worktree to an absolute path on disk. Diffs, status, and
 * terminals are ALL rooted here — never the VS Code workspace / cwd. A relative
 * worktree is resolved against the first workspace folder only as a base for
 * joining; the result must still point at the agent's own worktree. Returns
 * undefined if that path does not exist (caller then falls back to mock diff),
 * so we never silently operate against the wrong repository.
 */
export function resolveCwd(agent: Agent): string | undefined {
  if (!agent.worktree) return undefined;
  const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const abs = path.isAbsolute(agent.worktree)
    ? agent.worktree
    : base
      ? path.resolve(base, agent.worktree)
      : path.resolve(agent.worktree);
  return fs.existsSync(abs) ? abs : undefined;
}

/** Parse `git status --porcelain` into staged / unstaged buckets. */
export async function status(cwd: string): Promise<GitStatus> {
  const root = await topLevel(cwd);
  const branch = await currentBranch(cwd);
  const out = await runGit(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  const staged: GitFile[] = [];
  const unstaged: GitFile[] = [];

  for (const line of out.split("\n")) {
    if (!line) continue;
    const index = line[0];
    const work = line[1];
    let p = line.slice(3);
    // handle "orig -> new" for renames/copies
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4);
    p = p.replace(/^"(.*)"$/, "$1");

    const untracked = index === "?" && work === "?";
    const file: GitFile = {
      path: p,
      index,
      work,
      staged: index !== " " && index !== "?",
      unstaged: untracked || (work !== " " && work !== "?"),
      untracked,
    };
    if (file.staged) staged.push({ ...file });
    if (file.unstaged) unstaged.push({ ...file });
  }
  return { root, branch, staged, unstaged };
}

export interface ChangeSummary {
  path: string;
  add: number;
  del: number;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

/**
 * Flat changed-file list with +/- counts, for the console Changes tab.
 *
 * NOTE: this assumes `cwd` (the agent's worktree) is a git repo root. When an
 * agent runs from an umbrella directory that merely *contains* repos (e.g. a
 * ~/Projects folder), git finds no repo at `cwd` and this returns []. Nested
 * child repos are intentionally not scanned — the panel reflects one worktree,
 * so changes only appear when the agent's cwd is itself a repo root.
 */
export async function changedFiles(cwd: string): Promise<ChangeSummary[]> {
  const st = await status(cwd);
  const counts = new Map<string, { add: number; del: number }>();
  const numstat = async (args: string[]) => {
    let out = "";
    try {
      out = await runGit(cwd, args);
    } catch {
      return;
    }
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [a, d, ...p] = line.split("\t");
      const path = p.join("\t");
      const prev = counts.get(path) ?? { add: 0, del: 0 };
      prev.add += a === "-" ? 0 : parseInt(a, 10) || 0;
      prev.del += d === "-" ? 0 : parseInt(d, 10) || 0;
      counts.set(path, prev);
    }
  };
  await numstat(["diff", "--numstat"]);
  await numstat(["diff", "--cached", "--numstat"]);

  const merged = new Map<string, ChangeSummary>();
  const add = (f: GitFile) => {
    const c = counts.get(f.path) ?? { add: 0, del: 0 };
    const ex = merged.get(f.path);
    merged.set(f.path, {
      path: f.path,
      add: c.add,
      del: c.del,
      staged: f.staged || !!ex?.staged,
      unstaged: f.unstaged || !!ex?.unstaged,
      untracked: f.untracked || !!ex?.untracked,
    });
  };
  st.staged.forEach(add);
  st.unstaged.forEach(add);
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function stage(cwd: string, file: string): Promise<void> {
  await runGit(cwd, ["add", "--", file]);
}

export async function unstage(cwd: string, file: string): Promise<void> {
  await runGit(cwd, ["reset", "-q", "HEAD", "--", file]);
}

export async function stageAll(cwd: string): Promise<void> {
  await runGit(cwd, ["add", "-A"]);
}

export async function unstageAll(cwd: string): Promise<void> {
  await runGit(cwd, ["reset", "-q", "HEAD", "--"]);
}

/** Create a new worktree + branch off the repo at `dir`. Returns the worktree path. */
export async function worktreeAdd(dir: string, name: string, n: number): Promise<{ wtPath: string; branch: string }> {
  const wtPath = path.resolve(dir, "..", `${name}-devtower-${n}`);
  const branch = `devtower/${name}-${n}`;
  await runGit(dir, ["worktree", "add", wtPath, "-b", branch]);
  return { wtPath, branch };
}

/** Content of a file at a ref (e.g. "HEAD", ":0" for index). "" if absent. */
export async function show(cwd: string, ref: string, file: string): Promise<string> {
  try {
    return await runGit(cwd, ["show", `${ref}:${file}`]);
  } catch {
    return "";
  }
}
