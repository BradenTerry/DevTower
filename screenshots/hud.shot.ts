// Before/after capture for the HUD tidy-up: drop the DEVTOWER brand block and
// move the 5h / weekly plan-usage meters from the top bar to the bottom-right.
// Full-page shots so both the (now absent) top-left brand and the bottom-right
// meters are visible. Run:
//   npm run screenshots -- -g hud
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

const room = {
  name: "DevTower", path: "/repo", floor: 0, col: 0,
  worktrees: [{ path: "/repo", branch: "main" }],
};
const board = {
  branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0,
  committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true,
};
const agent = {
  id: "cc-aaaa1111", name: "DevTower-1", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 90_000, elapsed: "4m",
};
const usage = { fiveHour: { pct: 42, resetsAt: 0 }, sevenDay: { pct: 73, resetsAt: 0 } };

test("capture: hud", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((s) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    window.postMessage({ type: "usage", usage: s.usage }, "*");
  }, { agent, room, board, usage });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(1200);

  await page.screenshot({ path: path.join(OUT, "hud.png") });
  console.log("wrote hud.png");
});
