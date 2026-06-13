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
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      // git puts the useful reason ("fatal: ...") on stderr; surface that
      if (err) reject(new Error((String(stderr).trim() || err.message).trim()));
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
async function branchExists(dir: string, branch: string): Promise<boolean> {
  try {
    await runGit(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true; // exit 0 → the ref exists
  } catch {
    return false;
  }
}

/** Add `pattern` to the repo's local `.git/info/exclude` (untracked, never
 *  committed) so the in-repo worktrees dir doesn't show up as changes. */
async function ensureExcluded(dir: string, pattern: string): Promise<void> {
  try {
    const common = (await runGit(dir, ["rev-parse", "--git-common-dir"])).trim();
    const gitDir = path.isAbsolute(common) ? common : path.join(dir, common);
    const file = path.join(gitDir, "info", "exclude");
    let content = "";
    try {
      content = await fs.promises.readFile(file, "utf8");
    } catch {
      /* file may not exist yet */
    }
    if (content.split("\n").some((l) => l.trim() === pattern)) return;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, (content && !content.endsWith("\n") ? "\n" : "") + pattern + "\n");
  } catch {
    /* best effort — worktree still works without it */
  }
}

export async function worktreeAdd(dir: string, name: string, n: number): Promise<{ wtPath: string; branch: string }> {
  // worktrees live under <repo>/.claude/worktrees/ (kept out of git status via
  // .git/info/exclude) rather than littering the parent directory
  const top = await topLevel(dir).catch(() => dir);
  const wtRoot = path.join(top, ".claude", "worktrees");
  await ensureExcluded(dir, ".claude/worktrees/");
  // pick a directory + branch that don't already exist — a prior attempt can
  // leave one behind, and n collides after agents are removed/re-added
  let i = n;
  let wtPath = path.join(wtRoot, `${name}-${i}`);
  let branch = `devtower/${name}-${i}`;
  for (let tries = 0; tries < 100 && (fs.existsSync(wtPath) || (await branchExists(dir, branch))); tries++) {
    i++;
    wtPath = path.join(wtRoot, `${name}-${i}`);
    branch = `devtower/${name}-${i}`;
  }
  await runGit(dir, ["worktree", "add", wtPath, "-b", branch]);
  return { wtPath, branch };
}

export interface BranchSummary {
  modified: number; // working-tree (unstaged) changed files
  staged: number; // index (staged) files
  modifiedFiles: string[];
  stagedFiles: string[];
  unstagedAdd: number; // lines added across unstaged changes
  unstagedDel: number; // lines removed across unstaged changes
  stagedAdd: number; // lines added across staged changes
  stagedDel: number; // lines removed across staged changes
  committedAdd: number; // lines added across commits ahead of base
  committedDel: number; // lines removed across commits ahead of base
  base: string; // friendly name of the base branch (e.g. "main"); "" if unknown
  ahead: number; // commits ahead of base branch (the PR size)
  unpushed: number; // local commits not on the branch's own remote (to push)
  behind: number; // commits the branch's remote has that local doesn't (to pull)
  commits: string[]; // recent commit subjects (newest first)
}

/** Sum added/removed lines from a `git <diff> --numstat` run. Binary files
 *  report "-\t-" and contribute nothing. Returns {add:0,del:0} on any error. */
async function numstatTotals(cwd: string, args: string[]): Promise<{ add: number; del: number }> {
  let out = "";
  try {
    out = await runGit(cwd, args);
  } catch {
    return { add: 0, del: 0 };
  }
  let add = 0, del = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [a, d] = line.split("\t");
    add += a === "-" ? 0 : parseInt(a, 10) || 0;
    del += d === "-" ? 0 : parseInt(d, 10) || 0;
  }
  return { add, del };
}

/** Per-checkout summary for the room board: modified vs staged file counts (kept
 *  separate so staging doesn't muddy the numbers), commits ahead + recent log. */
export async function branchSummary(cwd: string): Promise<BranchSummary | null> {
  const st = await status(cwd).catch(() => null);
  if (!st) return null;
  // Count commits against the BASE branch a PR would target (the remote default
  // branch), not the branch's own upstream — once the feature branch is pushed,
  // `@{upstream}..HEAD` is 0 even though the PR still has commits. origin/HEAD is
  // the remote default (usually origin/main); fall back to common names, then to
  // the upstream/local default as a last resort.
  let ahead = 0;
  let baseRef = ""; // the base the ahead/committed churn is measured against
  for (const base of ["origin/HEAD", "origin/main", "origin/master", "@{upstream}", "main", "master"]) {
    try {
      const n = parseInt((await runGit(cwd, ["rev-list", "--count", `${base}..HEAD`])).trim(), 10);
      if (Number.isNaN(n)) continue;
      ahead = n;
      baseRef = base;
      break;
    } catch {
      /* ref doesn't exist here — try the next */
    }
  }
  let commits: string[] = [];
  try {
    commits = (await runGit(cwd, ["log", "-12", "--format=%s"])).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    /* empty repo with no commits */
  }
  // line churn, split by stage: unstaged is working-tree vs index, staged is
  // index vs HEAD. (untracked files don't show in diff --numstat, so their
  // additions aren't counted here — the file COUNT still reflects them.)
  const unstaged = await numstatTotals(cwd, ["diff", "--numstat"]);
  const stagedLines = await numstatTotals(cwd, ["diff", "--cached", "--numstat"]);
  // committed churn: total +/- across the commits ahead of the base. No base
  // (no upstream) → nothing to compare against, so it stays zero.
  const committed = baseRef
    ? await numstatTotals(cwd, ["diff", "--numstat", `${baseRef}..HEAD`])
    : { add: 0, del: 0 };
  // friendly base branch name for the board header (what this branch targets)
  let base = baseRef;
  if (baseRef === "origin/HEAD") {
    base = (await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim() || baseRef;
  } else if (baseRef === "@{upstream}") {
    base = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => "")).trim() || baseRef;
  }
  base = base.replace(/^origin\//, "");
  // push/pull state vs the branch's OWN remote (origin/<branch>): how many local
  // commits aren't pushed, and how many remote commits we haven't pulled
  let unpushed = 0, behind = 0;
  try {
    const lr = (await runGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).trim();
    const [bh, ah] = lr.split(/\s+/).map((n) => parseInt(n, 10) || 0);
    behind = bh; unpushed = ah;
  } catch {
    unpushed = ahead; // no upstream → all branch commits are unpushed local work
  }
  return {
    modified: st.unstaged.length,
    staged: st.staged.length,
    modifiedFiles: st.unstaged.map((f) => f.path),
    stagedFiles: st.staged.map((f) => f.path),
    unstagedAdd: unstaged.add,
    unstagedDel: unstaged.del,
    stagedAdd: stagedLines.add,
    stagedDel: stagedLines.del,
    committedAdd: committed.add,
    committedDel: committed.del,
    base,
    ahead,
    unpushed,
    behind,
    commits,
  };
}

/** List the worktrees of the repo at `dir` (including the main checkout) as
 *  {path, branch}. Empty / non-repo dirs return []. */
export async function worktreeList(dir: string): Promise<{ path: string; branch: string }[]> {
  let out = "";
  try {
    out = await runGit(dir, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const res: { path: string; branch: string }[] = [];
  let cur: { path: string; branch: string } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) res.push(cur);
      cur = { path: line.slice(9).trim(), branch: "" };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "").trim();
    } else if (line.startsWith("detached") && cur) {
      cur.branch = "detached";
    }
  }
  if (cur) res.push(cur);
  return res;
}

/** Remove a git worktree (force, to drop dirty/locked ones) and optionally its
 *  branch. `repoDir` is any checkout of the same repo; the worktree being removed
 *  must not be `repoDir` itself. Best-effort branch delete — never fatal. */
export async function worktreeRemove(
  repoDir: string,
  wtPath: string,
  branch?: string
): Promise<void> {
  await runGit(repoDir, ["worktree", "remove", "--force", wtPath]);
  if (branch && !/^(main|master|head|develop|trunk)$/i.test(branch)) {
    try {
      await runGit(repoDir, ["branch", "-D", branch]);
    } catch {
      /* branch may be checked out elsewhere or already gone */
    }
  }
}

/** Content of a file at a ref (e.g. "HEAD", ":0" for index). "" if absent. */
export async function show(cwd: string, ref: string, file: string): Promise<string> {
  try {
    return await runGit(cwd, ["show", `${ref}:${file}`]);
  } catch {
    return "";
  }
}
