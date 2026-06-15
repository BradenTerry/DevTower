// Before/after for "frame the room, not the desk, when zooming to a freshly
// spawned dev". A worktree building sits on floor 1; a brand-new dev spawns into
// it, rides the elevator up and walks across the room to its desk.
//
//   BEFORE: focusAgent() tight-zooms the desk, so the elevator ride + walk
//           happen off-camera and the dev just pops in at its seat.
//   AFTER:  setSelected() frames the whole room (the shipped behavior), so the
//           ride + walk stay on-screen. The selection arrow + name still show.
//
// Run, then assemble the two GIFs:
//   npm run screenshots -- -g spawn-zoom
//   for v in before after; do \
//     ffmpeg -y -framerate 25 -i screenshots/out/spawnzoom-$v/frame-%03d.png \
//       -vf "scale=760:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
//       docs/screenshots/spawn-zoom/$v.gif; done
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

// main on the ground + one stacked worktree (floor 1); the dev spawns into the
// worktree so it has to ride the elevator up and walk across to its seat.
const room = {
  name: "DEMO-APP", path: "/repo", floor: 0, col: 0,
  worktrees: [{ path: "/repo", branch: "main" }, { path: "/wt/feat", branch: "feat/elevator" }],
};
const agent = {
  id: "a1", name: "Nova", state: "active", repo: "DEMO-APP", model: "opus-4.8",
  worktree: "/wt/feat", branch: "feat/elevator", skills: [], contextTokens: 42_000, elapsed: "0m",
};

async function capture(page: any, variant: "before" | "after") {
  const frames = path.join(OUT, `spawnzoom-${variant}`);
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e: Error) => console.error(`[spawn-zoom:${variant}] page error:`, e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // overview first, so the camera visibly flies IN to its target (desk vs room)
  await page.evaluate(() => (window as any).DevTowerCrew._instance.clearFocus());
  await page.evaluate((d: any) => {
    window.postMessage({ type: "config", eco: false }, "*"); // eco off → smooth walk
    window.postMessage({ type: "state", agents: [d.agent], rooms: [d.room], boards: {} }, "*");
    window.postMessage({ type: "prs", crew: [], review: [], connected: true }, "*");
  }, { agent, room });
  await page.evaluate(() => (document as any).fonts?.ready);

  // wait for the freshly spawned toon to exist (setAgents created it + queued the
  // entry walk), then trigger the focus the way each variant does.
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    return c && c.toons.has("a1");
  }, { timeout: 8000 });
  await page.evaluate((v: string) => {
    const c = (window as any).DevTowerCrew._instance;
    // both variants select the dev (arrow + name show); only the camera differs.
    if (v === "before") { c.selectedId = "a1"; c.focusAgent("a1"); } // old: tight desk zoom
    else c.setSelected("a1");                                        // new: frame the room
  }, variant);

  // capture the elevator ride + walk + settle
  let f = 0;
  for (let i = 0; i < 80; i++) {
    await page.screenshot({ path: path.join(frames, `frame-${String(f++).padStart(3, "0")}.png`) });
    await page.waitForTimeout(33);
  }
  console.log(`[spawn-zoom:${variant}] wrote ${f} frames to ${frames}`);
}

test("spawn-zoom: before", async ({ page }) => {
  test.setTimeout(120_000);
  await capture(page, "before");
});

test("spawn-zoom: after", async ({ page }) => {
  test.setTimeout(120_000);
  await capture(page, "after");
});
