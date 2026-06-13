// Before/after capture for the settings tab order (General first, default).
// Run: npm run screenshots -- -g settings
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");
const caps = { connected: false, login: "", scopes: [], features: {} };

test("capture: settings", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((c) => {
    window.postMessage({ type: "settings", caps: c, scopeHelp: {} }, "*");
    window.postMessage({ type: "openSettings" }, "*");
  }, caps);
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(600);

  const card = page.locator(".settings-card");
  await card.screenshot({ path: path.join(OUT, "settings.png") });
  console.log("wrote settings.png");
});
