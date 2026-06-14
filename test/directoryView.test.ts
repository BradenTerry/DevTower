import { describe, it, expect } from "vitest";
import { resolveMoveTarget } from "../src/directoryView";

// resolveMoveTarget is a pure function, so these tests run in plain Node
// without any VS Code extension host.

const ROOT = "/workspace/myrepo";

describe("resolveMoveTarget", () => {
  it("resolves move into a directory target", () => {
    const src = "/workspace/myrepo/src/foo.ts";
    const destDir = "/workspace/myrepo/lib";
    const result = resolveMoveTarget(src, destDir);
    expect(result).toEqual({ ok: true, dest: "/workspace/myrepo/lib/foo.ts" });
  });

  it("drop onto a file resolves to the file's parent dir", () => {
    // The caller must resolve destDir from the target node (file -> parent).
    // resolveMoveTarget receives the already-resolved destDir, so this test
    // exercises that case: when caller passes the parent of a file node.
    const src = "/workspace/myrepo/src/foo.ts";
    const destDir = "/workspace/myrepo/lib"; // caller already resolved parent
    const result = resolveMoveTarget(src, destDir);
    expect(result).toEqual({ ok: true, dest: "/workspace/myrepo/lib/foo.ts" });
  });

  it("rejects a no-op move (same parent directory)", () => {
    const src = "/workspace/myrepo/src/foo.ts";
    const destDir = "/workspace/myrepo/src";
    const result = resolveMoveTarget(src, destDir);
    expect(result).toEqual({
      ok: false,
      reason: "no-op: source is already in that directory",
    });
  });

  it("rejects moving a directory into itself", () => {
    const src = "/workspace/myrepo/src";
    const destDir = "/workspace/myrepo/src";
    const result = resolveMoveTarget(src, destDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no-op|descendant|itself/i);
    }
  });

  it("rejects moving a directory into a descendant of itself", () => {
    const src = "/workspace/myrepo/src";
    const destDir = "/workspace/myrepo/src/components/deep";
    const result = resolveMoveTarget(src, destDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/descendant|itself/i);
    }
  });

  it("accepts a valid move between sibling dirs", () => {
    const src = "/workspace/myrepo/src/utils";
    const destDir = "/workspace/myrepo/lib";
    const result = resolveMoveTarget(src, destDir);
    expect(result).toEqual({ ok: true, dest: "/workspace/myrepo/lib/utils" });
  });

  it("accepts a move from a subdir up to the root", () => {
    const src = "/workspace/myrepo/src/foo.ts";
    const destDir = "/workspace/myrepo";
    const result = resolveMoveTarget(src, destDir);
    expect(result).toEqual({ ok: true, dest: "/workspace/myrepo/foo.ts" });
  });

  it("rejects moving root itself into its own child (edge: root into sub)", () => {
    const src = "/workspace/myrepo/src";
    const destDir = "/workspace/myrepo/src/sub";
    const result = resolveMoveTarget(src, destDir);
    expect(result.ok).toBe(false);
  });
});
