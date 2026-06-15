// Before/after capture for removing the "Branches & PRs" billboard (the central
// left signboard) and its HUD ⇄ button. The overview intentionally frames the
// left billboard region, so one full-page overview shot shows BOTH the billboard
// and the HUD PR button — present on the base build, gone on this branch.
//
// Uses only surviving public APIs (postMessage + clearFocus) so the SAME spec
// runs against both trees. Flow (see CLAUDE.md):
//   git stash && npm run build && npm run screenshots -- -g removebillboard
//     → rename out/removebillboard.png → before.png
//   git stash pop && npm run build && npm run screenshots -- -g removebillboard
//     → out/removebillboard.png is the "after"
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
    { id: "a1", name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8", worktree: "/repo", branch: "feat-streaming", skills: [], contextTokens: 50_000, elapsed: "3m" },
    { id: "a2", name: "Beacon", state: "waiting", repo: "lib", model: "opus-4.8", worktree: "/lib", branch: "perf-cache", skills: [], contextTokens: 30_000, elapsed: "8m" },
  ],
  rooms: [
    { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "feat-streaming" }] },
    { name: "lib", path: "/lib", floor: 0, col: 1, worktrees: [{ path: "/lib", branch: "perf-cache" }] },
  ],
  boards: {
    "/repo": { branch: "feat-streaming", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [], unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0, committedDel: 0, base: "main", ahead: 2, unpushed: 0, behind: 0, commits: [], prReady: true },
    "/lib": { branch: "perf-cache", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [], unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0, committedDel: 0, base: "main", ahead: 2, unpushed: 0, behind: 0, commits: [], prReady: true },
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

// crew PRs drive the per-room PR cell (kept); repos drive the billboard (removed).
const CREW = [
  { ...pr({ number: 318, title: "SSE streaming", branch: "feat-streaming", agentId: "a1" }), id: "acme/app#318" },
  { ...pr({ number: 91, title: "Cache layer", isDraft: true, checks: "pending", checksPass: 1, checksRunning: 2, checksTotal: 3, review: "required", branch: "perf-cache", agentId: "a2" }), id: "acme/lib#91" },
];
const REPOS = [
  {
    repo: "acme/app", shortName: "DevTower", defaultBranch: "main",
    main: { checks: "pass", pass: 4, fail: 0, running: 0, total: 4 },
    branches: [
      br({ branch: "main", isDefault: true, hasWorktree: true, mine: true, updatedAt: ago(0.01 * D) }),
      br({ branch: "feat-streaming", hasWorktree: true, mine: true, ahead: 2, behind: 0, updatedAt: ago(0.1 * D), pr: pr({ number: 318, title: "SSE streaming", review: "approved", approvals: 2 }) }),
      br({ branch: "fix-race", mine: false, ahead: 1, behind: 1, updatedAt: ago(3 * D), pr: pr({ number: 322, title: "Fix race in poller", checks: "fail", checksPass: 2, checksFailed: 1, review: "changes", author: "bob", isMine: false }) }),
      br({ branch: "feat-search", mine: false, ahead: 4, behind: 2, updatedAt: ago(2 * D), pr: pr({ number: 330, title: "Search index", author: "carol", isMine: false }) }),
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
  await page.waitForTimeout(400);
};

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
});

test("capture: removebillboard", async ({ page }) => {
  page.on("pageerror", (e) => console.error("[removebillboard] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));
  await page.evaluate((d) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", ...d.state }, "*");
    window.postMessage({ type: "prs", crew: d.crew, review: [], repos: d.repos, viewer: d.viewer, connected: true, loading: false }, "*");
  }, { state: STATE, crew: CREW, repos: REPOS, viewer: VIEWER });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(300);
  // overview frames the campus (and, on the base build, the left billboard)
  await page.evaluate(() => (window as any).DevTowerCrew?.clearFocus?.());
  await settle(page);
  await page.screenshot({ path: path.join(OUT, "removebillboard.png") });
  console.log("done");
});
