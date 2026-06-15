import { describe, it, expect } from "vitest";
import { normalizeBranchNames, parseRepoSlug } from "../src/git";

// Pure helpers extracted for unit testing without shelling out to git.

describe("normalizeBranchNames", () => {
  it("merges local and remote names, returning unique sorted list", () => {
    const locals = ["main", "feat-x"];
    const remotes = ["origin/main", "origin/feat-x", "origin/feat-y"];
    expect(normalizeBranchNames(locals, remotes)).toEqual(["feat-x", "feat-y", "main"]);
  });

  it("strips origin/ prefix from remote-only branches", () => {
    const result = normalizeBranchNames([], ["origin/main", "origin/feat-a"]);
    expect(result).toEqual(["feat-a", "main"]);
  });

  it("drops origin/HEAD entries", () => {
    const result = normalizeBranchNames(["main"], ["origin/HEAD", "origin/main", "origin/feat"]);
    expect(result).toEqual(["feat", "main"]);
  });

  it("drops bare HEAD entries", () => {
    const result = normalizeBranchNames(["HEAD", "main"], ["origin/main"]);
    expect(result).toEqual(["main"]);
  });

  it("returns [] when both lists are empty", () => {
    expect(normalizeBranchNames([], [])).toEqual([]);
  });

  it("handles branches with slashes (e.g. devtower/feat) preserving them", () => {
    const result = normalizeBranchNames(["devtower/feat"], ["origin/devtower/feat", "origin/main"]);
    expect(result).toEqual(["devtower/feat", "main"]);
  });

  it("de-duplicates when a branch exists locally AND as origin/<branch>", () => {
    const result = normalizeBranchNames(["main", "feat"], ["origin/main", "origin/feat", "origin/other"]);
    expect(result).toEqual(["feat", "main", "other"]);
  });

  it("CRLF-safe: strips trailing \\r from raw git output lines", () => {
    const locals = ["main\r", "feat\r"];
    const remotes = ["origin/main\r", "origin/other\r"];
    expect(normalizeBranchNames(locals, remotes)).toEqual(["feat", "main", "other"]);
  });
});

describe("parseRepoSlug", () => {
  it("parses SSH form git@github.com:owner/repo.git", () => {
    expect(parseRepoSlug("git@github.com:owner/repo.git")).toBe("owner/repo");
  });

  it("parses HTTPS form https://github.com/owner/repo.git", () => {
    expect(parseRepoSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
  });

  it("works without .git suffix on SSH", () => {
    expect(parseRepoSlug("git@github.com:owner/repo")).toBe("owner/repo");
  });

  it("works without .git suffix on HTTPS", () => {
    expect(parseRepoSlug("https://github.com/owner/repo")).toBe("owner/repo");
  });

  it("strips trailing slash", () => {
    expect(parseRepoSlug("https://github.com/owner/repo/")).toBe("owner/repo");
  });

  it("returns undefined for non-github URLs", () => {
    expect(parseRepoSlug("https://gitlab.com/owner/repo.git")).toBeUndefined();
  });

  it("returns undefined for unparseable strings", () => {
    expect(parseRepoSlug("not-a-url")).toBeUndefined();
    expect(parseRepoSlug("")).toBeUndefined();
  });

  it("handles org with dashes and repo with dots", () => {
    expect(parseRepoSlug("git@github.com:my-org/my.repo.git")).toBe("my-org/my.repo");
  });

  it("parses http (non-https) HTTPS form", () => {
    expect(parseRepoSlug("http://github.com/owner/repo")).toBe("owner/repo");
  });
});
