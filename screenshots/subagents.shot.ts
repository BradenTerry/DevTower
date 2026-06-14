// Before/after capture for the sub-agent count badge. Seats one dev, captures it
// with no sub-agents (before) then with 3 in-flight sub-agents, which draws the
// pixel bot-head + count to the left of its name (after). Run:
//   npm run screenshots -- -g subagents
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
const lead = (subagents: number) => ({
  id: "cc-lead0001", name: "DevTower-1", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 90_000, elapsed: "4m", subagents,
});

const postState = (page: any, agents: any[]) =>
  page.evaluate((s: any) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: s.agents, rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agents, room, board });

test("capture: subagents", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
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

  // BEFORE: lead dev with no sub-agents — plain name label
  await postState(page, [lead(0)]);
  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("DevTower"));
  await settle();
  await canvas.screenshot({ path: path.join(OUT, "subagents-before.png") });

  // AFTER: same dev now has 3 in-flight sub-agents — bot-head badge + count
  await postState(page, [lead(3)]);
  await page.waitForTimeout(600);
  await canvas.screenshot({ path: path.join(OUT, "subagents-after.png") });
  console.log("wrote subagents-before.png / subagents-after.png");
});
