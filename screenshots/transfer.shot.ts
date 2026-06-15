// Capture for the "worktree switch rides the elevator" change. A dev sits in the
// ground-floor `main` room, then its session relocates to a worktree stacked one
// floor up (the same move a `/cd`, a drag-drop, or an in-session `cd` produces —
// all of them surface as the agent's worktree changing). Instead of teleporting,
// the dev walks out the door, the lift car carries it up, and it walks to a desk
// on the new floor.
//
// Run, then assemble the GIF:
//   npm run screenshots -- -g transfer
//   ffmpeg -y -framerate 25 -i screenshots/out/transfer/frame-%03d.png \
//     -vf "scale=760:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
//     docs/screenshots/worktree-switch-elevator/transfer.gif
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "transfer");
const HTML = path.join(__dirname, ".harness.transfer.html");

const board = (branch: string) => ({
  branch, modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0,
  committedAdd: 0, committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0,
  commits: [], prReady: true,
});

// one island, two stacked buildings: main on the ground, a worktree a floor up
const rooms = [{
  name: "DevTower", path: "/repo", floor: 0, col: 0,
  worktrees: [{ path: "/repo", branch: "main" }, { path: "/repo-wt", branch: "feat/elevator" }],
}];
const boards = { "/repo": board("main"), "/repo-wt": board("feat/elevator") };

const agent = (id: string, name: string, worktree: string, branch: string) => ({
  id, name, state: "idle", repo: "DevTower", model: "opus-4.8",
  worktree, branch, skills: [], contextTokens: 40_000, elapsed: "5m",
});

const post = (page: any, agents: any[]) =>
  page.evaluate((d: any) => window.postMessage({ type: "state", agents: d.agents, rooms: d.rooms, boards: d.boards }, "*"),
    { agents, rooms, boards });

test("capture: transfer", async ({ page }) => {
  test.setTimeout(120_000);
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[transfer] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // Atlas anchors the ground room; Boris is the one that will relocate upstairs.
  const atlas = agent("a1", "Atlas", "/repo", "main");
  const borisMain = agent("a2", "Boris", "/repo", "main");
  const borisWt = agent("a2", "Boris", "/repo-wt", "feat/elevator");

  await page.evaluate(() => window.postMessage({ type: "config", eco: false }, "*"));
  await post(page, [atlas, borisMain]);
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("DevTower"));
  // zoom out a touch so both floors AND the full elevator-shaft travel stay in
  // frame (clear of the top HUD chips) for the whole ride
  await page.evaluate(() => { const c = (window as any).DevTowerCrew._instance; c.zoomMul = 0.78; });

  // settle both devs at their desks, and let the camera stop zooming
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    const ts = [...c.toons.values()] as any[];
    return ts.length === 2 && ts.every((t) => t.sitting && !t.entering && !t.transfer);
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    const z = c.cam.z, prev = (window as any).__z; (window as any).__z = z;
    return prev !== undefined && Math.abs(z - prev) < 0.002;
  }, { timeout: 8000, polling: 200 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "transfer-before.png") });

  let f = 0;
  const shot = async () => page.screenshot({ path: path.join(FRAMES, `frame-${String(f++).padStart(3, "0")}.png`) });
  const beat = async (frames: number, wait = 33) => { for (let i = 0; i < frames; i++) { await shot(); await page.waitForTimeout(wait); } };

  await beat(8, 40); // a beat at rest before the move

  // Boris's session relocates to the upstairs worktree (what a /cd or a drag-drop
  // confirms): same agent id, new worktree → the relocation animation fires.
  await post(page, [atlas, borisWt]);

  // capture until Boris is seated upstairs (transfer cleared), or we hit the cap
  for (let i = 0; i < 130; i++) {
    await shot();
    await page.waitForTimeout(33);
    const done = await page.evaluate(() => {
      const c = (window as any).DevTowerCrew?._instance;
      const t = c?.toons.get("a2");
      return !!t && !t.transfer && t.sitting && Math.abs(t.targetX - t.x) <= 1;
    });
    if (done) break;
  }
  await beat(8, 40); // settle upstairs

  await page.screenshot({ path: path.join(OUT, "transfer-after.png") });
  console.log(`wrote ${f} frames to ${FRAMES} (+ transfer-before/after.png)`);
});
