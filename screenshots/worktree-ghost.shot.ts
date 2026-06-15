// Focused capture of the "+ WORKTREE" ghost slot label so its color is legible
// against the dark sky. Run: npm run screenshots -- -g worktree-ghost
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
const lead = { id: "cc-lead0001", name: "DevTower-1", state: "active", repo: "DevTower", model: "opus-4.8", worktree: "/repo", branch: "main", skills: [], contextTokens: 90_000, elapsed: "4m" };

const tag = process.env.SHOT_TAG || "after";

test("capture: worktree-ghost", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[worktree-ghost] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((d) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: [d.lead], rooms: [d.room], boards: { "/repo": d.board } }, "*");
  }, { lead, room, board });
  await page.evaluate(() => (document as any).fonts?.ready);

  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("DevTower"));
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    (window as any).__z = c.cam.z;
    return [...c.toons.values()].every((t: any) => t.sitting && !t.entering);
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => {
    const z = (window as any).DevTowerCrew._instance.cam.z, prev = (window as any).__z;
    (window as any).__z = z;
    return Math.abs(z - prev) < 0.002;
  }, { timeout: 8000, polling: 200 }).catch(() => {});
  await page.waitForTimeout(500);

  // crop around the ghost slot label sitting on top of the tower
  const crop = await page.evaluate(() => {
    const c = (window as any).DevTowerCrew._instance;
    const g = c.ghosts.find((x: any) => x.kind === "building") || c.ghosts[0];
    const ROOM_W = 260, ROOM_H = 84; // matches crew.ts constants
    const s = c.screenOf(g.x0 + ROOM_W / 2, g.base - ROOM_H / 2);
    return { x: Math.max(0, Math.round(s.x - 150)), y: Math.max(0, Math.round(s.y - 80)), width: 300, height: 140 };
  });
  await page.screenshot({ path: path.join(OUT, `worktree-ghost-${tag}.png`), clip: crop });
  console.log(`wrote worktree-ghost-${tag}.png`);
});
