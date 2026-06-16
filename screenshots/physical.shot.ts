// Throwaway: physical-mode borrow/return bubbles. A dev fetches a skill book from
// the shelf (→ "Borrowed a skill" bubble), then a /clear walks the book back to the
// shelf (→ "Returned my skill" bubble). Run:
//   npm run screenshots -- -g physical
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
const agent = (state: string, skills: string[], clearedSession?: string) => ({
  id: "cc-aaaa1111", name: "Atlas", state, repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills, clearedSession, contextTokens: 120_000, elapsed: "12m",
});

test("capture: physical", async ({ page }) => {
  test.setTimeout(90_000);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));
  const post = (a: any) => page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: a, room, board });
  const T = [() => (window as any).DevTowerCrew._instance.toons.values()][0];

  await page.evaluate((s) => {
    window.postMessage({ type: "config", perf: "smooth", books: "physical" }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { agent: agent("active", []), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.evaluate(() => { const i = (window as any).DevTowerCrew._instance; i.zoomMul = 2.2; i.focusAgent("cc-aaaa1111", false); });
  await page.waitForTimeout(700);

  const canvas = page.locator("#crew-canvas");

  // add a skill → walk to the shelf, fetch, carry back → "Borrowed a skill"
  await post(agent("active", ["code-review"]));
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && t.note && /Borrowed/.test(t.note.title);
  }, { timeout: 30000 });
  await page.waitForTimeout(250);
  await canvas.screenshot({ path: path.join(OUT, "physical-borrow.png") });
  console.log("wrote physical-borrow.png");

  // idle so the book lands on the desk (booksShown = 1)
  await post(agent("idle", ["code-review"]));
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && t.booksShown > 0 && t.booksInHand === 0 && !t.errand;
  }, { timeout: 20000 });
  await page.waitForTimeout(300);

  // /clear with no skill → shred papers + walk the book back to the shelf
  await post(agent("active", [], "clr-1"));
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && t.note && /Returned/.test(t.note.title);
  }, { timeout: 30000 });
  await page.waitForTimeout(200);
  await canvas.screenshot({ path: path.join(OUT, "physical-return.png") });
  console.log("wrote physical-return.png");
});
