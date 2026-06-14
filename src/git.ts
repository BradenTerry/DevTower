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

/** Split command output into lines, tolerating CRLF as well as LF so parsing is
 *  identical on Windows (where some tools emit \r\n) and POSIX. Trailing \r is
 *  stripped from each line; no empty lines are dropped here (callers decide). */
export function splitLines(out: string): string[] {
  return out.split(/\r?\n/);
}

/** Parse `git status --porcelain` text into staged / unstaged buckets. Pure: no
 *  IO, so it can be unit-tested with canned git output on any OS. */
export function parseStatusPorcelain(out: string): { staged: GitFile[]; unstaged: GitFile[] } {
  const staged: GitFile[] = [];
  const unstaged: GitFile[] = [];
  for (const line of splitLines(out)) {
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
  return { staged, unstaged };
}

/** Parse `git <diff> --numstat` text into a path → {add,del} map. Binary files
 *  report "-\t-" and contribute 0. Pure. */
export function parseNumstat(out: string): Map<string, { add: number; del: number }> {
  const counts = new Map<string, { add: number; del: number }>();
  for (const line of splitLines(out)) {
    if (!line.trim()) continue;
    const [a, d, ...p] = line.split("\t");
    const file = p.join("\t");
    if (!file) continue;
    const prev = counts.get(file) ?? { add: 0, del: 0 };
    prev.add += a === "-" ? 0 : parseInt(a, 10) || 0;
    prev.del += d === "-" ? 0 : parseInt(d, 10) || 0;
    counts.set(file, prev);
  }
  return counts;
}

/** Parse `git worktree list --porcelain` into {path,branch} rows. Pure. */
export function parseWorktreeList(out: string): { path: string; branch: string }[] {
  const res: { path: string; branch: string }[] = [];
  let cur: { path: string; branch: string } | null = null;
  for (const line of splitLines(out)) {
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

export function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // GIT_OPTIONAL_LOCKS=0 stops read-only commands (status/diff/rev-list/log)
    // from rewriting .git/index to refresh the stat cache. Without it, every
    // refresh's `git status` dirties .git, which our recursive .git fs.watch
    // sees as a change and schedules another refresh — a self-feeding loop that
    // turns into a subprocess storm (and a frozen webview) once a second
    // instance, e.g. the debug Extension Dev Host, watches the same repo too.
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    execFile("git", args, { cwd, env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
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
/** Resolve a raw path (absolute, or relative to the first workspace folder) to
 *  an existing directory, or undefined. Shared by agent worktrees and room keys. */
export function resolveDir(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const abs = path.isAbsolute(raw)
    ? raw
    : base
      ? path.resolve(base, raw)
      : path.resolve(raw);
  return fs.existsSync(abs) ? abs : undefined;
}

export function resolveCwd(agent: Agent): string | undefined {
  return resolveDir(agent.worktree);
}

/** Parse `git status --porcelain` into staged / unstaged buckets. */
export async function status(cwd: string): Promise<GitStatus> {
  const root = await topLevel(cwd);
  const branch = await currentBranch(cwd);
  const out = await runGit(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  const { staged, unstaged } = parseStatusPorcelain(out);
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
  // No repo at cwd (e.g. an umbrella dir that merely contains repos) → []. status()
  // throws there, so swallow it and honor the documented empty-list contract.
  const st = await status(cwd).catch(() => null);
  if (!st) return [];
  const counts = new Map<string, { add: number; del: number }>();
  const numstat = async (args: string[]) => {
    let out = "";
    try {
      out = await runGit(cwd, args);
    } catch {
      return;
    }
    for (const [file, c] of parseNumstat(out)) {
      const prev = counts.get(file) ?? { add: 0, del: 0 };
      prev.add += c.add;
      prev.del += c.del;
      counts.set(file, prev);
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

/** Discard a file's working-tree changes (the SCM "Discard Changes" action). An
 *  untracked file is deleted; a tracked file is restored from the index/HEAD.
 *  The staged copy of a partially-staged file is left untouched. */
export async function discard(cwd: string, file: GitFile): Promise<void> {
  if (file.untracked) {
    await fs.promises.rm(path.join(cwd, file.path), { force: true });
    return;
  }
  await runGit(cwd, ["restore", "--worktree", "--", file.path]);
}

/** Discard working-tree changes under a pathspec (a file OR a directory): restore
 *  tracked files and remove untracked files/dirs beneath it. The index (staged
 *  changes) is left intact. `rel` is repo-relative; "." means the whole worktree. */
export async function discardPath(cwd: string, rel: string): Promise<void> {
  await runGit(cwd, ["restore", "--worktree", "--", rel]).catch(() => {});
  await runGit(cwd, ["clean", "-fd", "--", rel]).catch(() => {});
}

/** Discard EVERY working-tree change under `cwd`. The index is left intact. */
export async function discardAll(cwd: string): Promise<void> {
  await discardPath(cwd, ".");
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

/** Commit the staged index with `message`. `all` runs `commit -a` to also pick
 *  up tracked-but-unstaged edits (never untracked files). `amend` replaces the
 *  previous commit (`commit --amend`) instead of adding a new one. Throws on
 *  failure (e.g. nothing to commit) with git's reason. */
export async function commit(
  cwd: string,
  message: string,
  all = false,
  amend = false
): Promise<void> {
  const args = ["commit", "-m", message];
  if (amend) args.splice(1, 0, "--amend");
  if (all) args.splice(1, 0, "-a");
  await runGit(cwd, args);
}

/** Pull the current branch (`git pull`), used by "Commit & Sync" to integrate
 *  upstream before pushing. Throws git's reason on failure (e.g. conflicts). */
export async function pull(cwd: string): Promise<void> {
  await runGit(cwd, ["pull"]);
}

/** Push the current branch. Falls back to `push -u origin HEAD` on the first
 *  push so the upstream is set. Throws git's reason if both fail. */
export async function push(cwd: string): Promise<void> {
  try {
    await runGit(cwd, ["push"]);
  } catch {
    await runGit(cwd, ["push", "-u", "origin", "HEAD"]);
  }
}

/** Fetch remote refs quietly so behind/ahead counts reflect upstream. */
export async function fetch(cwd: string): Promise<void> {
  await runGit(cwd, ["fetch", "--quiet"]);
}

export interface StashEntry {
  /** the stash ref, e.g. "stash@{0}" */
  ref: string;
  /** the human description git prints after the ref */
  message: string;
}

/** Parse `git stash list` text into {ref, message} rows. A line looks like
 *  `stash@{0}: WIP on main: 1a2b3c subject`. Pure. */
export function parseStashList(out: string): StashEntry[] {
  const res: StashEntry[] = [];
  for (const line of splitLines(out)) {
    if (!line.trim()) continue;
    const sep = line.indexOf(": ");
    if (sep === -1) {
      res.push({ ref: line.trim(), message: "" });
    } else {
      res.push({ ref: line.slice(0, sep).trim(), message: line.slice(sep + 2).trim() });
    }
  }
  return res;
}

/** List the repo's stash entries (newest first), [] on error / no stashes. */
export async function stashList(cwd: string): Promise<StashEntry[]> {
  try {
    return parseStashList(await runGit(cwd, ["stash", "list"]));
  } catch {
    return [];
  }
}

/** Stash the working tree. Includes untracked files (`-u`) so a fresh file is
 *  shelved too. Optional `message` labels the entry. Throws if there is nothing
 *  to stash. */
export async function stashSave(cwd: string, message?: string): Promise<void> {
  const args = ["stash", "push", "-u"];
  if (message) args.push("-m", message);
  await runGit(cwd, args);
}

/** Re-apply a stash and drop it from the list. */
export async function stashPop(cwd: string, ref: string): Promise<void> {
  await runGit(cwd, ["stash", "pop", ref]);
}

/** Re-apply a stash, leaving it in the list. */
export async function stashApply(cwd: string, ref: string): Promise<void> {
  await runGit(cwd, ["stash", "apply", ref]);
}

/** Delete a stash without applying it. */
export async function stashDrop(cwd: string, ref: string): Promise<void> {
  await runGit(cwd, ["stash", "drop", ref]);
}

/** Append a file/dir to the worktree-root `.gitignore` (the same file VS Code's
 *  Git "Add to .gitignore" writes). `rel` is the repo-relative path with forward
 *  slashes; a directory gets a trailing "/". No-op if the entry is already there. */
export async function addToGitignore(cwd: string, rel: string, isDir: boolean): Promise<void> {
  const top = await topLevel(cwd).catch(() => cwd);
  const entry = isDir ? rel.replace(/\/?$/, "/") : rel;
  const file = path.join(top, ".gitignore");
  let content = "";
  try {
    content = await fs.promises.readFile(file, "utf8");
  } catch {
    /* no .gitignore yet — it will be created */
  }
  if (splitLines(content).some((l) => l.trim() === entry)) return; // already ignored
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  await fs.promises.appendFile(file, prefix + entry + "\n");
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

// Word pools for Claude-style worktree slugs (e.g. "happy-dancing-flask"):
// adjective + gerund + noun, hyphen-joined. Kept generous so three-word combos
// rarely collide and read as friendly, unique handles.
const WT_ADJECTIVES = [
  "happy", "brave", "calm", "eager", "fancy", "gentle", "jolly", "keen",
  "lively", "merry", "nimble", "proud", "quick", "swift", "witty", "bold",
  "bright", "clever", "cosmic", "daring", "lucky", "mellow", "noble", "plucky",
  "quiet", "rapid", "shiny", "snappy", "spry", "sunny", "vivid", "zesty",
];
const WT_GERUNDS = [
  "dancing", "running", "jumping", "soaring", "gleaming", "roaming", "drifting",
  "leaping", "glowing", "humming", "racing", "sailing", "spinning", "gliding",
  "darting", "beaming", "floating", "prancing", "skipping", "whirling",
  "bouncing", "coasting", "diving", "flowing", "gallops", "hopping", "rolling",
  "wandering",
];
const WT_NOUNS = [
  "flask", "comet", "falcon", "harbor", "lantern", "meadow", "otter", "pebble",
  "quartz", "river", "summit", "willow", "badger", "cedar", "ember", "fjord",
  "glacier", "heron", "ibis", "jasper", "kestrel", "lynx", "maple", "nimbus",
  "onyx", "pine", "raven", "sparrow", "thistle", "vortex", "walrus", "zephyr",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** A random Claude-style worktree slug, e.g. "swift-gliding-heron". */
function worktreeSlug(): string {
  return `${pick(WT_ADJECTIVES)}-${pick(WT_GERUNDS)}-${pick(WT_NOUNS)}`;
}

export async function worktreeAdd(dir: string): Promise<{ wtPath: string; branch: string; base: string }> {
  // worktrees live under <repo>/.claude/worktrees/ (kept out of git status via
  // .git/info/exclude) rather than littering the parent directory
  const top = await topLevel(dir).catch(() => dir);
  const wtRoot = path.join(top, ".claude", "worktrees");
  await ensureExcluded(dir, ".claude/worktrees/");
  // Name the worktree with a Claude-style three-word slug. Regenerate on the
  // off chance the dir or branch already exists (a prior run, or a collision).
  let slug = worktreeSlug();
  let wtPath = path.join(wtRoot, slug);
  let branch = `devtower/${slug}`;
  for (let tries = 0; tries < 100 && (fs.existsSync(wtPath) || (await branchExists(dir, branch))); tries++) {
    slug = worktreeSlug();
    wtPath = path.join(wtRoot, slug);
    branch = `devtower/${slug}`;
  }
  // record the fork point (current HEAD) so the board can count only the commits
  // made IN this worktree, not the ones it inherits from the branch it's cut from
  const base = (await runGit(dir, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  await runGit(dir, ["worktree", "add", wtPath, "-b", branch]);
  return { wtPath, branch, base };
}

/** Create an isolated worktree to review a PR in, WITHOUT touching the main
 *  checkout. The worktree is added detached at HEAD; the caller then runs
 *  `gh pr checkout <n>` inside it to bring the PR branch (handles forks) into
 *  that worktree only. Returns the path + the fork-point sha (so the board can
 *  count just the review worktree's own commits). */
export async function worktreeForPr(dir: string, prNumber: number): Promise<{ wtPath: string; base: string }> {
  const top = await topLevel(dir).catch(() => dir);
  const wtRoot = path.join(top, ".claude", "worktrees");
  await ensureExcluded(dir, ".claude/worktrees/");
  let i = 0;
  let wtPath = path.join(wtRoot, `pr-${prNumber}`);
  while (fs.existsSync(wtPath) && i < 100) {
    i++;
    wtPath = path.join(wtRoot, `pr-${prNumber}-${i}`);
  }
  const base = (await runGit(dir, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  await runGit(dir, ["worktree", "add", "--detach", wtPath]);
  return { wtPath, base };
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
  for (const c of parseNumstat(out).values()) {
    add += c.add;
    del += c.del;
  }
  return { add, del };
}

/** Per-checkout summary for the room board: modified vs staged file counts (kept
 *  separate so staging doesn't muddy the numbers), commits ahead + recent log. */
export async function branchSummary(cwd: string, forkBase?: string): Promise<BranchSummary | null> {
  const st = await status(cwd).catch(() => null);
  if (!st) return null;
  // Resolve the BASE branch a PR would target (the remote default branch), used
  // for the header name and — for a normal checkout — the commit count. origin/HEAD
  // is the remote default (usually origin/main); fall back to common names.
  let prBaseRef = "";
  for (const base of ["origin/HEAD", "origin/main", "origin/master", "@{upstream}", "main", "master"]) {
    try {
      if (Number.isNaN(parseInt((await runGit(cwd, ["rev-list", "--count", `${base}..HEAD`])).trim(), 10))) continue;
      prBaseRef = base;
      break;
    } catch {
      /* ref doesn't exist here — try the next */
    }
  }
  // The commit count + committed churn are measured from the worktree's FORK
  // POINT when known (its OWN commits — a fresh worktree reads 0, not the commits
  // it inherited from the branch it was cut from), else from the PR base branch.
  const countBase = forkBase || prBaseRef;
  let ahead = 0;
  if (countBase) {
    ahead = parseInt((await runGit(cwd, ["rev-list", "--count", `${countBase}..HEAD`]).catch(() => "0")).trim(), 10) || 0;
  }
  let commits: string[] = [];
  try {
    commits = splitLines(await runGit(cwd, ["log", "-12", "--format=%s"])).map((s) => s.trim()).filter(Boolean);
  } catch {
    /* empty repo with no commits */
  }
  // line churn, split by stage: unstaged is working-tree vs index, staged is
  // index vs HEAD. (untracked files don't show in diff --numstat, so their
  // additions aren't counted here — the file COUNT still reflects them.)
  const unstaged = await numstatTotals(cwd, ["diff", "--numstat"]);
  const stagedLines = await numstatTotals(cwd, ["diff", "--cached", "--numstat"]);
  // three-dot: diff against the MERGE-BASE of countBase and HEAD, matching the
  // rev-list count above. Two-dot here would diff tip-to-tip, which reads +0/-0
  // when the base ref has diverged but happens to share HEAD's tree.
  const committed = countBase
    ? await numstatTotals(cwd, ["diff", "--numstat", `${countBase}...HEAD`])
    : { add: 0, del: 0 };
  // friendly base branch name for the board header (what this branch targets)
  let base = prBaseRef;
  if (prBaseRef === "origin/HEAD") {
    base = (await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim() || prBaseRef;
  } else if (prBaseRef === "@{upstream}") {
    base = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => "")).trim() || prBaseRef;
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
  return parseWorktreeList(out);
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
