import { describe, it, expect } from "vitest";
import {
  splitLines,
  parseStatusPorcelain,
  parseNumstat,
  parseWorktreeList,
  parseStashList,
} from "../src/git";

// These parsers turn raw git stdout into structured data. They are pure, so the
// point of testing them is cross-OS robustness: git output may arrive with LF
// or (on some Windows setups / piped tools) CRLF line endings, and a stray \r
// must never leak into a parsed path, branch name, or count.

describe("splitLines", () => {
  it("splits on LF", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });
  it("splits on CRLF without leaving a trailing \\r", () => {
    expect(splitLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
  });
  it("handles mixed endings", () => {
    expect(splitLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("parseStatusPorcelain", () => {
  it("buckets staged vs unstaged", () => {
    const out = ["M  staged.ts", " M unstaged.ts", "MM both.ts", "?? new.ts"].join("\n");
    const { staged, unstaged } = parseStatusPorcelain(out);
    expect(staged.map((f) => f.path).sort()).toEqual(["both.ts", "staged.ts"]);
    expect(unstaged.map((f) => f.path).sort()).toEqual(["both.ts", "new.ts", "unstaged.ts"]);
    expect(unstaged.find((f) => f.path === "new.ts")?.untracked).toBe(true);
  });

  it("uses the post-rename path", () => {
    const { staged } = parseStatusPorcelain("R  old.ts -> new.ts\n");
    expect(staged[0].path).toBe("new.ts");
  });

  it("unquotes paths with spaces/unicode", () => {
    const { unstaged } = parseStatusPorcelain('?? "a file.ts"\n');
    expect(unstaged[0].path).toBe("a file.ts");
  });

  it("does not leak a carriage return into the path on CRLF output", () => {
    const out = "M  staged.ts\r\n M unstaged.ts\r\n";
    const { staged, unstaged } = parseStatusPorcelain(out);
    expect(staged[0].path).toBe("staged.ts");
    expect(unstaged[0].path).toBe("unstaged.ts");
    // the regression this guards: "unstaged.ts\r"
    expect(unstaged[0].path.endsWith("\r")).toBe(false);
  });
});

describe("parseNumstat", () => {
  it("sums adds/dels per path", () => {
    const m = parseNumstat("3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n");
    expect(m.get("src/a.ts")).toEqual({ add: 3, del: 1 });
    expect(m.get("src/b.ts")).toEqual({ add: 10, del: 0 });
  });
  it("treats binary (- -) as zero", () => {
    const m = parseNumstat("-\t-\timg.png\n");
    expect(m.get("img.png")).toEqual({ add: 0, del: 0 });
  });
  it("keeps tabs inside a path intact", () => {
    const m = parseNumstat("1\t1\tweird\tname.ts\n");
    expect(m.get("weird\tname.ts")).toEqual({ add: 1, del: 1 });
  });
  it("is CRLF-safe", () => {
    const m = parseNumstat("3\t1\tsrc/a.ts\r\n");
    expect([...m.keys()]).toEqual(["src/a.ts"]);
  });
});

describe("parseWorktreeList", () => {
  it("parses path + branch rows", () => {
    const out = [
      "worktree /repo",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/feat-1",
      "branch refs/heads/devtower/feat-1",
      "",
    ].join("\n");
    const rows = parseWorktreeList(out);
    expect(rows).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/repo/.claude/worktrees/feat-1", branch: "devtower/feat-1" },
    ]);
  });
  it("marks detached worktrees", () => {
    const rows = parseWorktreeList("worktree /repo/wt\ndetached\n");
    expect(rows[0].branch).toBe("detached");
  });
  it("does not leave \\r in a branch name on CRLF output", () => {
    const rows = parseWorktreeList("worktree /repo\r\nbranch refs/heads/main\r\n");
    expect(rows[0].branch).toBe("main");
    expect(rows[0].path).toBe("/repo");
  });
});

describe("parseStashList", () => {
  it("splits ref from message", () => {
    const out = [
      "stash@{0}: WIP on main: 1a2b3c subject line",
      "stash@{1}: On feature: my saved work",
    ].join("\n");
    const rows = parseStashList(out);
    expect(rows).toEqual([
      { ref: "stash@{0}", message: "WIP on main: 1a2b3c subject line" },
      { ref: "stash@{1}", message: "On feature: my saved work" },
    ]);
  });
  it("returns [] for empty output", () => {
    expect(parseStashList("")).toEqual([]);
  });
  it("is CRLF-safe", () => {
    const rows = parseStashList("stash@{0}: WIP on main: x\r\n");
    expect(rows[0]).toEqual({ ref: "stash@{0}", message: "WIP on main: x" });
  });
});
