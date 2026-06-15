// Throwaway capture: a dev on an UPPER floor leaves, riding the lift car down the
// external shaft. Grabs frames mid-descent so we can see the rider inside the car.
//   npm run screenshots -- -g elevdown
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "elevdown");
const HTML = path.join(__dirname, ".harness.elevdown.html");

const board = (branch: string) => ({
  branch, modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0,
  committedAdd: 0, committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0,
  commits: [], prReady: true,
});

// one island, two stacked buildings: main on the ground, a worktree a floor up
const rooms = [{
  name: "DevTower", path: "/repo", floor: 0, col: 0,
  worktrees: [{ path: "/repo", branch: "main" }, { path: "/repo-wt", branch: "feat/up" }],
}];
const boards = { "/repo": board("main"), "/repo-wt": board("feat/up") };

const agent = (id: string, name: string, worktree: string, branch: string) => ({
  id, name, state: "idle", repo: "DevTower", model: "opus-4.8",
  worktree, branch, skills: [], contextTokens: 40_000, elapsed: "5m",
});

const post = (page: any, agents: any[]) =>
  page.evaluate((d: any) => window.postMessage({ type: "state", agents: d.agents, rooms: d.rooms, boards: d.boards }, "*"),
    { agents, rooms, boards });

test("capture: elevdown", async ({ page }) => {
  test.setTimeout(120_000);
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[elevdown] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  const atlas = agent("a1", "Atlas", "/repo", "main");      // anchors the ground room
  const boris = agent("a2", "Boris", "/repo-wt", "feat/up"); // upstairs; will leave

  await page.evaluate(() => window.postMessage({ type: "config", eco: false }, "*"));
  await post(page, [atlas, boris]);
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("DevTower"));
  await page.evaluate(() => { const c = (window as any).DevTowerCrew._instance; c.zoomMul = 0.78; });

  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    const ts = [...c.toons.values()] as any[];
    return ts.length === 2 && ts.every((t) => t.sitting && !t.entering);
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    const z = c.cam.z, prev = (window as any).__z; (window as any).__z = z;
    return prev !== undefined && Math.abs(z - prev) < 0.002;
  }, { timeout: 8000, polling: 200 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "elevdown-before.png") });

  let f = 0;
  const shot = async () => page.screenshot({ path: path.join(FRAMES, `frame-${String(f++).padStart(3, "0")}.png`) });

  // Boris's session ends → it walks to the lift door and rides the car down.
  await post(page, [atlas]);

  for (let i = 0; i < 130; i++) {
    await shot();
    await page.waitForTimeout(33);
    const gone = await page.evaluate(() => {
      const c = (window as any).DevTowerCrew?._instance;
      return !c?.toons.get("a2") && !c?.leaving.some((t: any) => t.agent.id === "a2");
    });
    if (gone) break;
  }
  console.log(`wrote ${f} frames to ${FRAMES}`);
});
