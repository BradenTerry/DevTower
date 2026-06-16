// Before/after for "add a new dev → frame the new dev's room, not the tower".
// Drives the REAL console.js message flow (not crew internals): an established
// tower sits at the overview with the panel closed, then a `state` message adds a
// brand-new dev with selectedId set (exactly what ConsolePanel.addDev posts).
//
//   BEFORE: console.js only adopted m.selectedId while the panel was open, so the
//           new selection was dropped, setSelected() never reached the new dev,
//           and the camera stayed on the tower overview.
//   AFTER:  console.js also adopts a host selection that points at a brand-new
//           agent, so the camera flies in and frames the new dev's room.
//
// Swap behaviors by checking out the old vs new media/console.js (the harness
// loads it verbatim); run each variant, then assemble the GIFs:
//   npm run screenshots -- -g newdev-room
//   for v in before after; do \
//     ffmpeg -y -framerate 25 -i screenshots/out/newdev-$v/frame-%03d.png \
//       -vf "scale=760:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
//       screenshots/out/newdev-room-$v.gif; done
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".harness.html");

// main on the ground + one stacked worktree (floor 1); the new dev spawns into
// the worktree so it rides the elevator up and walks across to its seat.
const room = {
  name: "DEMO-APP", path: "/repo", floor: 0, col: 0,
  worktrees: [{ path: "/repo", branch: "main" }, { path: "/wt/feat", branch: "feat/elevator" }],
};
const existing = {
  id: "a1", name: "Atlas", state: "active", repo: "DEMO-APP", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills: [], contextTokens: 88_000, elapsed: "12m",
};
// the freshly added + DEV: a new id the host selects on spawn.
const fresh = {
  id: "a2", name: "Nova", state: "idle", repo: "DEMO-APP", model: "—",
  worktree: "/wt/feat", branch: "feat/elevator", skills: [], contextTokens: 0, elapsed: "new",
};

async function capture(page: any, variant: string) {
  const frames = path.join(OUT, `newdev-${variant}`);
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e: Error) => console.error(`[newdev:${variant}] page error:`, e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  // established tower at the overview, panel closed.
  await page.evaluate((d: any) => {
    window.postMessage({ type: "config", eco: false }, "*"); // eco off → smooth walk
    window.postMessage({ type: "state", agents: [d.existing], rooms: [d.room], boards: {} }, "*");
    window.postMessage({ type: "prs", crew: [], review: [], connected: true }, "*");
  }, { existing, room });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.evaluate(() => (window as any).DevTowerCrew._instance.clearFocus());
  await page.waitForTimeout(600); // let the overview settle so the fly-in is visible

  // host adds + DEV: a state carrying the new agent AND selectedId on it, panel
  // still closed. This is the exact shape ConsolePanel.addDev posts.
  await page.evaluate((d: any) => {
    window.postMessage(
      { type: "state", agents: [d.existing, d.fresh], rooms: [d.room], boards: {}, selectedId: d.fresh.id },
      "*",
    );
  }, { existing, fresh, room });

  // capture the (fly-in +) elevator ride + walk + settle
  let f = 0;
  for (let i = 0; i < 80; i++) {
    await page.screenshot({ path: path.join(frames, `frame-${String(f++).padStart(3, "0")}.png`) });
    await page.waitForTimeout(33);
  }
  console.log(`[newdev:${variant}] wrote ${f} frames to ${frames}`);
}

test("newdev-room", async ({ page }) => {
  test.setTimeout(120_000);
  await capture(page, process.env.NEWDEV_VARIANT || "after");
});
