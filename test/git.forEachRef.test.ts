import { describe, it, expect } from "vitest";
import { parseForEachRef } from "../src/git";

// Pure unit tests for parseForEachRef — no git/gh shelling out.

describe("parseForEachRef", () => {
  // Helper: build a for-each-ref output line
  function line(refname: string, date: string, email: string): string {
    return `${refname}\t${date}\t${email}`;
  }

  it("parses a local-only branch", () => {
    const out = line("main", "2024-01-15T10:00:00+00:00", "<alice@example.com>");
    const map = parseForEachRef(out);
    expect(map.size).toBe(1);
    const entry = map.get("main");
    expect(entry).toBeDefined();
    expect(entry!.ref).toBe("main");
    expect(entry!.isLocal).toBe(true);
    expect(entry!.updatedAt).toBe("2024-01-15T10:00:00+00:00");
    expect(entry!.authorEmail).toBe("alice@example.com");
  });

  it("parses a remote-only branch (origin/feat → short name feat, ref origin/feat)", () => {
    const out = line("origin/feat", "2024-02-01T08:00:00+00:00", "<bob@example.com>");
    const map = parseForEachRef(out);
    expect(map.size).toBe(1);
    const entry = map.get("feat");
    expect(entry).toBeDefined();
    expect(entry!.ref).toBe("origin/feat");
    expect(entry!.isLocal).toBe(false);
    expect(entry!.authorEmail).toBe("bob@example.com");
  });

  it("collapses a branch present both locally and as origin/<name> to one entry preferring local", () => {
    const out = [
      line("main", "2024-01-15T10:00:00+00:00", "<alice@example.com>"),
      line("origin/main", "2024-01-14T09:00:00+00:00", "<other@example.com>"),
    ].join("\n");
    const map = parseForEachRef(out);
    expect(map.size).toBe(1);
    const entry = map.get("main");
    expect(entry).toBeDefined();
    // local wins
    expect(entry!.isLocal).toBe(true);
    expect(entry!.ref).toBe("main");
    // local ref's metadata wins
    expect(entry!.updatedAt).toBe("2024-01-15T10:00:00+00:00");
    expect(entry!.authorEmail).toBe("alice@example.com");
  });

  it("drops origin/HEAD", () => {
    const out = [
      line("origin/HEAD", "2024-01-15T10:00:00+00:00", "<alice@example.com>"),
      line("main", "2024-01-15T10:00:00+00:00", "<alice@example.com>"),
    ].join("\n");
    const map = parseForEachRef(out);
    expect(map.has("HEAD")).toBe(false);
    expect(map.has("origin/HEAD")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("drops bare HEAD", () => {
    const out = line("HEAD", "2024-01-15T10:00:00+00:00", "<alice@example.com>");
    const map = parseForEachRef(out);
    expect(map.size).toBe(0);
  });

  it("strips <> from authorEmail and lowercases it", () => {
    const out = line("feat", "2024-03-01T00:00:00+00:00", "<Alice.Dev@Example.COM>");
    const map = parseForEachRef(out);
    expect(map.get("feat")!.authorEmail).toBe("alice.dev@example.com");
  });

  it("handles empty authorEmail gracefully", () => {
    const out = line("feat", "2024-03-01T00:00:00+00:00", "");
    const map = parseForEachRef(out);
    const entry = map.get("feat");
    expect(entry).toBeDefined();
    // empty string after stripping/lowercasing is fine, or undefined — just must not crash
    expect(typeof entry!.authorEmail === "string" || entry!.authorEmail === undefined).toBe(true);
  });

  it("is CRLF-tolerant", () => {
    const out = [
      line("main", "2024-01-15T10:00:00+00:00", "<alice@example.com>"),
      line("feat", "2024-02-01T00:00:00+00:00", "<bob@example.com>"),
    ].join("\r\n");
    const map = parseForEachRef(out);
    expect(map.size).toBe(2);
    expect(map.has("main")).toBe(true);
    expect(map.has("feat")).toBe(true);
  });

  it("returns an empty map for empty input", () => {
    expect(parseForEachRef("").size).toBe(0);
    expect(parseForEachRef("   \n  ").size).toBe(0);
  });

  it("handles a branch that is remote-only with slashes (e.g. devtower/feat)", () => {
    const out = line("origin/devtower/feat", "2024-04-01T00:00:00+00:00", "<carol@example.com>");
    const map = parseForEachRef(out);
    // short name = devtower/feat (strip leading origin/)
    expect(map.has("devtower/feat")).toBe(true);
    const entry = map.get("devtower/feat")!;
    expect(entry.ref).toBe("origin/devtower/feat");
    expect(entry.isLocal).toBe(false);
  });

  it("local branch takes priority over remote even when remote appears first", () => {
    const out = [
      line("origin/feat", "2024-01-10T00:00:00+00:00", "<remote@example.com>"),
      line("feat", "2024-02-01T00:00:00+00:00", "<local@example.com>"),
    ].join("\n");
    const map = parseForEachRef(out);
    expect(map.size).toBe(1);
    const entry = map.get("feat")!;
    expect(entry.isLocal).toBe(true);
    expect(entry.ref).toBe("feat");
    expect(entry.authorEmail).toBe("local@example.com");
  });
});
