// Throwaway capture for the HUD token-leaderboard modal. Boots the harness,
// loads the multi-agent "busy" scenario (varied contextTokens), opens the
// leaderboard from its HUD button, and writes a full-frame + a tight card crop.
// Run: npm run screenshots -- -g leaderboard
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";
import { SCENARIOS } from "./scenarios";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

test(`capture: leaderboard`, async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[leaderboard] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  const busy = SCENARIOS.find((s) => s.name === "busy")!;
  await page.evaluate((s) => {
    window.postMessage({ type: "config", eco: true }, "*"); // freeze animation jitter
    window.postMessage({ type: "state", ...s.state }, "*");
  }, busy as any);

  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(400);

  // open the leaderboard from its HUD button
  await page.locator("#lbbtn").click();
  await page.waitForTimeout(400);

  await page.screenshot({ path: path.join(OUT, "leaderboard.png") });
  const card = page.locator(".lb-card");
  await card.screenshot({ path: path.join(OUT, "leaderboard-card.png") });
  console.log("wrote leaderboard.png");
});
