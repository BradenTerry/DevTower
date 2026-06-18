// Throwaway: whiteboard-summary GIF. A seated dev gets a fresh AI summary, steps
// to the wide whiteboard in front of its desk, mimes writing the note, then sits
// back down. Dumps frames to screenshots/out/whiteboardgif-frames/; assemble with
// ffmpeg. Run:
//   npm run screenshots -- -g whiteboardgif
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "whiteboardgif-frames");
const HTML = path.join(__dirname, ".harness.html");
const room = { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "main" }] };
const board = {
  branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0,
  committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true,
};
const agent = (aiTitle?: string) => ({
  id: "cc-aaaa1111", name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], aiTitle, contextTokens: 120_000, elapsed: "12m",
});

test("capture: whiteboardgif", async ({ page }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(FRAMES, { recursive: true });
  for (const f of fs.readdirSync(FRAMES)) fs.rmSync(path.join(FRAMES, f));
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));
  const post = (a: any) => page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: a, room, board });

  // seat the dev (no summary yet), then frame it up close
  await page.evaluate((s) => {
    window.postMessage({ type: "config", perf: "smooth" }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { agent: agent(), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.evaluate(() => { const i = (window as any).DevTowerCrew._instance; i.zoomMul = 1.7; i.focusAgent("cc-aaaa1111", false); });
  await page.waitForTimeout(700);

  const canvas = page.locator("#crew-canvas");
  let n = 0;
  const grab = async () => { await canvas.screenshot({ path: path.join(FRAMES, `f${String(n++).padStart(3, "0")}.png`) }); };
  const until = async (done: () => Promise<boolean>, max: number) => {
    for (let i = 0; i < max; i++) { await grab(); if (await done()) return; await page.waitForTimeout(70); }
  };
  const flag = (expr: string) => page.evaluate((e) => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    // eslint-disable-next-line no-new-func
    return !!(t && new Function("t", `return ${e}`)(t));
  }, expr);

  for (let i = 0; i < 5; i++) { await grab(); await page.waitForTimeout(70); } // seated, blank board
  await post(agent("Render diff hunks in the viewer panel")); // summary lands → board trip
  await until(() => flag("t.board"), 40);            // step to the board
  await until(() => flag("t.board && t.board.phase==='write'"), 30); // arrive + start writing
  for (let i = 0; i < 26; i++) { await grab(); await page.waitForTimeout(70); }   // writing beat
  await until(() => flag("!t.board && t.sitting"), 50); // walk back + settle
  for (let i = 0; i < 8; i++) { await grab(); await page.waitForTimeout(70); }    // seated again, note on board

  console.log(`wrote ${n} frames to whiteboardgif-frames/`);
});
