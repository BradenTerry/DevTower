// Throwaway capture for the Branches & PRs billboard (the central left signboard).
// Boots the real webview front-end, feeds a mock `prs` message carrying the new
// grouped `repos` dataset + `viewer`, flies the camera to the board, and shoots
// it. Run: npm run screenshots -- -g branchboard
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

// One island so the campus exists (the board anchors to the campus left edge).
const STATE = {
  agents: [
    { id: "a1", name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8", worktree: "/repo", branch: "main", skills: [], contextTokens: 50_000, elapsed: "3m" },
  ],
  rooms: [
    { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "main" }] },
  ],
  boards: {
    "/repo": {
      branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
      unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0, committedDel: 0,
      base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true,
    },
  },
};

const VIEWER = "alice";
const REPOS = [
  {
    repo: "acme/app", shortName: "app", defaultBranch: "main",
    main: { checks: "pass", pass: 4, fail: 0, running: 0, total: 4 },
    branches: [
      { branch: "main", repo: "acme/app", isDefault: true, hasWorktree: true },
      {
        branch: "feat-streaming", repo: "acme/app", isDefault: false, hasWorktree: false,
        pr: { number: 318, url: "https://github.com/acme/app/pull/318", title: "SSE streaming", isDraft: false,
          checks: "pass", checksPass: 5, checksFailed: 0, checksRunning: 0, checksTotal: 5,
          review: "approved", approvals: 2, changesRequested: 0, reviewersPending: 0, comments: 1,
          author: "alice", isMine: true, reviewRequestedFromMe: false, updatedAt: "2026-06-13T10:00:00Z" },
      },
      {
        branch: "fix-race", repo: "acme/app", isDefault: false, hasWorktree: true,
        pr: { number: 322, url: "https://github.com/acme/app/pull/322", title: "Fix race in poller", isDraft: false,
          checks: "fail", checksPass: 2, checksFailed: 1, checksRunning: 0, checksTotal: 3,
          review: "changes", approvals: 0, changesRequested: 1, reviewersPending: 1, comments: 4,
          author: "bob", isMine: false, reviewRequestedFromMe: true, updatedAt: "2026-06-12T09:00:00Z" },
      },
      { branch: "spike-idea", repo: "acme/app", isDefault: false, hasWorktree: false },
    ],
  },
  {
    repo: "acme/lib", shortName: "lib", defaultBranch: "main",
    main: { checks: "pending", pass: 2, fail: 0, running: 1, total: 3 },
    branches: [
      { branch: "main", repo: "acme/lib", isDefault: true, hasWorktree: true },
      {
        branch: "perf-cache", repo: "acme/lib", isDefault: false, hasWorktree: false,
        pr: { number: 91, url: "https://github.com/acme/lib/pull/91", title: "Cache layer", isDraft: true,
          checks: "pending", checksPass: 1, checksFailed: 0, checksRunning: 2, checksTotal: 3,
          review: "required", approvals: 0, changesRequested: 0, reviewersPending: 2, comments: 0,
          author: "alice", isMine: true, reviewRequestedFromMe: false, updatedAt: "2026-06-14T08:00:00Z" },
      },
    ],
  },
];

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
});

test("capture: branchboard", async ({ page }) => {
  page.on("pageerror", (e) => console.error("[branchboard] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((d) => {
    window.postMessage({ type: "state", ...d.state }, "*");
    window.postMessage({ type: "prs", crew: [], review: [], repos: d.repos, viewer: d.viewer, connected: true, loading: false }, "*");
  }, { state: STATE, repos: REPOS, viewer: VIEWER });

  await page.evaluate(() => (document as any).fonts?.ready);
  // fly the camera to the billboard and let the zoom settle
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).DevTowerCrew.focusReviewBoard());
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    const z = c.cam.z;
    const prev = (window as any).__z;
    (window as any).__z = z;
    return prev !== undefined && Math.abs(z - prev) < 0.002;
  }, { timeout: 8000, polling: 200 }).catch(() => {});
  await page.waitForTimeout(500);

  await page.screenshot({ path: path.join(OUT, "branchboard.png") });
  console.log("wrote branchboard.png");

  // drive a REAL canvas click on the REVIEW chip to exercise the hit-test, then
  // confirm only the review-requested branch survives the filter
  const clicked = await page.evaluate(() => {
    const c = (window as any).DevTowerCrew?._instance;
    const bb = c.billboardGeom();
    const chip = bb.chips.find((x: any) => x.key === "review");
    if (!chip) return false;
    const cx = chip.rect.x + chip.rect.w / 2, cy = chip.rect.y + chip.rect.h / 2;
    const s = c.screenOf ? c.screenOf(cx, cy) : null;
    // screenOf maps world→screen; dispatch a pointer click there on the canvas
    const pt = s || { x: cx, y: cy };
    const canvas = c.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const opts = { bubbles: true, clientX: rect.left + pt.x, clientY: rect.top + pt.y, button: 0, pointerId: 1 };
    canvas.dispatchEvent(new PointerEvent("pointerdown", opts as any));
    canvas.dispatchEvent(new PointerEvent("pointerup", opts as any));
    return true;
  });
  console.log("review chip clicked:", clicked);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "branchboard-review.png") });
  console.log("wrote branchboard-review.png");
});
