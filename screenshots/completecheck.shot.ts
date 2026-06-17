// Throwaway before/after capture for the "task complete" change. Seats one dev
// and captures it in two states: `waiting` (the OLD behavior on finishing — hand
// up, amber "?") and `complete` (the NEW behavior — reclined, green "✓"). Writes
// to screenshots/out (gitignored); the PNGs go in the PR description, not git.
//   npm run screenshots -- -g completecheck
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
const agent = (state: string, question?: string) => ({
  id: "cc-aaaa1111", name: "Atlas", state, repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 120_000, elapsed: "12m",
  ...(question ? { question } : {}),
});

const shoot = async (page: any, st: string, question: string | undefined, name: string) => {
  await page.evaluate((s: any) => {
    window.postMessage({ type: "state", agents: [s.a], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { a: agent(st, question), room, board });
  await page.waitForTimeout(700); // let the pose/bubble settle and the wave swing
  await page.locator("#crew-canvas").screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};

test("capture: completecheck", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((s: any) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: [s.a], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { a: agent("active"), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.waitForTimeout(400);

  // before: the old behavior surfaced a finished turn as `waiting` — hand up, "?"
  await shoot(page, "waiting", "Claude is waiting for your input", "completecheck-before");
  // after: a finished turn with nothing pending now reads `complete` — green "✓"
  await shoot(page, "complete", undefined, "completecheck-after");
});
