import { describe, it, expect } from "vitest";
import { rollupChecks, checkCounts, reviewCounts, mapDecision, PR_CHASE_DELAYS_MS } from "../src/prs";

// gh CLI JSON → display state. Pure mapping/aggregation; OS-independent but core
// to what the PR board shows, so worth pinning down.

describe("rollupChecks", () => {
  it("is 'none' with no checks", () => {
    expect(rollupChecks([])).toBe("none");
    expect(rollupChecks(undefined as any)).toBe("none");
  });
  it("is 'pass' when all conclude OK", () => {
    expect(rollupChecks([{ conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }, { conclusion: "SKIPPED" }])).toBe("pass");
  });
  it("is 'fail' if any check failed", () => {
    expect(rollupChecks([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("fail");
  });
  it("is 'pending' when something has not concluded", () => {
    expect(rollupChecks([{ conclusion: "SUCCESS" }, { state: "PENDING" }])).toBe("pending");
  });
  it("reads the .state fallback for older shapes", () => {
    expect(rollupChecks([{ state: "ERROR" }])).toBe("fail");
  });
});

describe("checkCounts", () => {
  it("tallies pass / fail / running / total", () => {
    expect(
      checkCounts([
        { conclusion: "SUCCESS" },
        { conclusion: "SKIPPED" },
        { conclusion: "FAILURE" },
        { state: "IN_PROGRESS" },
      ])
    ).toEqual({ pass: 2, fail: 1, running: 1, total: 4 });
  });
  it("is all-zero for a non-array", () => {
    expect(checkCounts(undefined as any)).toEqual({ pass: 0, fail: 0, running: 0, total: 0 });
  });
});

describe("reviewCounts", () => {
  it("keeps only each reviewer's latest decision", () => {
    const reviews = [
      { author: { login: "a" }, state: "CHANGES_REQUESTED" },
      { author: { login: "a" }, state: "APPROVED" }, // a flipped to approve
      { author: { login: "b" }, state: "APPROVED" },
      { author: { login: "c" }, state: "COMMENTED" }, // not a decision
    ];
    const rc = reviewCounts(reviews, [{ login: "d" }]);
    expect(rc.approvals).toBe(2);
    expect(rc.changesRequested).toBe(0);
    expect(rc.commented).toBe(1);
    expect(rc.pending).toBe(1);
  });
  it("handles empty / missing inputs", () => {
    expect(reviewCounts([], [])).toEqual({ approvals: 0, changesRequested: 0, pending: 0, commented: 0 });
    expect(reviewCounts(undefined as any, undefined as any)).toEqual({
      approvals: 0,
      changesRequested: 0,
      pending: 0,
      commented: 0,
    });
  });
});

describe("PR_CHASE_DELAYS_MS", () => {
  // The chase exists to beat GitHub's pr-list index lag after `gh pr create`. It
  // must try IMMEDIATELY (the index is sometimes already warm) and stay short and
  // bounded so it can't burst the API before the normal poller resumes ownership.
  it("starts with an immediate attempt", () => {
    expect(PR_CHASE_DELAYS_MS[0]).toBe(0);
  });
  it("is short and bounded so it can't burst the API", () => {
    expect(PR_CHASE_DELAYS_MS.length).toBeGreaterThanOrEqual(2);
    expect(PR_CHASE_DELAYS_MS.length).toBeLessThanOrEqual(6);
    const total = PR_CHASE_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(15_000); // whole chase well under the 60s idle tick
  });
});

describe("mapDecision", () => {
  it("maps gh review decisions, case-insensitively", () => {
    expect(mapDecision("APPROVED")).toBe("approved");
    expect(mapDecision("changes_requested")).toBe("changes");
    expect(mapDecision("REVIEW_REQUIRED")).toBe("required");
    expect(mapDecision(undefined)).toBe("none");
    expect(mapDecision("weird")).toBe("none");
  });
});
