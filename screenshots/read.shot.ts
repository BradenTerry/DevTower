// Throwaway capture for the desk-reading pose + shredder placement. Seats an
// active agent with no skills, then adds one so the dev runs the shelf errand and
// reads the fetched book at its desk; zooms into the room so both the open book
// and the wall-side shredder are visible. Run:
//   npm run screenshots -- -g read
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
const agent = (skills: string[]) => ({
  id: "cc-aaaa1111", name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills, contextTokens: 120_000, elapsed: "12m",
});

const tag = process.env.SHOT_TAG || "after";

test("capture: read", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // seat the session with NO skills yet, then zoom in on its room
  await page.evaluate((s) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { agent: agent([]), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.waitForTimeout(400);

  // add a skill → the dev fetches a book from the shelf and reads it at the desk
  await page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: agent(["code-review"]), room, board });

  // wait until it's back at the desk reading (booksInHand > 0, errand done)
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && t.booksInHand > 0 && !t.errand && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.waitForTimeout(500);

  const canvas = page.locator("#crew-canvas");
  await canvas.screenshot({ path: path.join(OUT, `read-${tag}.png`) });
  console.log(`wrote read-${tag}.png`);
});
