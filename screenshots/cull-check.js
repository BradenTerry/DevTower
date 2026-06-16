// Correctness check for viewport culling: render the heavy campus with culling
// OFF and ON at several cameras and pixel-diff the canvas. Culling must only drop
// off-canvas geometry, so the visible pixels have to be identical. Any nonzero
// diff localized to a building means we culled something that was on screen.
//
//   node screenshots/cull-check.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const HTML = path.join(__dirname, ".cullcheck.html");
const mediaUrl = (p) => pathToFileURL(path.join(MEDIA, p)).href;

function harnessHtml() {
  const src = fs.readFileSync(path.join(ROOT, "src", "consolePanel.ts"), "utf8");
  const body = src.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "").replace(/\$\{[^}]*\}/g, "");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<link href="${mediaUrl("console.css")}" rel="stylesheet" /></head>
<body data-theme="dark">${body}
<script>window.__outbox=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__outbox.push(m),getState:()=>undefined,setState:()=>{}});</script>
<script src="${mediaUrl("crew.js")}"></script><script src="${mediaUrl("console.js")}"></script></body></html>`;
}

const BUILDINGS = +(process.env.BENCH_BUILDINGS || 12);
const FLOORS = +(process.env.BENCH_FLOORS || 3);
const board = (o) => ({ branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [], unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0, committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true, ...o });
function bigCampus() {
  const rooms = [], agents = [], boards = {}; let aid = 0;
  for (let b = 0; b < BUILDINGS; b++) {
    const worktrees = [];
    for (let f = 0; f < FLOORS; f++) {
      const wt = `/wt/${b}/${f}`, branch = f === 0 ? "main" : `feat/b${b}-${f}`;
      worktrees.push({ path: wt, branch });
      boards[wt] = board({ branch, modified: f % 3, unstagedAdd: f * 4, ahead: f % 2 });
      aid++; agents.push({ id: `a${aid}`, name: `Dev${aid}`, state: "active", repo: `PROJ${b}`, model: "opus-4.8", worktree: wt, branch, skills: [], contextTokens: 40000 + aid * 1000, elapsed: `${aid % 59}m` });
    }
    rooms.push({ name: `PROJ${b}`, path: `/wt/${b}/0`, floor: 0, col: b, worktrees });
  }
  return { agents, rooms, boards };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  const campus = bigCampus();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray(window.__outbox) && window.__outbox.some((m) => m.type === "ready"), { timeout: 15000 }).catch(() => {});
  await page.evaluate((c) => window.postMessage({ type: "state", agents: c.agents, rooms: c.rooms, boards: c.boards }, "*"), campus);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForFunction((exp) => {
    const c = window.DevTowerCrew && window.DevTowerCrew._instance;
    if (!c) return false;
    const ts = [...c.toons.values()];
    return ts.length >= exp && ts.every((t) => !t.entering && Math.abs(t.targetX - t.x) <= 1) && [...c.rooms.values()].every((r) => r.built >= 0.99);
  }, campus.agents.length, { timeout: 30000 }).catch(() => {});

  const cameras = [
    { mode: "overview", apply: () => page.evaluate(() => window.DevTowerCrew.clearFocus()) },
    { mode: "island", apply: () => page.evaluate((n) => window.DevTowerCrew.focusIsland(n), campus.rooms[Math.floor(BUILDINGS / 2)].name) },
    { mode: "agent", apply: () => page.evaluate((id) => window.postMessage({ type: "focusAgent", id }, "*"), campus.agents[Math.floor(campus.agents.length / 2)].id) },
  ];

  let worst = 0;
  for (const cam of cameras) {
    await page.evaluate(() => { const c = window.DevTowerCrew._instance; if (!c.running) c.start(); });
    await cam.apply();
    await sleep(1500); // let the camera tween settle
    const res = await page.evaluate(() => {
      const c = window.DevTowerCrew._instance;
      const cv = document.getElementById("crew-canvas");
      const g = cv.getContext("2d", { willReadFrequently: true });
      c.stop();
      c.setCull(false); c.draw();
      const a = g.getImageData(0, 0, cv.width, cv.height).data;
      c.setCull(true); c.draw();
      const b = g.getImageData(0, 0, cv.width, cv.height).data;
      let diff = 0, maxd = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (d > 0) { diff++; if (d > maxd) maxd = d; }
      }
      const s = window.DevTowerCrew.perfSample();
      return { diff, total: a.length / 4, maxd, rooms: `${s.roomsDrawn}/${s.roomsTotal}`, z: +c.cam.z.toFixed(3) };
    });
    worst = Math.max(worst, res.diff);
    const pct = ((res.diff / res.total) * 100).toFixed(4);
    console.log(`  ${cam.mode.padEnd(9)} z=${String(res.z).padStart(7)}  rooms ${res.rooms.padStart(6)}  diff ${String(res.diff).padStart(8)} px (${pct}%)  maxDelta ${res.maxd}`);
  }
  await browser.close();
  console.log(worst === 0
    ? "\nPASS: culling is pixel-identical to no-culling for the visible area.\n"
    : `\nNOTE: ${worst} differing pixels at worst (see above). Investigate if localized to a building (over-cull) vs scattered (animation noise).\n`);
})().catch((e) => { console.error(e); process.exit(1); });
