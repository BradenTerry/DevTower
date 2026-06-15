// Throwaway capture for the "selected directory under the telemetry pill" HUD
// change. Shoots the top-left HUD with no selection (before), with a short path,
// and with a long path that exercises the leading-… truncation.
//   npm run screenshots -- -g seldir
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.seldir.html");

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

const post = (page: any, selectedDir?: string) =>
  page.evaluate((d: any) => window.postMessage(
    { type: "state", agents: d.agents, rooms: d.rooms, boards: { "/repo": d.b }, selectedDir: d.selectedDir }, "*"),
    { agents: [agent("a1", "Atlas")], rooms, b: board(), selectedDir });

const hud = (page: any, name: string) =>
  page.locator(".hud-left").screenshot({ path: path.join(OUT, `seldir-${name}.png`) });

test("capture: seldir", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[seldir] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));
  await page.evaluate(() => window.postMessage({ type: "config", eco: false }, "*"));

  await post(page);                       // no selection → row hidden
  await page.waitForTimeout(300);
  await hud(page, "before");

  await post(page, "~/Projects/DevTower"); // short path, fits
  await page.waitForTimeout(300);
  await hud(page, "short");

  await post(page, "~/Projects/DevTower/.claude/worktrees/quiet-floating-summit"); // long → leading …
  await page.waitForTimeout(300);
  await hud(page, "long");
  console.log("wrote seldir-before/short/long.png");
});
