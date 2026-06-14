// Throwaway capture for the leaderboard's no-flicker live update + rank-change
// slide. Opens the board on the "busy" scenario, then bumps a low-ranked agent's
// context tokens so it leaps to #1, capturing a frame sequence across the FLIP
// animation. Assemble into a GIF afterwards with ffmpeg (see the run notes).
// Run: npm run screenshots -- -g leaderboard-anim
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";
import { SCENARIOS } from "./scenarios";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "lbanim");
const HTML = path.join(__dirname, ".harness.html");

test(`capture: leaderboard-anim`, async ({ page }) => {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[lbanim] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  const busy = SCENARIOS.find((s) => s.name === "busy")!;
  await page.evaluate((s) => {
    window.postMessage({ type: "config", eco: true }, "*");
    window.postMessage({ type: "state", ...s.state }, "*");
  }, busy as any);
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(400);
  await page.locator("#lbbtn").click();
  await page.waitForTimeout(400);

  const box = (await page.locator(".lb-card").boundingBox())!;
  const clip = { x: box.x, y: box.y, width: box.width, height: box.height };

  let f = 0;
  const shot = async () => page.screenshot({ path: path.join(FRAMES, `frame-${String(f++).padStart(3, "0")}.png`), clip });

  // a few frames at rest, then bump Cleo (a3) from 33k to 300k so it jumps to #1
  for (let i = 0; i < 4; i++) { await shot(); await page.waitForTimeout(40); }
  const bumped = JSON.parse(JSON.stringify(busy.state.agents)).map((a: any) =>
    a.id === "a3" ? { ...a, contextTokens: 300_000 } : a);
  await page.evaluate((agents) => window.postMessage({ type: "state", agents }, "*"), bumped);
  for (let i = 0; i < 18; i++) { await shot(); await page.waitForTimeout(28); }
  for (let i = 0; i < 4; i++) { await shot(); await page.waitForTimeout(40); }

  console.log(`wrote ${f} frames to ${FRAMES}`);
});
