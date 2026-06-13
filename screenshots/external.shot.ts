// Before/after capture for the external-agent "ghost" treatment. Seats two devs
// in one room — an owned DevTower dev and a session running OUTSIDE DevTower —
// and captures the room with the outside dev rendered normally (before) then
// ghosted: grayed, semi-transparent, dashed-underline name (after). Run:
//   npm run screenshots -- -g external
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
const owned = {
  id: "cc-own00001", name: "DevTower-1", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 90_000, elapsed: "4m",
};
const outsider = (external: boolean) => ({
  id: "cc-ext07840", name: "webapp·784c", state: "waiting", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 60_000, elapsed: "9m", external,
});

const postState = (page: any, agents: any[]) =>
  page.evaluate((s: any) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: s.agents, rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agents, room, board });

test("capture: external", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // both devs walked in/settled AND the focus-zoom camera reached a steady
  // frame, so before/after share the exact same viewport
  const settle = async () => {
    await page.evaluate(() => (document as any).fonts?.ready);
    await page.waitForFunction(() => {
      const c = (window as any).DevTowerCrew._instance;
      const ts = [...c.toons.values()] as any[];
      const seated = ts.length >= 2 && ts.every((t) => !t.entering && Math.abs(t.targetX - t.x) <= 1);
      const z0 = c.cam.z;
      (window as any).__z = z0;
      return seated;
    }, { timeout: 20000 });
    // camera stable: zoom unchanged across a short interval
    await page.waitForFunction(() => {
      const z = (window as any).DevTowerCrew._instance.cam.z;
      const prev = (window as any).__z;
      (window as any).__z = z;
      return Math.abs(z - prev) < 0.002;
    }, { timeout: 8000, polling: 250 });
    await page.waitForTimeout(400);
  };

  const canvas = page.locator("#crew-canvas");

  // BEFORE: the outside dev renders like any other. Focus the island ONCE and
  // let the camera fully settle — the AFTER shot then reuses that exact viewport
  // (no re-focus) so the pair differs only by the ghost treatment.
  await postState(page, [owned, outsider(false)]);
  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("DevTower"));
  await settle();
  await canvas.screenshot({ path: path.join(OUT, "external-before.png") });

  // AFTER: flip the outside dev to external — same camera, ghost treatment only
  await postState(page, [owned, outsider(true)]);
  await page.waitForTimeout(600);
  await canvas.screenshot({ path: path.join(OUT, "external-after.png") });
  console.log("wrote external-before.png / external-after.png");
});
