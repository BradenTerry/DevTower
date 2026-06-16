// Throwaway capture for the ebook book-preference mode. Seats an active agent,
// flips the book preference to "ebook", then adds a skill: the dev borrows it on
// its phone (chat bubble) and reads at the desk; once the task goes idle
// the tiny e-reader counter shows on the desk. Then a /clear pops the "Returned"
// bubble. Run:
//   npm run screenshots -- -g ebook
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

test("capture: ebook", async ({ page }) => {
  test.setTimeout(60_000);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // ebook preference on, seat the session with NO skills yet, zoom into its room
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
  // zoom the camera right onto the dev so the phone + desk gadget read clearly
  await page.evaluate(() => { const i = (window as any).DevTowerCrew._instance; i.zoomMul = 2.4; i.focusAgent("cc-aaaa1111", false); });
  await page.waitForTimeout(700);

  // add a skill → ebook: borrow on the phone (bubble) + read at the desk
  await page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: agent("cc-aaaa1111", "active", ["code-review"]), room, board });
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && t.booksInHand > 0 && t.note;
  }, { timeout: 20000 });
  await page.waitForTimeout(250);

  const canvas = page.locator("#crew-canvas");
  await canvas.screenshot({ path: path.join(OUT, "ebook-reading.png") });
  console.log("wrote ebook-reading.png");

  // task goes idle → the dev sets the book down: the tiny desk e-reader counter shows
  await page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: agent("cc-aaaa1111", "idle", ["code-review"]), room, board });
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && t.booksShown > 0 && t.booksInHand === 0;
  }, { timeout: 20000 });
  await page.waitForTimeout(300);
  await canvas.screenshot({ path: path.join(OUT, "ebook-desk-counter.png") });
  console.log("wrote ebook-desk-counter.png");

  // /clear into a fresh session with no skill → "Returned my N books" on the phone
  await page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: agent("cc-bbbb2222", "active", []), room, board });
  await page.evaluate(() => { const i = (window as any).DevTowerCrew._instance; i.zoomMul = 2.4; i.focusAgent("cc-bbbb2222", false); });
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && t.note && /Returned/.test(t.note.title);
  }, { timeout: 20000 });
  await page.waitForTimeout(250);
  await canvas.screenshot({ path: path.join(OUT, "ebook-returned.png") });
  console.log("wrote ebook-returned.png");
});
