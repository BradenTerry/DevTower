// One-off: focus an agent, screenshot the canvas with culling OFF then ON, so the
// over-cull band can be eyeballed. node screenshots/diffshot.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const OUT = path.join(__dirname, "out", "diff");
const HTML = path.join(__dirname, ".diffshot.html");
const mediaUrl = (p) => pathToFileURL(path.join(MEDIA, p)).href;
function harnessHtml() {
  const src = fs.readFileSync(path.join(ROOT, "src", "consolePanel.ts"), "utf8");
  const body = src.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "").replace(/\$\{[^}]*\}/g, "");
  return `<!DOCTYPE html><html><head><link href="${mediaUrl("console.css")}" rel="stylesheet" /></head><body data-theme="dark">${body}
<script>window.__outbox=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__outbox.push(m),getState:()=>0,setState:()=>{}});</script>
<script src="${mediaUrl("crew.js")}"></script><script src="${mediaUrl("console.js")}"></script></body></html>`;
}
const board = (o) => ({ branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [], unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0, committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true, ...o });
function campus() { const rooms = [], agents = [], boards = {}; let aid = 0; for (let b = 0; b < 12; b++) { const w = []; for (let f = 0; f < 3; f++) { const wt = `/wt/${b}/${f}`; w.push({ path: wt, branch: f ? `feat/b${b}-${f}` : "main" }); boards[wt] = board({ branch: f ? `feat/b${b}-${f}` : "main", modified: f % 3, ahead: f % 2 }); aid++; agents.push({ id: `a${aid}`, name: `Dev${aid}`, state: "active", repo: `PROJ${b}`, model: "opus-4.8", worktree: wt, branch: f ? `feat/b${b}-${f}` : "main", skills: [], contextTokens: 50000, elapsed: "5m" }); } rooms.push({ name: `PROJ${b}`, path: `/wt/${b}/0`, floor: 0, col: b, worktrees: w }); } return { agents, rooms, boards }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  const c = campus();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => window.__outbox?.some((m) => m.type === "ready"), { timeout: 15000 });
  await page.evaluate((s) => window.postMessage({ type: "state", agents: s.agents, rooms: s.rooms, boards: s.boards }, "*"), c);
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForFunction((e) => { const k = window.DevTowerCrew?._instance; return k && [...k.toons.values()].length >= e && [...k.rooms.values()].every((r) => r.built >= 0.99); }, c.agents.length, { timeout: 30000 });
  await page.evaluate((id) => window.postMessage({ type: "focusAgent", id }, "*"), c.agents[6].id);
  // settle the camera like the test (wait for zoom to stabilize), not a fixed sleep
  await page.evaluate(() => { window.__z = -1; });
  await page.waitForFunction(() => { const k = window.DevTowerCrew._instance; const z = k.cam.z, p = window.__z; window.__z = z; return Math.abs(z - p) < 0.002; }, { timeout: 8000, polling: 200 }).catch(() => {});
  // Paint differing pixels bright red onto the cull-off frame so the missing
  // element's shape is obvious, and write it back to the canvas for a screenshot.
  const info = await page.evaluate(() => {
    const k = window.DevTowerCrew._instance;
    const cv = document.getElementById("crew-canvas");
    const g = cv.getContext("2d", { willReadFrequently: true });
    k.stop(); const r = Math.random; Math.random = () => 0.5;
    k.setCull(false); k.draw();
    const off = g.getImageData(0, 0, cv.width, cv.height);
    k.setCull(true); k.draw();
    const on = g.getImageData(0, 0, cv.width, cv.height);
    Math.random = r;
    const out = g.createImageData(cv.width, cv.height);
    let d = 0, minY = 1e9, maxY = -1e9; const third = [0, 0, 0]; const W = cv.width;
    for (let i = 0; i < off.data.length; i += 4) {
      const diff = off.data[i] !== on.data[i] || off.data[i + 1] !== on.data[i + 1] || off.data[i + 2] !== on.data[i + 2];
      if (diff) { out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 255; d++; const px = (i / 4) % W, y = Math.floor((i / 4) / W); if (y < minY) minY = y; if (y > maxY) maxY = y; third[Math.min(2, Math.floor((px / W) * 3))]++; }
      else { out.data[i] = off.data[i] * 0.45; out.data[i + 1] = off.data[i + 1] * 0.45; out.data[i + 2] = off.data[i + 2] * 0.45; out.data[i + 3] = 255; }
    }
    g.putImageData(out, 0, 0);
    return { d, minY, maxY, h: cv.height, z: k.cam.z, third };
  });
  console.log("diff", info.d, "px, y", info.minY, "-", info.maxY, "of", info.h, "(dpr2); z", info.z.toFixed(2), "thirds(L/M/R)", info.third.join("/"));
  const cull = await page.evaluate(() => {
    const k = window.DevTowerCrew._instance;
    const vw = k.visibleWorld();
    const rooms = [...k.rooms.values()].map((r) => ({ name: r.name, vis: k.visRooms.has(r.name), x0: Math.round(r.x0), baseY: Math.round(r.baseY) }));
    return { vw: { x0: Math.round(vw.x0), x1: Math.round(vw.x1), y0: Math.round(vw.y0), y1: Math.round(vw.y1) }, drawn: rooms.filter((r) => r.vis).map((r) => r.name), camy: Math.round(k.cam.y) };
  });
  console.log("vw", JSON.stringify(cull.vw), "cam.y", cull.camy, "\nrooms drawn:", cull.drawn.join(", "));
  await page.screenshot({ path: path.join(OUT, "diff-highlight.png") });
  await browser.close();
  console.log("wrote", path.relative(ROOT, OUT), "diff-highlight.png (red = culled-away pixels)");
})().catch((e) => { console.error(e); process.exit(1); });
