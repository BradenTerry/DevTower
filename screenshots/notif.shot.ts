// Before/after capture for the bottom-left notification HUD. "Before" shows the
// collapsed inbox icon (with an unread badge) pinned to the corner. "After"
// shows the panel opened, with the alerts listed and the debug HUD shoved above
// it. Bottom-left clips so the stacking is visible. Run:
//   npm run screenshots -- -g notif
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
const agent = {
  id: "cc-aaaa1111", name: "DevTower-1", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 90_000, elapsed: "4m",
};

const clip = { x: 0, y: 640, width: 340, height: 260 };

test("capture: notif", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((s) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: { "/repo": s.board } }, "*");
  }, { agent, room, board });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(1000);
  // perf HUD on for both shots so the "shoved above" stacking is visible. Do this
  // AFTER the config/state messages process, since their handlers re-assert the
  // (default off) perf-HUD setting and would otherwise clobber it.
  await page.evaluate(() => (window as any).DevTowerCrew?.setPerfHud(true));
  await page.waitForTimeout(400);

  // push a few notifications so the inbox shows an unread badge
  await page.evaluate(() => {
    const c = (window as any).DevTowerCrew;
    c?.pushNotification({ kind: "done", name: "DevTower-1", repo: "DevTower", agentId: "cc-aaaa1111" });
    c?.pushNotification({ kind: "error", name: "api-worker", repo: "billing", agentId: "cc-bbbb2222" });
    c?.pushNotification({ kind: "question", name: "ui-refactor", repo: "DevTower", agentId: "cc-cccc3333" });
  });
  await page.waitForTimeout(400);

  // BEFORE: the collapsed inbox icon with its unread badge (bottom-left clip)
  await page.screenshot({ path: path.join(OUT, "notif-before.png"), clip });
  console.log("wrote notif-before.png");

  // AFTER: open the modal; it pops out centered over a dimmed backdrop, so
  // capture the whole viewport rather than the bottom-left corner
  await page.evaluate(() => (window as any).DevTowerCrew?.setNotifOpen(true));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "notif-after.png") });
  console.log("wrote notif-after.png");
});
