// Throwaway capture for the Branches & PRs billboard (the central left signboard).
// Boots the real webview front-end, feeds a mock `prs` message carrying the new
// grouped `repos` dataset + `viewer`, flies the camera to the board, and shoots
// it. Exercises the Branches/PRs tabs, the Branches sub-tabs, and the PR filter
// dropdowns on a fixed-size scrollable panel.
// Run: npm run screenshots -- -g branchboard
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const D = 24 * 3600 * 1000;

const STATE = {
  agents: [
    { id: "a1", name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8", worktree: "/repo", branch: "main", skills: [], contextTokens: 50_000, elapsed: "3m" },
  ],
  rooms: [{ name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "main" }] }],
  boards: {
    "/repo": { branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [], unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0, committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true },
  },
};

const VIEWER = "alice";
const pr = (over: any) => ({
  number: 1, url: "https://github.com/acme/app/pull/1", title: "PR", isDraft: false,
  checks: "pass", checksPass: 3, checksFailed: 0, checksRunning: 0, checksTotal: 3,
  review: "approved", approvals: 1, changesRequested: 0, reviewersPending: 0, comments: 0,
  author: "alice", isMine: true, reviewRequestedFromMe: false, assignees: [], updatedAt: ago(D), createdAt: ago(7 * D),
  labels: [], milestone: undefined, projects: [], ...over,
});
const br = (over: any) => ({ repo: "acme/app", isDefault: false, hasWorktree: false, mine: false, ahead: 0, behind: 0, updatedAt: ago(2 * D), ...over });

const REPOS = [
  {
    repo: "acme/app", shortName: "DevTower", defaultBranch: "main",
    main: { checks: "pass", pass: 4, fail: 0, running: 0, total: 4 },
    branches: [
      br({ branch: "main", isDefault: true, hasWorktree: true, mine: true, updatedAt: ago(0.01 * D) }),
      br({ branch: "feat-streaming", mine: true, ahead: 2, behind: 0, updatedAt: ago(0.1 * D), pr: pr({ number: 318, title: "SSE streaming for /v1/messages", review: "approved", approvals: 2, author: "alice", isMine: true, assignees: ["alice"], updatedAt: ago(0.1 * D), labels: ["enhancement"], milestone: "v1.0" }) }),
      br({ branch: "fix-race", hasWorktree: true, mine: false, ahead: 1, behind: 1, updatedAt: ago(3 * D), pr: pr({ number: 322, title: "Fix race in poller", checks: "fail", checksPass: 2, checksFailed: 1, review: "changes", approvals: 0, changesRequested: 1, reviewersPending: 1, author: "bob", isMine: false, reviewRequestedFromMe: true, assignees: ["bob"], updatedAt: ago(3 * D), labels: ["bug"], milestone: "v1.0" }) }),
      br({ branch: "feat-search", mine: false, ahead: 4, behind: 2, updatedAt: ago(2 * D), pr: pr({ number: 330, title: "Search index", review: "approved", approvals: 1, author: "carol", isMine: false, reviewRequestedFromMe: true, assignees: ["alice"], updatedAt: ago(2 * D), labels: ["enhancement", "documentation"] }) }),
      br({ branch: "chore-deps", mine: false, ahead: 1, behind: 0, updatedAt: ago(5 * D), pr: pr({ number: 331, title: "Bump deps", review: "required", approvals: 0, reviewersPending: 2, author: "carol", isMine: false, updatedAt: ago(5 * D), labels: ["dependencies"] }) }),
      br({ branch: "docs-readme", mine: true, ahead: 1, behind: 3, updatedAt: ago(100 * D) }),
      br({ branch: "spike-old-idea", mine: true, ahead: 2, behind: 9, updatedAt: ago(200 * D) }),
      br({ branch: "perf-cache", mine: true, ahead: 3, behind: 0, updatedAt: ago(1 * D), pr: pr({ number: 340, title: "Cache layer", isDraft: true, checks: "pending", checksPass: 1, checksRunning: 2, checksTotal: 3, review: "required", approvals: 0, reviewersPending: 2, author: "alice", isMine: true, assignees: ["alice"], updatedAt: ago(1 * D), labels: ["enhancement", "performance"], milestone: "v1.1" }) }),
      br({ branch: "refactor-store", mine: true, ahead: 6, behind: 1, updatedAt: ago(10 * D), pr: pr({ number: 341, title: "Store refactor", review: "changes", approvals: 0, changesRequested: 2, author: "alice", isMine: true, updatedAt: ago(10 * D), labels: ["refactor"] }) }),
    ],
  },
  {
    repo: "acme/lib", shortName: "lib", defaultBranch: "main",
    main: { checks: "pending", pass: 2, fail: 0, running: 1, total: 3 },
    branches: [
      { branch: "main", repo: "acme/lib", isDefault: true, hasWorktree: true, mine: true, ahead: 0, behind: 0, updatedAt: ago(0.2 * D) },
      { branch: "perf-cache", repo: "acme/lib", isDefault: false, hasWorktree: false, mine: true, ahead: 2, behind: 0, updatedAt: ago(1 * D), pr: pr({ number: 91, title: "Cache layer", isDraft: true, checks: "pending", checksPass: 1, checksRunning: 2, checksTotal: 3, review: "required", author: "alice", isMine: true, assignees: ["alice"], updatedAt: ago(1 * D) }) },
    ],
  },
];

const settle = async (page: any) => {
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    const z = c.cam.z, prev = (window as any).__z; (window as any).__z = z;
    return prev !== undefined && Math.abs(z - prev) < 0.002;
  }, { timeout: 8000, polling: 200 }).catch(() => {});
  await page.waitForTimeout(350);
};
const clickAt = (page: any, wx: number, wy: number) => page.evaluate((p: any) => {
  const c = (window as any).DevTowerCrew?._instance;
  const s = c.screenOf(p.wx, p.wy);
  const canvas = c.canvas as HTMLCanvasElement;
  const r = canvas.getBoundingClientRect();
  const o = { bubbles: true, clientX: r.left + s.x, clientY: r.top + s.y, button: 0, pointerId: 1 };
  canvas.dispatchEvent(new PointerEvent("pointerdown", o as any));
  canvas.dispatchEvent(new PointerEvent("pointerup", o as any));
}, { wx, wy });
const clickRect = async (page: any, kind: string, key: string) => {
  const rect = await page.evaluate((p: any) => {
    const c = (window as any).DevTowerCrew?._instance;
    const bb = c.billboardGeom();
    const list = p.kind === "tab" ? bb.tabs : p.kind === "sub" ? bb.subTabs : p.kind === "dd" ? bb.dropdowns : bb.openMenu?.options || [];
    const item = list.find((i: any) => (p.kind === "opt" ? i.value : i.key) === p.key);
    return item ? { x: item.rect.x + item.rect.w / 2, y: item.rect.y + item.rect.h / 2 } : null;
  }, { kind, key });
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

  const type = async (page: any, s: string) => { for (const ch of s) { await page.evaluate((k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })), ch); await page.waitForTimeout(20); } };

  // 1. Branches tab, Overview sub-tab (default) — sub-tabs + search box
  const info = await page.evaluate(() => {
    const c = (window as any).DevTowerCrew?._instance;
    const bb = c.billboardGeom();
    return { bodyH: bb.bodyH, tab: c.boardTab, sub: c.branchSubTab, total: bb.visibleTotal, hasSearch: !!bb.searchBox };
  });
  console.log("BRANCHES/Overview:", JSON.stringify(info));
  await page.screenshot({ path: path.join(OUT, "branchboard.png") });

  // 2. Branches → All + search "feat"
  await clickRect(page, "sub", "all");
  await page.evaluate(() => { const bb = (window as any).DevTowerCrew._instance.billboardGeom(); const s = bb.searchBox; const c = (window as any).DevTowerCrew._instance; const sc = c.screenOf(s.x + s.w / 2, s.y + s.h / 2); const cv = c.canvas; const r = cv.getBoundingClientRect(); const o = { bubbles: true, clientX: r.left + sc.x, clientY: r.top + sc.y, button: 0, pointerId: 1 }; cv.dispatchEvent(new PointerEvent("pointerdown", o)); cv.dispatchEvent(new PointerEvent("pointerup", o)); });
  await type(page, "feat");
  await settle(page);
  console.log("ALL search=feat total:", await page.evaluate(() => (window as any).DevTowerCrew._instance.billboardGeom().visibleTotal));
  await page.screenshot({ path: path.join(OUT, "branchboard-search.png") });

  // clear search, back to overview
  await page.evaluate(() => { const c = (window as any).DevTowerCrew._instance; c.branchSearch = ""; c.bbInput = null; c.setBranchSubTab("overview"); });
  await settle(page);

  // 3. PRs tab
  await clickRect(page, "tab", "prs");
  await settle(page);
  await page.screenshot({ path: path.join(OUT, "branchboard-prs.png") });

  // 4. open the Label dropdown (multi-select menu + search field)
  await clickRect(page, "dd", "label");
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "branchboard-prs-menu.png") });

  // 5. multi-select: enhancement AND documentation
  await clickRect(page, "opt", "enhancement");
  await page.waitForTimeout(120);
  await clickRect(page, "opt", "documentation");
  await page.waitForTimeout(120);
  await clickRect(page, "tab", "prs"); // click the tab bar to dismiss the menu (no-op tab)
  await settle(page);
  const prInfo = await page.evaluate(() => {
    const c = (window as any).DevTowerCrew?._instance;
    return { bodyH: c.billboardGeom().bodyH, total: c.billboardGeom().visibleTotal, labels: [...c.prLabels] };
  });
  console.log("PRs label=enhancement+documentation:", JSON.stringify(prInfo));
  await page.screenshot({ path: path.join(OUT, "branchboard-prs-filtered.png") });
  console.log("done");
});
