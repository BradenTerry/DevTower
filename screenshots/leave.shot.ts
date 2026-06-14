// Throwaway capture for the "leftmost dev leaves" fix. Seats four devs in one
// room, shoots the full room, then removes the LEFTMOST dev and shoots again.
//
// Run twice to make a before/after of the code change:
//   VARIANT=before npm run screenshots -- -g leave   # built from old seat logic
//   VARIANT=after  npm run screenshots -- -g leave   # built from new seat logic
// The second shot (`leave-<variant>-gap.png`) is the meaningful pane: old logic
// shifts the survivors left; new logic keeps them put and drops the empty desk.
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.leave.html");
const V = process.env.VARIANT || "after";

const board = () => ({
  branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0,
  committedAdd: 0, committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0,
  commits: [], prReady: true,
});

const agent = (id: string, name: string) => ({
  id, name, state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 40_000, elapsed: "5m",
});

const rooms = [{ name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "main" }] }];

const settle = async (page: any, exp: number) => {
  await page.waitForFunction((e: number) => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    const ts = [...c.toons.values()] as any[];
    if (ts.length !== e) return false;
    return ts.every((t) => !t.entering && !t.leaving && Math.abs(t.targetX - t.x) <= 1);
  }, exp, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
};

test(`leave: ${V}`, async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error(`[leave] page error:`, e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  const four = [agent("a1", "Atlas"), agent("a2", "Boris"), agent("a3", "Cleo"), agent("a4", "Dot")];
  await page.evaluate(() => window.postMessage({ type: "config", eco: false }, "*"));
  await page.evaluate((d) => window.postMessage({ type: "state", agents: d.four, rooms: d.rooms, boards: { "/repo": d.b } }, "*"),
    { four, rooms, b: board() });
  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("DevTower"));
  await settle(page, 4);
  await page.screenshot({ path: path.join(OUT, `leave-${V}-full.png`) });

  // the LEFTMOST dev (a1) leaves; a2/a3/a4 remain
  const three = four.slice(1);
  await page.evaluate((d) => window.postMessage({ type: "state", agents: d.three, rooms: d.rooms, boards: { "/repo": d.b } }, "*"),
    { three, rooms, b: board() });
  await settle(page, 3);
  await page.screenshot({ path: path.join(OUT, `leave-${V}-gap.png`) });
  console.log(`wrote leave-${V}-full.png + leave-${V}-gap.png`);
});
