// Throwaway: physical-mode GIF. A dev fetches a skill book from the shelf
// ("Borrowed a skill"), reads it, sets it down, then a /clear walks the book back
// to the shelf ("Returned my skill"). Dumps frames to
// screenshots/out/physicalgif-frames/; assemble with ffmpeg. Run:
//   npm run screenshots -- -g physicalgif
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "physicalgif-frames");
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

test("capture: physicalgif", async ({ page }) => {
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
  let n = 0;
  const grab = async () => { await canvas.screenshot({ path: path.join(FRAMES, `f${String(n++).padStart(3, "0")}.png`) }); };
  // capture frames at ~70ms until `done()` returns true, or `max` frames pass
  const until = async (done: () => Promise<boolean>, max: number) => {
    for (let i = 0; i < max; i++) { await grab(); if (await done()) return; await page.waitForTimeout(70); }
  };
  const noteHas = (re: string) => page.evaluate((r) => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return !!(t && t.note && new RegExp(r).test(t.note.title));
  }, re);
  const flag = (expr: string) => page.evaluate((e) => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    // eslint-disable-next-line no-new-func
    return !!(t && new Function("t", `return ${e}`)(t));
  }, expr);

  for (let i = 0; i < 4; i++) { await grab(); await page.waitForTimeout(70); } // seated
  await post(agent("active", ["code-review"]));     // → shelf errand
  await until(() => noteHas("Borrowed"), 60);        // walk, grab, carry back, bubble
  for (let i = 0; i < 14; i++) { await grab(); await page.waitForTimeout(70); } // reading
  await post(agent("idle", ["code-review"]));        // set the book on the desk
  await until(() => flag("t.booksShown>0 && !t.errand"), 30);
  for (let i = 0; i < 6; i++) { await grab(); await page.waitForTimeout(70); }
  await post(agent("active", [], "clr-1"));          // /clear → shred + return to shelf
  await until(() => noteHas("Returned"), 70);        // walk to bin, feed, walk to shelf, bubble
  for (let i = 0; i < 16; i++) { await grab(); await page.waitForTimeout(70); }

  console.log(`wrote ${n} frames to physicalgif-frames/`);
});
