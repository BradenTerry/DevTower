// Throwaway capture for the /clear shred animation. Drives the harness through
// a session-clear (an agent replaced by a NEW id in the SAME worktree) and dumps
// a frame sequence to screenshots/out/shred-frames/ plus before/after stills.
// Assemble the GIF afterwards with ffmpeg (see the npm note below). Run:
//   npm run screenshots -- -g shred
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "shred-frames");
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
const agent = (id: string) => ({
  id, name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: ["code-review"], contextTokens: 120_000, elapsed: "12m",
});

test("capture: shred", async ({ page }) => {
  fs.mkdirSync(FRAMES, { recursive: true });
  for (const f of fs.readdirSync(FRAMES)) fs.rmSync(path.join(FRAMES, f));
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // seat the original session, then zoom in on its room
  await page.evaluate((s) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { agent: agent("cc-aaaa1111"), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  // wait for the dev to finish walking in and settle at its desk (the entry walk
  // can take several seconds), else the /clear swap is skipped while entering
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && Math.abs(t.targetX - t.x) <= 1;
  }, { timeout: 20000 });
  await page.waitForTimeout(400);

  const canvas = page.locator("#crew-canvas");
  await canvas.screenshot({ path: path.join(OUT, "shred-before.png") });

  // /clear: same worktree, NEW session id → the dev runs the shred trip
  await page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: agent("cc-bbbb2222"), room, board });

  // record the whole out → feed → back trip, tagging one still per phase by
  // reading the live toon's shred state straight off the instance
  const seenPhase = new Set<string>();
  for (let i = 0; i < 60; i++) {
    await canvas.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(3, "0")}.png`) });
    const phase = await page.evaluate(() => {
      const inst: any = (window as any).DevTowerCrew._instance;
      for (const tn of inst.toons.values()) if (tn.shred) return tn.shred.phase as string;
      return null;
    });
    if (phase && !seenPhase.has(phase)) {
      seenPhase.add(phase);
      await canvas.screenshot({ path: path.join(OUT, `shred-phase-${phase}.png`) });
      if (phase === "feed") await canvas.screenshot({ path: path.join(OUT, "shred-after.png") });
    }
    await page.waitForTimeout(110);
  }
  console.log("wrote shred frames + phase stills; phases seen:", [...seenPhase].join(","));
});
