// Throwaway capture for the plan-usage meters showing the window reset countdown
// inline (it was previously only in the hover tooltip). Posts a `usage` message,
// captures the meter cluster as "after", then hides the new .ureset spans to
// reproduce the old look for "before". Run:
//   npm run screenshots -- -g usagereset
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

// resets_at are unix seconds; pick offsets from a fixed base so the countdown
// renders deterministically (2h 47m and 3d 4h-ish reduced to the compact form).
const now = Math.floor(Date.now() / 1000);
const usage = {
  fiveHour: { pct: 62, resetsAt: now + 2 * 3600 + 47 * 60 },
  sevenDay: { pct: 88, resetsAt: now + 26 * 3600 + 12 * 60 },
};

test("capture: usagereset", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((u) => {
    window.postMessage({ type: "config", eco: false }, "*");
    window.postMessage({ type: "usage", usage: u }, "*");
  }, usage);
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(400);

  const meters = page.locator("#usage");
  await meters.screenshot({ path: path.join(OUT, "usagereset-after.png") });
  console.log("wrote usagereset-after.png");

  // reproduce the pre-change look: drop the inline reset spans
  await page.evaluate(() => {
    document.querySelectorAll(".umeter .ureset").forEach((e) => e.remove());
  });
  await page.waitForTimeout(150);
  await meters.screenshot({ path: path.join(OUT, "usagereset-before.png") });
  console.log("wrote usagereset-before.png");
});
