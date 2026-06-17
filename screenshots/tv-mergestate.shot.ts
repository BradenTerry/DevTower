// Before/after for the PR merge-readiness badges: the room's back-wall board PR
// cell, first a green/approved PR with NO merge badges (the old confusing case:
// passing but not merging with no hint why), then the same PR showing the new
// "UPDATE BASE" (out of date with base) + "AUTO-MERGE" chips. Two PNGs under
// docs/screenshots/tv-mergestate/.
// Run: npm run screenshots -- -g tv-mergestate
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "..", "docs", "screenshots", "tv-mergestate");
const HTML = path.join(__dirname, ".harness.html");

const room = { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "feat/merge-badges" }] };
const baseBoard = {
  branch: "feat/merge-badges", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0,
  committedDel: 0, base: "main", ahead: 2, unpushed: 0, behind: 0, commits: ["add merge badges", "add test"], prReady: true,
};
// Green + approved PR. Before: no merge metadata, so it looks ready but isn't.
const greenPr = {
  number: 98, title: "Show merge readiness on the room TV", url: "https://example.com/pr/98", draft: false,
  checks: "pass", checksPass: 3, checksFailed: 0, checksRunning: 0, checksTotal: 3,
  review: "approved", approvals: 1, changesRequested: 0, reviewersPending: 0, comments: 2,
};
// After: same PR, now out of date with base and with auto-merge armed.
const readyPr = { ...greenPr, mergeState: "behind", mergeConflict: false, autoMerge: true };
const lead = { id: "cc-lead0001", name: "DevTower-1", state: "idle", repo: "DevTower", model: "opus-4.8", worktree: "/repo", branch: "feat/merge-badges", skills: [], contextTokens: 90_000, elapsed: "4m" };

async function settle(page: any) {
  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("DevTower"));
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    const ts = [...c.toons.values()] as any[];
    (window as any).__z = c.cam.z;
    return ts.length >= 1 && ts.every((t) => t.sitting && !t.entering);
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => {
    const z = (window as any).DevTowerCrew._instance.cam.z, prev = (window as any).__z;
    (window as any).__z = z;
    return Math.abs(z - prev) < 0.002;
  }, { timeout: 8000, polling: 200 }).catch(() => {});
  await page.waitForTimeout(700);
}

test("capture: tv-mergestate", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[tv-mergestate] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  const post = (board: any) => page.evaluate((d) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: [d.lead], rooms: [d.room], boards: { "/repo": d.board } }, "*");
    window.postMessage({ type: "prs", crew: [], review: [], connected: true }, "*");
  }, { lead, room, board });
  await page.evaluate(() => (document as any).fonts?.ready);

  await post({ ...baseBoard, pr: greenPr });
  await settle(page);
  await page.screenshot({ path: path.join(OUT, "before.png") });
  console.log("wrote before.png (green PR, no merge hint)");

  await post({ ...baseBoard, pr: readyPr });
  await page.waitForTimeout(900); // let the column flash settle
  await page.screenshot({ path: path.join(OUT, "after.png") });
  console.log("wrote after.png (UPDATE BASE + AUTO-MERGE)");
});
