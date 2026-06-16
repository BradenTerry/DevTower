// DevTower render benchmark. Boots the real webview bundle (media/crew.js +
// console.js) in headless Chromium, builds a heavy campus of active agents, and
// measures draw() self-time (the per-frame render cost) under two camera views
// and every graphics-quality preset, at deviceScaleFactor 1 and 2.
//
//   npm run bench                       # full matrix, writes screenshots/out/bench.json
//   BENCH_BUILDINGS=20 npm run bench    # bigger campus
//   BENCH_PRESETS=low,high npm run bench
//   BENCH_SECONDS=2 npm run bench       # shorter sample window
//
// The numbers are hardware-relative (they reflect THIS machine's GPU/CPU), so the
// point is the BEFORE/AFTER delta and the focused-vs-overview gap, not absolute
// ms. Run it on the base commit, save bench.json, then re-run on the branch.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const OUT = path.join(__dirname, "out");
const HTML = path.join(__dirname, ".bench.html");
const mediaUrl = (p) => pathToFileURL(path.join(MEDIA, p)).href;

// Same standalone page the screenshot harness builds: the <body> lifted from
// consolePanel.ts with file:// includes for the runtime bundles.
function harnessHtml() {
  const src = fs.readFileSync(path.join(ROOT, "src", "consolePanel.ts"), "utf8");
  const m = src.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  if (!m) throw new Error("could not find <body> in consolePanel.ts");
  const body = m[1].replace(/<script[\s\S]*?<\/script>/g, "").replace(/\$\{[^}]*\}/g, "");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${mediaUrl("console.css")}" rel="stylesheet" /><title>DevTower bench</title></head>
<body data-theme="dark">${body}
<script>window.__outbox=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__outbox.push(m),getState:()=>undefined,setState:()=>{}});</script>
<script src="${mediaUrl("crew.js")}"></script>
<script src="${mediaUrl("console.js")}"></script>
</body></html>`;
}

const BUILDINGS = +(process.env.BENCH_BUILDINGS || 12); // columns across the campus
const FLOORS = +(process.env.BENCH_FLOORS || 3); // worktree rooms stacked per building
const PER_WT = +(process.env.BENCH_AGENTS || 1); // active devs per worktree
const SECONDS = +(process.env.BENCH_SECONDS || 3); // sample window per cell
const PRESETS = (process.env.BENCH_PRESETS || "high,balanced,low,potato").split(",").map((s) => s.trim());
const DPRS = (process.env.BENCH_DPR || "1,2").split(",").map(Number);

const board = (over) => ({
  branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0,
  committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true, ...over,
});

// A wide, busy campus: every worktree carries an active dev (so the loop never
// idles) and a board with some churn (so cables, packets, and stat cells light up).
function bigCampus() {
  const rooms = [], agents = [], boards = {};
  let aid = 0;
  for (let b = 0; b < BUILDINGS; b++) {
    const repo = `PROJ${b}`;
    const worktrees = [];
    for (let f = 0; f < FLOORS; f++) {
      const wt = `/wt/${b}/${f}`;
      const branch = f === 0 ? "main" : `feat/b${b}-${f}`;
      worktrees.push({ path: wt, branch });
      boards[wt] = board({ branch, modified: f % 3, unstagedAdd: f * 4, staged: (f + 1) % 2, ahead: f % 2, unpushed: f % 2, committedAdd: f * 3 });
      for (let k = 0; k < PER_WT; k++) {
        aid++;
        agents.push({
          id: `a${aid}`, name: `Dev${aid}`, state: "active", repo, model: "opus-4.8",
          worktree: wt, branch, skills: k % 2 ? ["code-review"] : [], contextTokens: 40000 + aid * 1000, elapsed: `${aid % 59}m`,
        });
      }
    }
    rooms.push({ name: repo, path: `/wt/${b}/0`, floor: 0, col: b, worktrees });
  }
  return { agents, rooms, boards };
}

// Spin draw() as fast as rAF allows for `secs`, with the animation loop parked so
// only our calls drive the canvas — isolates pure render cost from tick cadence.
function measureInPage(page, secs) {
  return page.evaluate((s) => new Promise((res) => {
    const C = window.DevTowerCrew, c = C && C._instance;
    if (!c) return res({ error: "no instance" });
    c.stop(); // park the animation loop so only this spin paints
    const draw = c.draw.bind(c);
    const times = [], gaps = [];
    let last = performance.now();
    const end = last + s * 1000;
    function spin() {
      const t0 = performance.now();
      draw();
      const t1 = performance.now();
      times.push(t1 - t0);
      gaps.push(t1 - last);
      last = t1;
      if (t1 < end) requestAnimationFrame(spin);
      else {
        const pct = (a, p) => { const x = [...a].sort((m, n) => m - n); return x[Math.min(x.length - 1, Math.floor((p / 100) * x.length))]; };
        const mean = times.reduce((a, b) => a + b, 0) / times.length;
        const medGap = pct(gaps, 50);
        const out = {
          n: times.length,
          p50: +pct(times, 50).toFixed(3),
          p95: +pct(times, 95).toFixed(3),
          mean: +mean.toFixed(3),
          fps: medGap > 0 ? +(1000 / medGap).toFixed(1) : 0,
          sample: C.perfSample ? C.perfSample() : null,
        };
        c.start(); // resume the loop for the next camera move
        res(out);
      }
    }
    requestAnimationFrame(spin);
  }), secs);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settleScene(page, expectedToons) {
  await page.waitForFunction((exp) => {
    const c = window.DevTowerCrew && window.DevTowerCrew._instance;
    if (!c) return false;
    const ts = [...c.toons.values()];
    if (ts.length < exp) return false;
    const seated = ts.every((t) => !t.entering && Math.abs(t.targetX - t.x) <= 1);
    const built = [...c.rooms.values()].every((r) => r.built >= 0.99);
    return seated && built;
  }, expectedToons, { timeout: 30000 }).catch(() => {});
}

async function settleCamera(page) {
  await page.evaluate(() => { window.__z = -1; });
  await page.waitForFunction(() => {
    const c = window.DevTowerCrew && window.DevTowerCrew._instance;
    if (!c) return true;
    const z = c.cam.z, prev = window.__z;
    window.__z = z;
    return Math.abs(z - prev) < 0.002;
  }, { timeout: 8000, polling: 200 }).catch(() => {});
}

async function applyPreset(page, preset) {
  await page.evaluate((p) => {
    const C = window.DevTowerCrew;
    if (C.setQuality) C.setQuality(p); // Phase 2 API
    else { const map = { high: "smooth", balanced: "balanced", low: "eco", potato: "eco" }; C.setPerf(map[p] || "balanced"); }
  }, preset);
  await sleep(120);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  const campus = bigCampus();
  const expectedToons = campus.agents.length;
  const browser = await chromium.launch({ headless: true });
  const results = [];

  console.log(`\nDevTower render benchmark`);
  console.log(`campus: ${BUILDINGS} buildings x ${FLOORS} floors = ${campus.rooms.length} buildings, ${expectedToons} active devs`);
  console.log(`window: 1440x900   sample: ${SECONDS}s/cell   presets: ${PRESETS.join(", ")}\n`);

  for (const dpr of DPRS) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
    page.on("pageerror", (e) => console.error(`  [dpr${dpr}] page error:`, e.message));
    await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
    await page.waitForFunction(() => Array.isArray(window.__outbox) && window.__outbox.some((m) => m.type === "ready"), { timeout: 15000 }).catch(() => {});
    await page.evaluate((c) => {
      window.postMessage({ type: "state", agents: c.agents, rooms: c.rooms, boards: c.boards }, "*");
    }, campus);
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await settleScene(page, expectedToons);

    const cameras = [
      { mode: "overview", apply: () => page.evaluate(() => window.DevTowerCrew.clearFocus && window.DevTowerCrew.clearFocus()) },
      { mode: "focused", apply: () => page.evaluate((n) => window.DevTowerCrew.focusIsland && window.DevTowerCrew.focusIsland(n), campus.rooms[0].name) },
    ];

    for (const cam of cameras) {
      await page.evaluate(() => { const c = window.DevTowerCrew._instance; if (!c.running) c.start(); });
      await cam.apply();
      await settleCamera(page);
      for (const preset of PRESETS) {
        await applyPreset(page, preset);
        const r = await measureInPage(page, SECONDS);
        results.push({ dpr, camera: cam.mode, preset, ...r });
        const cull = r.sample ? `${r.sample.roomsDrawn}/${r.sample.roomsTotal}` : "-";
        console.log(
          `  dpr${dpr}  ${cam.mode.padEnd(9)} ${preset.padEnd(9)} ` +
          `draw p50 ${String(r.p50).padStart(6)}ms  p95 ${String(r.p95).padStart(6)}ms  ` +
          `~${String(r.fps).padStart(5)}fps  rooms ${cull}`
        );
      }
    }
    await page.close();
  }

  await browser.close();
  const outFile = path.join(OUT, "bench.json");
  fs.writeFileSync(outFile, JSON.stringify({ campus: { BUILDINGS, FLOORS, PER_WT }, seconds: SECONDS, results }, null, 2));
  console.log(`\nwrote ${path.relative(ROOT, outFile)}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
