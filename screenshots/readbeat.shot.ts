// Throwaway capture proving the read beat: a dev reads a freshly-fetched skill
// book for a short beat, then sets it down on the desk EVEN WHILE THE TASK STAYS
// ACTIVE (it no longer reads for the whole session). Ebook mode is used so the
// pickup is instant (no shelf walk) and the put-down shows the desk e-reader.
//   npm run screenshots -- -g readbeat
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
const agent = (id: string, state: string, skills: string[]) => ({
  id, name: "Atlas", state, repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills, contextTokens: 120_000, elapsed: "12m",
});

test("capture: readbeat", async ({ page }) => {
  test.setTimeout(60_000);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // ebook on, seat an active session with no skills yet, zoom into its room
  await page.evaluate((s) => {
    window.postMessage({ type: "config", perf: "smooth", books: "ebook" }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { agent: agent("cc-aaaa1111", "active", []), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.evaluate(() => { const i = (window as any).DevTowerCrew._instance; i.zoomMul = 2.4; i.focusAgent("cc-aaaa1111", false); });
  await page.waitForTimeout(700);

  // add a skill → the dev picks up the book and starts the read beat
  await page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: agent("cc-aaaa1111", "active", ["run"]), room, board });
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && t.booksInHand > 0;
  }, { timeout: 20000 });
  await page.waitForTimeout(250);
  const canvas = page.locator("#crew-canvas");
  await canvas.screenshot({ path: path.join(OUT, "readbeat-reading.png") });
  console.log("wrote readbeat-reading.png (book in hand, task active)");

  // do NOT change the state — the session stays active the whole time. Wait out
  // the read beat (READ_SECS = 10s) and confirm the book is set down anyway.
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && t.agent.state === "active" && t.booksInHand === 0 && t.booksShown > 0;
  }, { timeout: 20000 });
  await page.waitForTimeout(300);
  await canvas.screenshot({ path: path.join(OUT, "readbeat-done.png") });
  console.log("wrote readbeat-done.png (book set down, task STILL active)");
});
