// Throwaway capture harness: renders each mock scenario and writes PNGs to
// screenshots/out/. Not run by `npm test` (vitest). Run on demand:
//   npm run screenshots            # all scenarios
//   npm run screenshots -- -g busy # one scenario by name
//
// For a UI before/after: run on the base commit, stash the out/ pngs, switch to
// your branch, run again, and diff/embed the pair (see CLAUDE.md).
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";
import { SCENARIOS } from "./scenarios";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
});

for (const sc of SCENARIOS) {
  test(`capture: ${sc.name}`, async ({ page }) => {
    page.on("pageerror", (e) => console.error(`[${sc.name}] page error:`, e.message));
    await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });

    // wait until the front-end has booted (console.js posts "ready" on mount)
    await page.waitForFunction(() => Array.isArray((window as any).__outbox)
      && (window as any).__outbox.some((m: any) => m.type === "ready"));

    // drive the scenario the way the extension would
    await page.evaluate((s) => {
      const post = (m: any) => window.postMessage(m, "*");
      if (s.config) post({ type: "config", eco: !!s.config.eco });
      post({ type: "state", ...s.state });
      if (s.prs) post({ type: "prs", crew: s.prs.crew, review: s.prs.review });
      if (s.usage) post({ type: "usage", usage: s.usage });
    }, sc as any);

    // let fonts load and the canvas paint a settled frame
    await page.evaluate(() => (document as any).fonts?.ready);
    await page.waitForTimeout(1200);

    await page.screenshot({ path: path.join(OUT, `${sc.name}.png`) });
    const hud = page.locator(".hud-top");
    if (await hud.count()) await hud.screenshot({ path: path.join(OUT, `${sc.name}-hud.png`) });
    console.log(`wrote ${sc.name}.png + ${sc.name}-hud.png`);
  });
}
