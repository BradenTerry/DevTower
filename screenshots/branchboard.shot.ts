// Throwaway capture for the Branches & PRs billboard (the central left signboard).
// Boots the real webview front-end, feeds a mock `prs` message carrying the new
// grouped `repos` dataset + `viewer`, flies the camera to the board, and shoots
// it. Exercises the FIXED-size scrollable panel + multi-select filters.
// Run: npm run screenshots -- -g branchboard
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
const pr = (over: any) => ({
  number: 1, url: "https://github.com/acme/app/pull/1", title: "PR", isDraft: false,
  checks: "pass", checksPass: 3, checksFailed: 0, checksRunning: 0, checksTotal: 3,
  review: "approved", approvals: 1, changesRequested: 0, reviewersPending: 0, comments: 0,
  author: "alice", isMine: true, reviewRequestedFromMe: false, ...over,
});
// many branches so the content overflows the fixed viewport and scrolls
const APP_BRANCHES = [
  { branch: "main", repo: "acme/app", isDefault: true, hasWorktree: true },
  { branch: "feat-streaming", repo: "acme/app", isDefault: false, hasWorktree: false, pr: pr({ number: 318, title: "SSE streaming", review: "approved", approvals: 2, author: "alice", isMine: true }) },
  { branch: "fix-race", repo: "acme/app", isDefault: false, hasWorktree: true, pr: pr({ number: 322, title: "Fix race", checks: "fail", checksPass: 2, checksFailed: 1, review: "changes", approvals: 0, changesRequested: 1, reviewersPending: 1, author: "bob", isMine: false, reviewRequestedFromMe: true }) },
  { branch: "feat-search", repo: "acme/app", isDefault: false, hasWorktree: false, pr: pr({ number: 330, title: "Search", review: "approved", approvals: 1, author: "carol", isMine: false, reviewRequestedFromMe: true }) },
  { branch: "chore-deps", repo: "acme/app", isDefault: false, hasWorktree: false, pr: pr({ number: 331, title: "Bump deps", review: "required", approvals: 0, reviewersPending: 2, author: "carol", isMine: false }) },
  { branch: "docs-readme", repo: "acme/app", isDefault: false, hasWorktree: false },
  { branch: "spike-idea", repo: "acme/app", isDefault: false, hasWorktree: false },
  { branch: "perf-cache", repo: "acme/app", isDefault: false, hasWorktree: false, pr: pr({ number: 340, title: "Cache", checks: "pending", checksPass: 1, checksRunning: 2, checksTotal: 3, review: "approved", approvals: 3, author: "alice", isMine: true }) },
  { branch: "refactor-store", repo: "acme/app", isDefault: false, hasWorktree: false, pr: pr({ number: 341, title: "Store refactor", review: "changes", approvals: 0, changesRequested: 2, author: "alice", isMine: true }) },
];
const REPOS = [
  {
    repo: "acme/app", shortName: "DevTower", defaultBranch: "main",
    main: { checks: "pass", pass: 4, fail: 0, running: 0, total: 4 },
    branches: APP_BRANCHES,
  },
  {
    repo: "acme/lib", shortName: "lib", defaultBranch: "main",
    main: { checks: "pending", pass: 2, fail: 0, running: 1, total: 3 },
    branches: [
      { branch: "main", repo: "acme/lib", isDefault: true, hasWorktree: true },
      { branch: "perf-cache", repo: "acme/lib", isDefault: false, hasWorktree: false, pr: pr({ number: 91, title: "Cache layer", isDraft: true, checks: "pending", checksPass: 1, checksRunning: 2, checksTotal: 3, review: "required", approvals: 0, reviewersPending: 2, author: "alice", isMine: true }) },
    ],
  },
];

const settle = async (page: any) => {
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    const z = c.cam.z;
    const prev = (window as any).__z;
    (window as any).__z = z;
    return prev !== undefined && Math.abs(z - prev) < 0.002;
  }, { timeout: 8000, polling: 200 }).catch(() => {});
  await page.waitForTimeout(400);
};
// click the world point (wx,wy) on the canvas via a real pointer event
const clickAt = (page: any, wx: number, wy: number) => page.evaluate((p: any) => {
  const c = (window as any).DevTowerCrew?._instance;
  const s = c.screenOf(p.wx, p.wy);
  const canvas = c.canvas as HTMLCanvasElement;
  const r = canvas.getBoundingClientRect();
  const o = { bubbles: true, clientX: r.left + s.x, clientY: r.top + s.y, button: 0, pointerId: 1 };
  canvas.dispatchEvent(new PointerEvent("pointerdown", o as any));
  canvas.dispatchEvent(new PointerEvent("pointerup", o as any));
}, { wx, wy });
// open a dropdown by clicking its header
const openDropdown = async (page: any, key: string) => {
  const rect = await page.evaluate((k: string) => {
    const c = (window as any).DevTowerCrew?._instance;
    const dd = c.billboardGeom().dropdowns.find((d: any) => d.key === k);
    return dd ? { x: dd.rect.x + dd.rect.w / 2, y: dd.rect.y + dd.rect.h / 2 } : null;
  }, key);
  if (rect) await clickAt(page, rect.x, rect.y);
};
// select an option (by value) from the currently-open dropdown
const selectOption = async (page: any, value: string) => {
  const rect = await page.evaluate((v: string) => {
    const c = (window as any).DevTowerCrew?._instance;
    const m = c.billboardGeom().openMenu;
    const o = m && m.options.find((o: any) => o.value === v);
    return o ? { x: o.rect.x + o.rect.w / 2, y: o.rect.y + o.rect.h / 2 } : null;
  }, value);
  if (rect) await clickAt(page, rect.x, rect.y);
};

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
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).DevTowerCrew.focusReviewBoard());
  await settle(page);

  // 1. default: fixed-size panel, three filter dropdowns, scrollbar (overflow)
  const base = await page.evaluate(() => {
    const c = (window as any).DevTowerCrew?._instance;
    const bb = c.billboardGeom();
    return { bodyH: bb.bodyH, hasScrollbar: !!bb.scrollbar, total: bb.visibleTotal, dds: bb.dropdowns.map((d: any) => d.key) };
  });
  console.log("DEFAULT:", JSON.stringify(base));
  await page.screenshot({ path: path.join(OUT, "branchboard.png") });

  // 2. open the Review dropdown (menu overlay floats over the rows)
  await openDropdown(page, "review");
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "branchboard-author-open.png") });

  // 3. Review = Approved AND Reviewer = Requested from me — the two are
  //    orthogonal: approved PRs that ALSO request my review
  await selectOption(page, "approved");
  await settle(page);
  await openDropdown(page, "reviewer");
  await page.waitForTimeout(150);
  await selectOption(page, "@me");
  await settle(page);
  const combo = await page.evaluate(() => {
    const c = (window as any).DevTowerCrew?._instance;
    const bb = c.billboardGeom();
    return { bodyH: bb.bodyH, total: bb.visibleTotal, review: c.reviewFilter, reviewer: c.reviewerFilter };
  });
  console.log("REVIEW=Approved + REVIEWER=@me:", JSON.stringify(combo));
  await page.screenshot({ path: path.join(OUT, "branchboard-mineappr.png") });

  // 4. reset filters and scroll the viewport down (virtualized rows)
  await openDropdown(page, "review"); await selectOption(page, "any");
  await openDropdown(page, "reviewer"); await selectOption(page, "");
  await settle(page);
  await page.evaluate(() => (window as any).DevTowerCrew._instance.scrollBranchBoard(60));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "branchboard-scrolled.png") });
  console.log("done");
});
