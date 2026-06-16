// Throwaway capture for the Explore magnifying-glass trip. Seats an active
// agent, then flips `exploring` on (an Explore subagent is in flight) so the dev
// walks to the bookshelf and inspects the spines with a magnifier, then flips it
// off so the dev walks back to its desk. Dumps a frame sequence to
// screenshots/out/explore-frames/ plus an inspecting still. Assemble the GIF
// afterwards with ffmpeg. Run:
//   npm run screenshots -- -g explore
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "explore-frames");
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
const agent = (exploring: boolean) => ({
  id: "cc-aaaa1111", name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 120_000, elapsed: "12m",
  exploring,
});

test("capture: explore", async ({ page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(FRAMES, { recursive: true });
  for (const f of fs.readdirSync(FRAMES)) fs.rmSync(path.join(FRAMES, f));
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // seat the session at its desk, then zoom in on its room
  await page.evaluate((s) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { agent: agent(false), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && !t.errand && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.waitForTimeout(400);

  const canvas = page.locator("#crew-canvas");
  await canvas.screenshot({ path: path.join(OUT, "explore-before.png") });

  // an Explore subagent starts: the dev heads to the shelf and inspects
  await page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: agent(true), room, board });

  // record the walk-out + inspecting hold; grab one still while inspecting
  let stillGrabbed = false;
  for (let i = 0; i < 50; i++) {
    await canvas.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(3, "0")}.png`) });
    if (!stillGrabbed) {
      const looking = await page.evaluate(() => {
        const inst: any = (window as any).DevTowerCrew._instance;
        for (const tn of inst.toons.values()) if (tn.explore?.phase === "look") return true;
        return false;
      });
      if (looking) {
        stillGrabbed = true;
        await canvas.screenshot({ path: path.join(OUT, "explore-inspecting.png") });
      }
    }
    await page.waitForTimeout(90);
  }

  // Explore returns: the dev walks back to its desk
  await page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: agent(false), room, board });
  for (let i = 50; i < 80; i++) {
    await canvas.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(3, "0")}.png`) });
    await page.waitForTimeout(90);
  }

  await canvas.screenshot({ path: path.join(OUT, "explore-after.png") });
  console.log("wrote explore frames + inspecting still");
});
