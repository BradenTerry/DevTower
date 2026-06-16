// Throwaway: zoom on a seated, actively-typing dev so the keyboard hand
// animation is visible. Dumps frames to screenshots/out/typinggif-frames/;
// assemble with ffmpeg. Run:
//   npm run screenshots -- -g typinggif
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "typinggif-frames");
const HTML = path.join(__dirname, ".harness.html");
const room = { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "main" }] };
const board = {
  branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0,
  committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true,
};
const agent = (state: string) => ({
  id: "cc-aaaa1111", name: "Atlas", state, repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 120_000, elapsed: "12m",
});

test("capture: typinggif", async ({ page }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(FRAMES, { recursive: true });
  for (const f of fs.readdirSync(FRAMES)) fs.rmSync(path.join(FRAMES, f));
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((s) => {
    window.postMessage({ type: "config", perf: "smooth", books: "physical" }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { agent: agent("active"), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.evaluate(() => { const i = (window as any).DevTowerCrew._instance; i.zoomMul = 3.4; i.focusAgent("cc-aaaa1111", false); });
  await page.waitForTimeout(700);

  const canvas = page.locator("#crew-canvas");
  let n = 0;
  for (let i = 0; i < 40; i++) {
    await canvas.screenshot({ path: path.join(FRAMES, `f${String(n++).padStart(3, "0")}.png`) });
    await page.waitForTimeout(70);
  }
  console.log(`wrote ${n} frames to typinggif-frames/`);
});
