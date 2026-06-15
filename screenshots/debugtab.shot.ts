// Capture of the Settings > Debug tab with a captured log + rotated archives,
// to show the new "Open folder" button and archive count.
// Run: npm run screenshots -- -g debugtab
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

test("capture: debugtab", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // a captured log on disk plus 3 rotated archives, logging on
  await page.evaluate(() => {
    window.postMessage({ type: "config", eco: false, debug: true,
      debugLogExists: true, debugLogArchives: 3 }, "*");
    window.postMessage({ type: "openSettings", tab: "debug" }, "*");
  });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(400);
  // ensure the Debug tab is the active pane
  await page.evaluate(() => {
    const b = document.querySelector('.s-tab[data-tab="debug"]') as HTMLButtonElement | null;
    b?.click();
  });
  await page.waitForTimeout(300);

  const card = page.locator(".settings-card");
  await card.screenshot({ path: path.join(OUT, "debugtab.png") });
  console.log("wrote debugtab.png");
});
