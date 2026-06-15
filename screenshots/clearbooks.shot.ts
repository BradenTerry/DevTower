// Throwaway capture for the /clear book-return trip. An agent with a skill (so a
// book sits on its desk) is /cleared into a NEW session that no longer carries
// the skill, so the dev shreds its context papers AND walks the book back to the
// bookshelf — stepping into the scene at the shelf, clear of the front shredder.
// Dumps a frame sequence to screenshots/out/clearbooks-frames/ plus per-phase
// stills. Assemble the GIF afterwards with ffmpeg. Run:
//   npm run screenshots -- -g clearbooks
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "clearbooks-frames");
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
// the original session has used a skill (a book is on its desk); the successor
// after /clear has dropped it (fresh context), so the book is returned
const agent = (id: string, skills: string[]) => ({
  id, name: "Atlas", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills, contextTokens: 120_000, elapsed: "12m",
});

test("capture: clearbooks", async ({ page }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(FRAMES, { recursive: true });
  for (const f of fs.readdirSync(FRAMES)) fs.rmSync(path.join(FRAMES, f));
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // seat the original session (with a skill book), then zoom in on its room
  await page.evaluate((s) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
    (window as any).DevTowerCrew.focusIsland("DevTower");
  }, { agent: agent("cc-aaaa1111", ["code-review"]), room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  // wait for the dev to settle at its desk with the book shown (else the /clear
  // swap is skipped while still entering/walking)
  await page.waitForFunction(() => {
    const t = [...(window as any).DevTowerCrew._instance.toons.values()][0] as any;
    return t && !t.entering && !t.errand && Math.abs(t.targetX - t.x) <= 1 && t.booksShown >= 1;
  }, { timeout: 20000 });
  await page.waitForTimeout(400);

  const canvas = page.locator("#crew-canvas");
  await canvas.screenshot({ path: path.join(OUT, "clearbooks-before.png") });

  // /clear: same worktree, NEW session id, NO skill → shred papers + return book
  await page.evaluate((s) => {
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent: agent("cc-bbbb2222", []), room, board });

  // record the whole out → feed → shelf → place → back trip, tagging one still
  // per phase by reading the live toon's shred state off the instance
  const seenPhase = new Set<string>();
  for (let i = 0; i < 90; i++) {
    await canvas.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(3, "0")}.png`) });
    const phase = await page.evaluate(() => {
      const inst: any = (window as any).DevTowerCrew._instance;
      for (const tn of inst.toons.values()) if (tn.shred) return tn.shred.phase as string;
      return null;
    });
    if (phase && !seenPhase.has(phase)) {
      seenPhase.add(phase);
      await canvas.screenshot({ path: path.join(OUT, `clearbooks-phase-${phase}.png`) });
    }
    await page.waitForTimeout(110);
  }
  await canvas.screenshot({ path: path.join(OUT, "clearbooks-after.png") });
  console.log("wrote clearbooks frames + phase stills; phases seen:", [...seenPhase].join(","));
});
