// Throwaway capture for the token-leaderboard before/after. Boots the harness,
// loads the multi-agent "busy" scenario (varied contextTokens), centres the
// room and zooms in so the left-wall token board is legible, then writes a tight
// crop. Run: npm run screenshots -- -g tokenboard
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";
import { SCENARIOS } from "./scenarios";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

test(`capture: tokenboard`, async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[tokenboard] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  const busy = SCENARIOS.find((s) => s.name === "busy")!;
  await page.evaluate((s) => {
    window.postMessage({ type: "config", eco: true }, "*"); // freeze animation jitter
    window.postMessage({ type: "state", ...s.state }, "*");
  }, busy as any);

  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(600);

  // centre on the room, then zoom in hard so the wall panel reads
  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("DevTower"));
  await page.waitForTimeout(500);
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  // a wide full-room frame (both walls visible) for the base-vs-final before/after
  await page.screenshot({ path: path.join(OUT, "tokenboard-wide.png") });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -1450); // zoom in on the wall detail
  await page.waitForTimeout(400);
  // drag the scene left so the RIGHT side wall (door + token board) moves to centre
  const cy = box.y + box.height * 0.55;
  await page.mouse.move(box.x + box.width * 0.6, cy);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) await page.mouse.move(box.x + box.width * 0.6 - i * 28, cy);
  await page.mouse.up();
  await page.waitForTimeout(900);

  await page.screenshot({ path: path.join(OUT, "tokenboard.png") });
  // tight crop on the right-wall plaque for a legibility check
  await page.screenshot({ path: path.join(OUT, "tokenboard-crop.png"), clip: { x: 1235, y: 195, width: 210, height: 210 } });
  console.log("wrote tokenboard.png");
});
