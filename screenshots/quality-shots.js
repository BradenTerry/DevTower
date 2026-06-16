// Capture proof shots for the graphics-quality work: the scene at High vs Potato,
// the performance overlay, and the new Settings controls. Writes PNGs to
// screenshots/out/quality/. Run: node screenshots/quality-shots.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const OUT = path.join(__dirname, "out", "quality");
const HTML = path.join(__dirname, ".quality.html");
const mediaUrl = (p) => pathToFileURL(path.join(MEDIA, p)).href;

function harnessHtml() {
  const src = fs.readFileSync(path.join(ROOT, "src", "consolePanel.ts"), "utf8");
  const body = src.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "").replace(/\$\{[^}]*\}/g, "");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;600;700&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
<link href="${mediaUrl("console.css")}" rel="stylesheet" /></head>
<body data-theme="dark">${body}
<script>window.__outbox=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__outbox.push(m),getState:()=>undefined,setState:()=>{}});</script>
<script src="${mediaUrl("crew.js")}"></script><script src="${mediaUrl("console.js")}"></script></body></html>`;
}

const board = (o) => ({ branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [], unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0, committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true, ...o });
// A small, readable campus so the quality difference is easy to see.
function campus() {
  const rooms = [], agents = [], boards = {}; let aid = 0;
  for (let b = 0; b < 4; b++) {
    const worktrees = [];
    for (let f = 0; f < 2; f++) {
      const wt = `/wt/${b}/${f}`, branch = f === 0 ? "main" : `feat/b${b}`;
      worktrees.push({ path: wt, branch });
      boards[wt] = board({ branch, modified: f, unstagedAdd: f * 6, ahead: f, unpushed: f });
      aid++; agents.push({ id: `a${aid}`, name: `Dev${aid}`, state: aid % 4 === 0 ? "waiting" : "active", repo: `PROJ${b}`, model: "opus-4.8", worktree: wt, branch, skills: aid % 2 ? ["code-review"] : [], contextTokens: 40000 + aid * 9000, elapsed: `${aid * 3}m` });
    }
    rooms.push({ name: `PROJ${b}`, path: `/wt/${b}/0`, floor: 0, col: b, worktrees });
  }
  return { agents, rooms, boards };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  const c = campus();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray(window.__outbox) && window.__outbox.some((m) => m.type === "ready"), { timeout: 15000 }).catch(() => {});
  await page.evaluate((s) => window.postMessage({ type: "state", agents: s.agents, rooms: s.rooms, boards: s.boards }, "*"), c);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForFunction((exp) => {
    const k = window.DevTowerCrew && window.DevTowerCrew._instance;
    if (!k) return false;
    const ts = [...k.toons.values()];
    return ts.length >= exp && ts.every((t) => !t.entering && Math.abs(t.targetX - t.x) <= 1) && [...k.rooms.values()].every((r) => r.built >= 0.99);
  }, c.agents.length, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => window.DevTowerCrew.clearFocus());
  await sleep(1600);

  async function shot(name, preset, hud) {
    await page.evaluate(([p, h]) => { window.DevTowerCrew.setQuality(p); window.DevTowerCrew.setPerfHud(!!h); }, [preset, hud]);
    await sleep(900); // let a couple of frames paint so the HUD has FPS samples
    await page.screenshot({ path: path.join(OUT, name) });
    console.log("wrote", path.relative(ROOT, path.join(OUT, name)));
  }
  await shot("scene-high.png", "high", false);
  await shot("scene-potato.png", "potato", false);
  await shot("scene-perfhud.png", "high", true);
  await page.evaluate(() => window.DevTowerCrew.setPerfHud(false));

  // Settings overlay: General tab (quality control) + Debug tab (perf overlay toggle)
  await page.evaluate(() => {
    window.postMessage({ type: "settings", caps: { github: { connected: false } }, scopeHelp: [] }, "*");
    window.postMessage({ type: "openSettings" }, "*");
  });
  await sleep(500);
  const card = page.locator(".settings-card");
  if (await card.count()) {
    await card.screenshot({ path: path.join(OUT, "settings-general.png") });
    console.log("wrote settings-general.png");
    for (const tab of await page.locator(".s-tab").all()) {
      const name = (await tab.getAttribute("data-tab")) || "tab";
      if (name === "debug") { await tab.click(); await sleep(250); await card.screenshot({ path: path.join(OUT, "settings-debug.png") }); console.log("wrote settings-debug.png"); }
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
