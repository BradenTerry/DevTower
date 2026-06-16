// Throwaway capture for an ebook-mode GIF: borrow a skill on the phone (phone + chat
// bubble) → set it down (desk e-reader counter) → /clear, where the seated dev
// pulls out its phone and says it returned its Ebooks. Dumps a frame sequence to
// screenshots/out/ebookgif-frames/; assemble the GIF afterwards with ffmpeg. Run:
//   npm run screenshots -- -g ebookgif
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "ebookgif-frames");
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
const agent = (state: string, skills: string[], clearedSession?: string) => ({
  id: "cc-aaaa1111", name: "Atlas", state, repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills, clearedSession, contextTokens: 120_000, elapsed: "12m",
});

test("capture: ebookgif", async ({ page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(FRAMES, { recursive: true });
  for (const f of fs.readdirSync(FRAMES)) fs.rmSync(path.join(FRAMES, f));
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  const post = (a: any) => page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: a, room, board });

  // ebook on; seat an active session with no skills yet; zoom onto the dev
  await page.evaluate((s) => {
    window.postMessage({ type: "config", perf: "smooth", books: "ebook" }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { agent: agent("active", []), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.evaluate(() => { const i = (window as any).DevTowerCrew._instance; i.zoomMul = 2.4; i.focusAgent("cc-aaaa1111", false); });
  await page.waitForTimeout(800);

  const canvas = page.locator("#crew-canvas");
  let n = 0;
  const grab = async () => { await canvas.screenshot({ path: path.join(FRAMES, `f${String(n++).padStart(3, "0")}.png`) }); };
  const beat = async (frames: number) => { for (let i = 0; i < frames; i++) { await grab(); await page.waitForTimeout(90); } };

  await beat(6);                                  // settled at the desk
  await post(agent("active", ["code-review"]));   // borrow on the phone
  await beat(22);                                 // phone reading + "Borrowed …" bubble
  await post(agent("idle", ["code-review"]));     // task done → set it down
  await beat(18);                                 // desk e-reader counter shows
  await post(agent("active", [], "clr-1"));       // /clear → seated phone return
  await beat(26);                                 // "Returned my 1 Ebook" on the phone
  await beat(4);

  console.log(`wrote ${n} frames to ebookgif-frames/`);
});
