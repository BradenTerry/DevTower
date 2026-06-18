// Before/after for tightening the click-to-zoom on an agent. Clicking a dev calls
// focusAgent(), whose framing is set by focus.spanW / focus.spanH. Smaller spans
// → the camera sits closer to the dev. Run:
//   npm run screenshots -- -g agent-zoom
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

const room = {
  name: "DevTower", path: "/repo", floor: 0, col: 0,
  worktrees: [{ path: "/repo", branch: "main" }],
};
const agent = {
  id: "cc-aaaa1111", name: "DevTower-1", state: "active", repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 90_000, elapsed: "4m",
};

test("capture: agent-zoom", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((s) => {
    window.postMessage({ type: "config", eco: true }, "*");
    window.postMessage({ type: "state", agents: [s.agent], rooms: [s.room], boards: {} }, "*");
  }, { agent, room });
  await page.evaluate(() => (document as any).fonts?.ready);

  // let the toon settle at its desk, then zoom onto it the way a click does
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    return c && c.toons.has("cc-aaaa1111");
  }, { timeout: 8000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).DevTowerCrew._instance.focusAgent("cc-aaaa1111"));
  await page.waitForTimeout(1500); // let the camera glide finish

  const variant = process.env.ZOOM_VARIANT || "after";
  await page.screenshot({ path: path.join(OUT, `agent-zoom-${variant}.png`) });
  console.log(`wrote agent-zoom-${variant}.png`);
});
