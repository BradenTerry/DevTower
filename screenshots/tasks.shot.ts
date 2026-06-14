// Before/after + animation capture for the desk task TV. Seats one dev, captures
// it with no task list (before), then with a 1/4 Task-tool checklist which raises
// the TV on its desk (after). Also dumps a frame sequence walking the count up
// (1/4 -> 4/4) with the completion-button slap, stitched into a GIF afterwards.
// Run:
//   npm run screenshots -- -g tasks
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "tasks-frames");
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
const lead = (tasks?: { done: number; total: number }) => ({
  id: "cc-lead0001", name: "DevTower-1", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 90_000, elapsed: "4m", tasks,
});

const postState = (page: any, agents: any[]) =>
  page.evaluate((s: any) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: s.agents, rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agents, room, board });

test("capture: tasks", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  const settle = async () => {
    await page.evaluate(() => (document as any).fonts?.ready);
    await page.waitForFunction(() => {
      const c = (window as any).DevTowerCrew._instance;
      const ts = [...c.toons.values()] as any[];
      const seated = ts.length >= 1 && ts.every((t) => !t.entering && Math.abs(t.targetX - t.x) <= 1);
      (window as any).__z = c.cam.z;
      return seated;
    }, { timeout: 20000 });
    await page.waitForFunction(() => {
      const z = (window as any).DevTowerCrew._instance.cam.z;
      const prev = (window as any).__z;
      (window as any).__z = z;
      return Math.abs(z - prev) < 0.002;
    }, { timeout: 8000, polling: 250 });
    await page.waitForTimeout(400);
  };

  const canvas = page.locator("#crew-canvas");

  // BEFORE: lead dev with no task list — bare desk
  await postState(page, [lead()]);
  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("DevTower"));
  await settle();
  await canvas.screenshot({ path: path.join(OUT, "tasks-before.png") });

  // AFTER: dev now has a 1/4 checklist — the TV rises on its stand
  await postState(page, [lead({ done: 1, total: 4 })]);
  await page.waitForTimeout(1200); // let the TV deploy
  await canvas.screenshot({ path: path.join(OUT, "tasks-after.png") });

  // ANIMATION: walk the count up; each bump slaps the desk button + flashes the
  // screen. Grab a dense burst of frames around each completion for the GIF.
  let fi = 0;
  const grab = async () => {
    await canvas.screenshot({ path: path.join(FRAMES, `f${String(fi++).padStart(3, "0")}.png`) });
  };
  for (let i = 0; i < 6; i++) await (await page.waitForTimeout(70), grab());
  for (const done of [2, 3, 4]) {
    await postState(page, [lead({ done, total: 4 })]);
    for (let i = 0; i < 9; i++) await (await page.waitForTimeout(70), grab());
  }
  for (let i = 0; i < 6; i++) await (await page.waitForTimeout(70), grab());
  await canvas.screenshot({ path: path.join(OUT, "tasks-done.png") });
  console.log(`wrote tasks-before/after/done.png and ${fi} gif frames`);
});
