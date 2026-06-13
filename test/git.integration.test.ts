import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isRepo,
  currentBranch,
  topLevel,
  status,
  changedFiles,
  branchSummary,
  show,
  stage,
  unstage,
  worktreeAdd,
  worktreeList,
  worktreeRemove,
} from "../src/git";
import { makeTempRepo, seedCommit, TempRepo } from "./helpers";

// End-to-end against a real git repo created in the OS temp dir. This is the
// highest-value cross-OS coverage: it runs byte-for-byte the same git plumbing
// and path handling on every runner in the CI matrix, so a Windows-only
// path-separator or line-ending bug surfaces here.

const real = (p: string) => fs.realpathSync(p); // macOS tmp is a symlink

let repo: TempRepo;
beforeEach(() => {
  repo = makeTempRepo();
});
afterEach(() => {
  repo.cleanup();
});

describe("repo basics", () => {
  it("detects a repo and a non-repo", async () => {
    seedCommit(repo);
    expect(await isRepo(repo.dir)).toBe(true);
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-norepo-"));
    try {
      expect(await isRepo(notRepo)).toBe(false);
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("reports the current branch and toplevel", async () => {
    seedCommit(repo);
    expect(await currentBranch(repo.dir)).toBe("main");
    expect(real(await topLevel(repo.dir))).toBe(real(repo.dir));
  });
});

describe("status + changedFiles", () => {
  it("buckets staged, unstaged, and untracked files", async () => {
    seedCommit(repo, "tracked.ts", "a\nb\nc\n");
    repo.write("tracked.ts", "a\nB\nc\nd\n"); // modify (unstaged)
    repo.write("staged.ts", "new\n");
    repo.git("add", "staged.ts"); // staged add
    repo.write("untracked.ts", "x\n"); // untracked

    const st = await status(repo.dir);
    expect(st.branch).toBe("main");
    expect(st.staged.map((f) => f.path)).toContain("staged.ts");
    expect(st.unstaged.map((f) => f.path).sort()).toEqual(["tracked.ts", "untracked.ts"]);
    expect(st.unstaged.find((f) => f.path === "untracked.ts")?.untracked).toBe(true);

    const changes = await changedFiles(repo.dir);
    const tracked = changes.find((c) => c.path === "tracked.ts");
    expect(tracked).toBeTruthy();
    // one line changed + one added in the working tree
    expect(tracked!.add).toBeGreaterThan(0);
  });

  it("returns [] for a directory that is not a repo root", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-plain-"));
    try {
      expect(await changedFiles(plain)).toEqual([]);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("stage / unstage", () => {
  it("moves a file into and out of the index", async () => {
    seedCommit(repo);
    repo.write("f.ts", "content\n");
    await stage(repo.dir, "f.ts");
    let st = await status(repo.dir);
    expect(st.staged.map((f) => f.path)).toContain("f.ts");

    await unstage(repo.dir, "f.ts");
    st = await status(repo.dir);
    expect(st.staged.map((f) => f.path)).not.toContain("f.ts");
    expect(st.unstaged.map((f) => f.path)).toContain("f.ts");
  });
});

describe("show", () => {
  it("returns file content at HEAD and '' for a missing path", async () => {
    seedCommit(repo, "a.txt", "first\n");
    expect(await show(repo.dir, "HEAD", "a.txt")).toBe("first\n");
    expect(await show(repo.dir, "HEAD", "does-not-exist.txt")).toBe("");
  });
});

describe("worktrees", () => {
  it("adds, lists, and removes a worktree", async () => {
    seedCommit(repo);
    const { wtPath, branch, base } = await worktreeAdd(repo.dir, "feat", 1);

    // lives under <repo>/.claude/worktrees and gets a devtower/* branch
    expect(real(path.dirname(path.dirname(wtPath)))).toBe(real(path.join(repo.dir, ".claude")));
    expect(branch).toMatch(/^devtower\/feat-\d+$/);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(wtPath)).toBe(true);

    const list = await worktreeList(repo.dir);
    const paths = list.map((w) => real(w.path));
    expect(paths).toContain(real(repo.dir));
    expect(paths).toContain(real(wtPath));
    expect(list.find((w) => real(w.path) === real(wtPath))?.branch).toBe(branch);

    await worktreeRemove(repo.dir, wtPath, branch);
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it("does not collide when the same name is requested twice", async () => {
    seedCommit(repo);
    const a = await worktreeAdd(repo.dir, "feat", 1);
    const b = await worktreeAdd(repo.dir, "feat", 1);
    expect(a.wtPath).not.toBe(b.wtPath);
    expect(a.branch).not.toBe(b.branch);
  });
});

describe("branchSummary", () => {
  it("counts a worktree's own commits from its fork point", async () => {
    seedCommit(repo, "base.txt", "base\n");
    const { wtPath, base } = await worktreeAdd(repo.dir, "feat", 1);

    // commit two new lines inside the worktree
    fs.writeFileSync(path.join(wtPath, "feature.ts"), "one\ntwo\n");
    repo.git("-C", wtPath, "add", "-A");
    repo.git("-C", wtPath, "commit", "-m", "feature work");

    const sum = await branchSummary(wtPath, base);
    expect(sum).not.toBeNull();
    expect(sum!.ahead).toBe(1); // exactly the worktree's own commit
    expect(sum!.committedAdd).toBeGreaterThanOrEqual(2);
    expect(sum!.commits[0]).toBe("feature work");
  });

  it("returns null for a non-repo directory", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-plain2-"));
    try {
      expect(await branchSummary(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
