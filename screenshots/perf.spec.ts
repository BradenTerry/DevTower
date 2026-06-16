// Performance regression tests (assertion-based, deterministic). Boots the real
// webview bundle and counts the canvas draw operations issued per frame, with
// culling off vs on and across graphics presets. Operation COUNTS don't vary by
// hardware, so these prove "does less work" repeatably and fail on regression —
// unlike wall-clock ms. setCull(false) reproduces the pre-optimization full-scene
// draw (already shown pixel-identical), so it's a faithful "before".
//
//   npm run perf:test
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const HTML = path.join(__dirname, ".perf.html");

const board = (o: Record<string, unknown> = {}) => ({
  branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0,
  committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true, ...o,
});
function bigCampus() {
  const rooms: any[] = [], agents: any[] = [], boards: Record<string, any> = {};
  let aid = 0;
  for (let b = 0; b < 12; b++) {
    const worktrees: any[] = [];
    for (let f = 0; f < 3; f++) {
      const wt = `/wt/${b}/${f}`, branch = f === 0 ? "main" : `feat/b${b}-${f}`;
      worktrees.push({ path: wt, branch });
      boards[wt] = board({ branch, modified: f % 3, unstagedAdd: f * 4, ahead: f % 2 });
      aid++;
      agents.push({ id: `a${aid}`, name: `Dev${aid}`, state: "active", repo: `PROJ${b}`, model: "opus-4.8", worktree: wt, branch, skills: [], contextTokens: 40000 + aid * 1000, elapsed: `${aid % 59}m` });
    }
    rooms.push({ name: `PROJ${b}`, path: `/wt/${b}/0`, floor: 0, col: b, worktrees });
  }
  return { agents, rooms, boards };
}

// Patch the 2D context to tally draw calls during exactly one draw(), with the
// requested culling + preset applied and the animation loop parked.
async function countOps(page: any, cull: boolean, preset: string) {
  return page.evaluate(({ cull, preset }: { cull: boolean; preset: string }) => {
    const C = (window as any).DevTowerCrew, c = C._instance;
    C.setQuality(preset);
    C.setCull(cull);
    c.stop();
    const proto = (CanvasRenderingContext2D as any).prototype;
    const names = ["fillRect", "strokeRect", "fillText", "strokeText", "fill", "stroke", "drawImage", "arc", "ellipse", "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo", "rect", "clip", "createLinearGradient", "createRadialGradient"];
    const orig: Record<string, any> = {}; const per: Record<string, number> = {}; let total = 0;
    for (const n of names) { orig[n] = proto[n]; per[n] = 0; proto[n] = function (...a: any[]) { per[n]++; total++; return orig[n].apply(this, a); }; }
    try { c.draw(); } finally { for (const n of names) proto[n] = orig[n]; }
    const s = C.perfSample();
    return { total, per, rooms: s.roomsDrawn, roomsTotal: s.roomsTotal };
  }, { cull, preset });
}

async function settleCamera(page: any) {
  await page.evaluate(() => { (window as any).__z = -1; (window as any).DevTowerCrew._instance.start(); });
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return true;
    const z = c.cam.z, prev = (window as any).__z;
    (window as any).__z = z;
    return Math.abs(z - prev) < 0.002;
  }, { timeout: 8000, polling: 200 }).catch(() => {});
}

test.beforeAll(() => fs.writeFileSync(HTML, harnessHtml(), "utf8"));

test("@perf culling and presets reduce per-frame draw work", async ({ page }) => {
  const campus = bigCampus();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox) && (window as any).__outbox.some((m: any) => m.type === "ready"), { timeout: 15000 });
  await page.evaluate((c) => window.postMessage({ type: "state", agents: c.agents, rooms: c.rooms, boards: c.boards }, "*"), campus);
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction((exp) => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    const ts = [...c.toons.values()] as any[];
    return ts.length >= exp && ts.every((t) => !t.entering && Math.abs(t.targetX - t.x) <= 1) && [...c.rooms.values()].every((r: any) => r.built >= 0.99);
  }, campus.agents.length, { timeout: 30000 });

  // --- overview camera (whole campus framed) ---
  await page.evaluate(() => (window as any).DevTowerCrew.clearFocus());
  await settleCamera(page);
  const offOverview = await countOps(page, false, "high"); // = pre-optimization full-scene draw
  const onOverview = await countOps(page, true, "high");
  const potatoOverview = await countOps(page, true, "potato");

  // --- focused camera (zoomed onto one dev's building) ---
  await page.evaluate((id) => window.postMessage({ type: "focusAgent", id }, "*"), campus.agents[Math.floor(campus.agents.length / 2)].id);
  await settleCamera(page);
  const onFocused = await countOps(page, true, "high");

  console.log("\n  draw-op counts (lower = less work):");
  console.log(`    overview, culling OFF (before): ${offOverview.total}  rooms ${offOverview.rooms}/${offOverview.roomsTotal}  gradients ${offOverview.per.createLinearGradient}`);
  console.log(`    overview, culling ON  (after):  ${onOverview.total}  rooms ${onOverview.rooms}/${onOverview.roomsTotal}`);
  console.log(`    overview, Potato preset:        ${potatoOverview.total}  gradients ${potatoOverview.per.createLinearGradient}`);
  console.log(`    focused,  culling ON  (after):  ${onFocused.total}  rooms ${onFocused.rooms}/${onFocused.roomsTotal}\n`);

  // 1. Zoomed into one building, culling does a small fraction of the full-scene work.
  expect(onFocused.total).toBeLessThan(offOverview.total * 0.3);
  // 2. Fewer rooms are drawn when focused than in overview, and overview itself culls some.
  expect(onFocused.rooms).toBeLessThan(onOverview.rooms);
  expect(onOverview.rooms).toBeLessThan(onOverview.roomsTotal);
  // 3. Culling never INCREASES work, even when most of the campus is framed.
  expect(onOverview.total).toBeLessThanOrEqual(offOverview.total);
  // 4. The Potato preset takes the flat-fill ground path: fewer gradient
  //    allocations than High at the same camera (the sky + dirt + grass gradients
  //    become flat fills; per-board gradients remain, so it is not zero).
  expect(onOverview.per.createLinearGradient).toBeGreaterThan(0);
  expect(potatoOverview.per.createLinearGradient).toBeLessThan(onOverview.per.createLinearGradient);
  // 5. Potato issues fewer ops than High at the same camera (dropped stars/pebbles/effects).
  expect(potatoOverview.total).toBeLessThan(onOverview.total);
});

test("@perf culling is pixel-identical to no-culling for the visible area", async ({ page }) => {
  const campus = bigCampus();
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox) && (window as any).__outbox.some((m: any) => m.type === "ready"), { timeout: 15000 });
  await page.evaluate((c) => window.postMessage({ type: "state", agents: c.agents, rooms: c.rooms, boards: c.boards }, "*"), campus);
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForFunction((exp) => {
    const c = (window as any).DevTowerCrew?._instance;
    return c && [...c.toons.values()].length >= exp && [...c.rooms.values()].every((r: any) => r.built >= 0.99);
  }, campus.agents.length, { timeout: 30000 });

  for (const cam of ["overview", "focused"]) {
    if (cam === "overview") await page.evaluate(() => (window as any).DevTowerCrew.clearFocus());
    else await page.evaluate((id) => window.postMessage({ type: "focusAgent", id }, "*"), campus.agents[6].id);
    await settleCamera(page);
    const diff = await page.evaluate(() => {
      const c = (window as any).DevTowerCrew._instance;
      const cv = document.getElementById("crew-canvas") as HTMLCanvasElement;
      const g = cv.getContext("2d", { willReadFrequently: true })!;
      c.stop();
      // Pin Math.random so the cable-packet flicker is identical between the two
      // draws — any remaining pixel diff is then purely a culling artifact.
      const rnd = Math.random;
      Math.random = () => 0.5;
      try {
        c.setCull(false); c.draw();
        const a = g.getImageData(0, 0, cv.width, cv.height).data;
        c.setCull(true); c.draw();
        const b = g.getImageData(0, 0, cv.width, cv.height).data;
        let d = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        const W = cv.width;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
            d++; const px = (i / 4) % W, py = Math.floor((i / 4) / W);
            if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
          }
        }
        return { d, box: d ? { minX, maxX, minY, maxY, W, H: cv.height } : null };
      } finally { Math.random = rnd; }
    });
    console.log(`  ${cam}: diff ${diff.d}px`, diff.box || "");
    expect(diff.d, `${cam}: culling changed ${diff.d} visible pixels at ${JSON.stringify(diff.box)}`).toBe(0);
  }
});
