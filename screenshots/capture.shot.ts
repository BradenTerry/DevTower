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
      if (s.prs) post({ type: "prs", crew: s.prs.crew, review: s.prs.review, connected: s.connected });
      if (s.usage) post({ type: "usage", usage: s.usage });
    }, sc as any);

    // optionally open an agent's side panel
    if ((sc as any).focusAgent) {
      await page.evaluate((id) => window.postMessage({ type: "focusAgent", id }, "*"), (sc as any).focusAgent);
      await page.waitForTimeout(200);
    }

    // optionally frame an island's whole tower (all stacked rooms in view)
    if ((sc as any).focusIsland) {
      await page.evaluate((name) => (window as any).DevTowerCrew.focusIsland(name), (sc as any).focusIsland);
    }

    // optionally pull back to the fit-all overview (every island in frame)
    if ((sc as any).overview) {
      await page.evaluate(() => (window as any).DevTowerCrew?.clearFocus?.());
    }

    // optionally open the settings overlay seeded with mock capabilities
    if ((sc as any).settings) {
      await page.evaluate((st) => {
        window.postMessage({ type: "settings", caps: st.caps, scopeHelp: st.scopeHelp }, "*");
        window.postMessage({ type: "openSettings" }, "*");
      }, (sc as any).settings);
    }

    // Wait for the scene to actually settle before the shot: every dev has
    // walked in and seated at its desk (no mid-arrival sprites in half-empty
    // rooms), and the camera has stopped zooming. A fixed timeout caught devs
    // mid-walk; this polls the real toon + camera state like subagents.shot.ts.
    const expected = (sc.state.agents || []).length;
    await page.evaluate(() => (document as any).fonts?.ready);
    await page.waitForFunction((exp) => {
      const c = (window as any).DevTowerCrew?._instance;
      if (!c) return false;
      const ts = [...c.toons.values()] as any[];
      if (ts.length < exp) return false; // not all devs have spawned yet
      const seated = ts.every((t) => !t.entering && Math.abs(t.targetX - t.x) <= 1);
      (window as any).__z = c.cam.z;
      return seated;
    }, expected, { timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => {
      const c = (window as any).DevTowerCrew?._instance;
      if (!c) return true;
      const z = c.cam.z;
      const prev = (window as any).__z;
      (window as any).__z = z;
      return Math.abs(z - prev) < 0.002;
    }, { timeout: 8000, polling: 250 }).catch(() => {});
    await page.waitForTimeout(400);

    await page.screenshot({ path: path.join(OUT, `${sc.name}.png`) });
    const hud = page.locator(".hud-top");
    if (await hud.count()) await hud.screenshot({ path: path.join(OUT, `${sc.name}-hud.png`) });
    const panel = page.locator(".panel:not([hidden])");
    if (await panel.count()) await panel.screenshot({ path: path.join(OUT, `${sc.name}-panel.png`) });
    const card = page.locator(".settings-card");
    if (await card.count()) {
      await card.screenshot({ path: path.join(OUT, `${sc.name}-card.png`) });
      // also capture each left-rail tab
      for (const tab of await page.locator(".s-tab").all()) {
        const name = (await tab.getAttribute("data-tab")) || "tab";
        await tab.click();
        await page.waitForTimeout(150);
        await card.screenshot({ path: path.join(OUT, `${sc.name}-${name}.png`) });
      }
    }
    console.log(`wrote ${sc.name}.png`);
  });
}
