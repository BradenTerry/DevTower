// Throwaway: merged-PR disco-party GIF. A room of seated devs gets its open PR
// flipped to MERGED; a mirror ball drops from the ceiling, the lights dim, colored
// beams sweep the room and every dev gets up to dance. Dumps frames to
// screenshots/out/discogif-frames/; assemble with ffmpeg. Run:
//   npm run screenshots -- -g discogif
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "discogif-frames");
const HTML = path.join(__dirname, ".harness.html");

const room = { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "feat/disco" }] };
const baseBoard = {
  branch: "feat/disco", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0,
  committedDel: 0, base: "main", ahead: 3, unpushed: 0, behind: 0, commits: ["disco ball", "dance", "beams"], prReady: true,
};
const openPr = {
  number: 117, title: "Disco party when a PR merges", url: "https://example.com/pr/117", draft: false,
  checks: "pass", checksPass: 3, checksFailed: 0, checksRunning: 0, checksTotal: 3,
  review: "approved", approvals: 2, changesRequested: 0, reviewersPending: 0, comments: 1,
};
const mergedPr = { ...openPr, checks: "none", checksPass: 0, checksTotal: 0, review: "none", approvals: 0, comments: 0, merged: true };

const agents = [
  { id: "cc-dev00001", name: "Atlas", state: "active" },
  { id: "cc-dev00002", name: "Nova", state: "idle" },
  { id: "cc-dev00003", name: "Pixel", state: "complete" },
  { id: "cc-dev00004", name: "Echo", state: "active" },
].map((a) => ({
  ...a, repo: "DevTower", model: "opus-4.8", worktree: "/repo", branch: "feat/disco",
  skills: [], contextTokens: 90_000, elapsed: "8m",
}));

test("capture: discogif", async ({ page }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(FRAMES, { recursive: true });
  for (const f of fs.readdirSync(FRAMES)) fs.rmSync(path.join(FRAMES, f));
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[discogif] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  const post = (board: any) => page.evaluate((d) => {
    window.postMessage({ type: "config", perf: "smooth" }, "*");
    window.postMessage({ type: "state", agents: d.agents, rooms: [d.room], boards: { "/repo": d.board } }, "*");
    window.postMessage({ type: "prs", crew: [], review: [], connected: true }, "*");
  }, { agents, room, board });

  // seat the crew with the OPEN PR, then frame the room up close
  await post({ ...baseBoard, pr: openPr });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("DevTower"));
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    const ts = [...c.toons.values()] as any[];
    return ts.length >= 4 && ts.every((t) => t.sitting && !t.entering);
  }, { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => { (window as any).DevTowerCrew._instance.zoomMul = 1.45; (window as any).DevTowerCrew.focusIsland("DevTower"); });
  await page.waitForTimeout(900);

  const canvas = page.locator("#crew-canvas");
  let n = 0;
  const grab = async () => { await canvas.screenshot({ path: path.join(FRAMES, `f${String(n++).padStart(3, "0")}.png`) }); };

  // a few frames of the calm room before the merge lands
  for (let i = 0; i < 6; i++) { await grab(); await page.waitForTimeout(70); }

  // flip the PR to MERGED -> tick detects the open->merged transition and starts
  // the disco party in the room.
  await post({ ...baseBoard, pr: mergedPr });
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew._instance;
    return [...c.rooms.values()].some((r: any) => r.disco);
  }, { timeout: 8000 }).catch(() => {});

  // capture the whole party: ball drop, dancing, beams, then the retract
  for (let i = 0; i < 150; i++) { await grab(); await page.waitForTimeout(70); }

  console.log(`wrote ${n} frames to discogif-frames/`);
});
