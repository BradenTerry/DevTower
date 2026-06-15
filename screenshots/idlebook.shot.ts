// Repro for the "idle dev stuck reading a book" bug. Spawns an active dev with no
// skills, adds a skill live (which sends it to the shelf to fetch a book → it
// reads at the desk), then flips it to idle. After the fix the idle dev must set
// the book down and kick its feet up, and booksInHand must reset to 0.
// Run: npm run screenshots -- -g idlebook
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

const agent = (over: any) => ({
  id: "a1", name: "Atlas", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", contextTokens: 40_000, elapsed: "3m", ...over,
});
const STATE = (over: any) => ({
  agents: [agent(over)],
  rooms: [{ name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "main" }] }],
  boards: {
    "/repo": {
      branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
      unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0, committedDel: 0,
      base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true,
    },
  },
});

const booksInHand = (page: any) => page.evaluate(() =>
  ((window as any).DevTowerCrew?._instance?.toons?.get("a1")?.booksInHand) ?? -1);

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
});

test("capture: idlebook", async ({ page }) => {
  page.on("pageerror", (e) => console.error("[idlebook] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // 1. active dev, no skills yet → seat it
  await page.evaluate((s) => window.postMessage({ type: "state", ...s }, "*"), STATE({ state: "active", skills: [] }));
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.evaluate(() => window.postMessage({ type: "focusAgent", id: "a1" }, "*"));
  await page.waitForFunction(() => {
    const t = (window as any).DevTowerCrew?._instance?.toons?.get("a1");
    return t && !t.entering && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 15000 }).catch(() => {});

  // 2. add a skill live → dev walks to the shelf, fetches a book, reads at the desk
  await page.evaluate((s) => window.postMessage({ type: "state", ...s }, "*"), STATE({ state: "active", skills: ["code-review"] }));
  await page.waitForFunction(() =>
    (((window as any).DevTowerCrew?._instance?.toons?.get("a1")?.booksInHand) ?? 0) > 0,
    { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  console.log("after skill use, booksInHand =", await booksInHand(page));
  await page.screenshot({ path: path.join(OUT, "idlebook-reading.png") });

  // 3. flip to idle → must put the book down and kick feet up
  await page.evaluate((s) => window.postMessage({ type: "state", ...s }, "*"), STATE({ state: "idle", skills: ["code-review"] }));
  await page.waitForTimeout(1200);
  const idleBooks = await booksInHand(page);
  console.log("after going idle, booksInHand =", idleBooks);
  await page.screenshot({ path: path.join(OUT, "idlebook-idle.png") });

  // the regression assertion: an idle dev is not holding a book
  expect(idleBooks).toBe(0);
});
