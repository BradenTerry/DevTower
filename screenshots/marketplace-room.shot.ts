// Capture for the marketplace "single room" still (media/shot-room.png): one
// focused DevTower room - board (branch, change counts, PR cell), USE DIR / + DEV
// controls, the ghost slot for the next worktree, and the dev at its desk showing
// a sub-agent badge. Full-page so the telemetry strip and HUD frame it.
// Run: npm run screenshots -- -g marketplace-room
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

const room = { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "main" }] };
const board = {
  branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0,
  committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true,
};
const lead = { id: "cc-lead0001", name: "DevTower-1", state: "active", repo: "DevTower", model: "opus-4.8", worktree: "/repo", branch: "main", skills: [], contextTokens: 90_000, elapsed: "4m", subagents: 1, aiTitle: "Wire up the agent side-panel" };

test("capture: marketplace-room", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[marketplace-room] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((d) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: [d.lead], rooms: [d.room], boards: { "/repo": d.board } }, "*");
    window.postMessage({ type: "prs", crew: [], review: [], connected: true }, "*");
  }, { lead, room, board });
  await page.evaluate(() => (document as any).fonts?.ready);

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
  await page.waitForTimeout(500);

  await page.screenshot({ path: path.join(OUT, "marketplace-room.png") });
  console.log("wrote marketplace-room.png");
});
