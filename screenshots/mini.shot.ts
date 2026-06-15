// Captures the compact mini view (popout): the Projects, Worktrees, and Agents
// drill levels plus the nested PR detail. Boots media/mini.js + mini.css outside
// VS Code with a stubbed acquireVsCodeApi, the same way harness.ts boots the
// tower. Run:  npm run screenshots -- -g mini
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".mini-harness.html");
const fileUrl = (p: string) => pathToFileURL(path.join(MEDIA, p)).href;

/** Lift the <body> markup from MiniPanel.html() so the harness renders the exact
 *  same DOM the extension does (minus the nonce'd script include). */
function bodyMarkup(): string {
  const src = fs.readFileSync(path.join(ROOT, "src", "miniPanel.ts"), "utf8");
  const m = src.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  if (!m) throw new Error("could not find <body> in miniPanel.ts html()");
  return m[1].replace(/<script[\s\S]*?<\/script>/g, "").replace(/\$\{[^}]*\}/g, "");
}

function harnessHtml(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;600;700&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
<link href="${fileUrl("mini.css")}" rel="stylesheet" />
<title>mini harness</title></head>
<body data-theme="dark">
${bodyMarkup()}
<script>
  window.__outbox = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__outbox.push(m), getState: () => undefined, setState: () => {} });
</script>
<script src="${fileUrl("mini.js")}"></script>
</body></html>`;
}

const emptyBoard = (over: Record<string, unknown>) => ({
  branch: "", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0, committedDel: 0,
  base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true, ...over,
});

const rooms = [
  { name: "DevTower", path: "/code/devtower", floor: 0, col: 0, worktrees: [
    { path: "/code/devtower", branch: "main" },
    { path: "/code/devtower-feat", branch: "mini-view" },
  ] },
  { name: "api-server", path: "/code/api", floor: 0, col: 1, worktrees: [
    { path: "/code/api", branch: "main" },
  ] },
  { name: "marketing-site", path: "/code/mkt", floor: 0, col: 2, worktrees: [
    { path: "/code/mkt", branch: "main" },
    { path: "/code/mkt-redesign", branch: "redesign" },
  ] },
];

const boards: Record<string, unknown> = {
  "/code/devtower": emptyBoard({ branch: "main", modified: 2, ahead: 1, unstagedAdd: 18, unstagedDel: 4 }),
  "/code/devtower-feat": emptyBoard({ branch: "mini-view", modified: 6, staged: 3, unstagedAdd: 240, unstagedDel: 32, stagedAdd: 88, stagedDel: 5, ahead: 4,
    pr: { number: 128, title: "Add compact mini view popout", url: "https://github.com/x/y/pull/128", draft: false,
      checks: "pass", checksPass: 12, checksFailed: 0, checksRunning: 0, checksTotal: 12,
      review: "approved", approvals: 2, changesRequested: 0, reviewersPending: 0, comments: 4 } }),
  "/code/api": emptyBoard({ branch: "main", modified: 1, behind: 3,
    pr: { number: 54, title: "Rework auth token refresh", url: "https://github.com/x/y/pull/54", draft: false,
      checks: "fail", checksPass: 8, checksFailed: 2, checksRunning: 1, checksTotal: 11,
      review: "changes", approvals: 0, changesRequested: 1, reviewersPending: 2, comments: 9 } }),
  "/code/mkt": emptyBoard({ branch: "main" }),
  "/code/mkt-redesign": emptyBoard({ branch: "redesign", modified: 11, unstagedAdd: 510, unstagedDel: 120, ahead: 7,
    pr: { number: 77, title: "Landing page redesign", url: "https://github.com/x/y/pull/77", draft: true,
      checks: "pending", checksPass: 3, checksFailed: 0, checksRunning: 4, checksTotal: 7,
      review: "required", approvals: 0, changesRequested: 0, reviewersPending: 1, comments: 1 } }),
};

const agents = [
  { id: "DevTower-1a2b", name: "DevTower-1a2b", state: "active", repo: "DevTower", model: "claude-opus-4-8", worktree: "/code/devtower", branch: "main", contextTokens: 240000, task: "Wiring the popout button into the HUD", aiTitle: "Mini view popout", tasks: { done: 3, total: 7 } },
  { id: "DevTower-9f0e", name: "DevTower-9f0e", state: "idle", repo: "DevTower", model: "claude-sonnet-4-6", worktree: "/code/devtower", branch: "main", contextTokens: 41000, task: "Ready — dispatch a task" },
  { id: "DevTower-c3d4", name: "DevTower-c3d4", state: "waiting", repo: "DevTower", model: "claude-opus-4-8", worktree: "/code/devtower-feat", branch: "mini-view", contextTokens: 612000, task: "Awaiting your approval to delete the worktree", aiTitle: "Build mini.js renderers", tasks: { done: 5, total: 6 } },
  { id: "api-7777", name: "api-7777", state: "error", repo: "api-server", model: "claude-opus-4-8", worktree: "/code/api", branch: "main", contextTokens: 88000, task: "Token refresh test failed — needs a retry" },
  { id: "mkt-2222", name: "mkt-2222", state: "active", repo: "marketing-site", model: "claude-sonnet-4-6", worktree: "/code/mkt-redesign", branch: "redesign", contextTokens: 150000, task: "Rebuilding the hero section grid", tasks: { done: 1, total: 4 } },
  { id: "mkt-3333", name: "mkt-3333", state: "complete", repo: "marketing-site", model: "claude-opus-4-8", worktree: "/code/mkt-redesign", branch: "redesign", contextTokens: 70000, task: "Done — footer links updated" },
  { id: "ext-9001", name: "external-cli", state: "active", repo: "DevTower", model: "claude-opus-4-8", worktree: "/code/devtower-feat", branch: "mini-view", contextTokens: 120000, task: "Running in its own terminal outside DevTower", external: true },
];

const state = { type: "state", agents, rooms, boards, usedDir: "/code/devtower-feat", selectedId: "DevTower-1a2b" };

async function boot(page: any) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox) && (window as any).__outbox.some((m: any) => m.type === "ready"));
  await page.evaluate((s: unknown) => { window.postMessage({ type: "prs", connected: true, loading: false, crew: [], review: [] }, "*"); window.postMessage(s, "*"); }, state);
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(700);
}

test("capture: mini", async ({ page }) => {
  await boot(page);

  // Marketplace/readme "mini view" landing shot: the Projects tab (the view the
  // popout opens on) framed at a popout-panel size.
  await page.setViewportSize({ width: 1120, height: 660 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, "mini-landing.png") });
  console.log("wrote mini-landing.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);

  // Level 1 — Projects
  await page.screenshot({ path: path.join(OUT, "mini-projects.png") });
  console.log("wrote mini-projects.png");

  // Level 2 — Worktrees (drill into DevTower)
  await page.locator('tr.row[data-project="DevTower"]').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, "mini-worktrees.png") });
  console.log("wrote mini-worktrees.png");

  // Level 3 — Agents (drill into the mini-view worktree)
  await page.locator('tr.row[data-wt="/code/devtower-feat"]').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, "mini-agents.png") });
  console.log("wrote mini-agents.png");

  // PR detail — back to worktrees, open the PR badge
  await page.locator('.crumb', { hasText: "DevTower" }).first().click();
  await page.waitForTimeout(200);
  await page.locator('.prbadge[data-pr="/code/devtower-feat"]').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, "mini-pr.png") });
  console.log("wrote mini-pr.png");

  // Narrow window: the per-status counts should wrap to multiple lines rather
  // than forcing the Agents column wide.
  await page.locator('.crumb', { hasText: "DevTower" }).first().click();
  await page.waitForTimeout(200);
  await page.setViewportSize({ width: 560, height: 760 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, "mini-narrow.png") });
  console.log("wrote mini-narrow.png");

  // All-agents tab: every agent in one view, grouped by project / worktree.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.tab[data-tab="agents"]').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, "mini-all-agents.png") });
  console.log("wrote mini-all-agents.png");
});
