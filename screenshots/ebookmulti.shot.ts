// Throwaway: ebook borrow bubble when several skills land at once.
//   npm run screenshots -- -g ebookmulti
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
const agent = (skills: string[]) => ({
  id: "cc-aaaa1111", name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills, contextTokens: 120_000, elapsed: "12m",
});

test("capture: ebookmulti", async ({ page }) => {
  test.setTimeout(60_000);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((s) => {
    window.postMessage({ type: "config", perf: "smooth", books: "ebook" }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { agent: agent([]), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.evaluate(() => { const i = (window as any).DevTowerCrew._instance; i.zoomMul = 2.4; i.focusAgent("cc-aaaa1111", false); });
  await page.waitForTimeout(800);

  // three skills land in the same update → "Borrowed 3 skills"
  await page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: agent(["code-review", "release", "verify"]), room, board });
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && t.note && /skills/.test(t.note.title);
  }, { timeout: 20000 });
  await page.waitForTimeout(250);

  await page.locator("#crew-canvas").screenshot({ path: path.join(OUT, "ebook-multi.png") });
  console.log("wrote ebook-multi.png");
});
