// Capture the Settings > Debug "External calls" table with a mock tally so the new
// UI can be eyeballed. node screenshots/execstats-shot.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const OUT = path.join(__dirname, "out", "quality");
const HTML = path.join(__dirname, ".execstats.html");
const mediaUrl = (p) => pathToFileURL(path.join(MEDIA, p)).href;
function harnessHtml() {
  const src = fs.readFileSync(path.join(ROOT, "src", "consolePanel.ts"), "utf8");
  const body = src.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "").replace(/\$\{[^}]*\}/g, "");
  return `<!DOCTYPE html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;600;700&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
<link href="${mediaUrl("console.css")}" rel="stylesheet" /></head><body data-theme="dark">${body}
<script>window.__outbox=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__outbox.push(m),getState:()=>0,setState:()=>{}});</script>
<script src="${mediaUrl("crew.js")}"></script><script src="${mediaUrl("console.js")}"></script></body></html>`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mockStats = {
  sinceMs: 64000, total: 312,
  rows: [
    { cmd: "git status", count: 96, avgMs: 22, maxMs: 140, totalMs: 2112, errors: 0 },
    { cmd: "git rev-list", count: 84, avgMs: 11, maxMs: 60, totalMs: 924, errors: 0 },
    { cmd: "git diff", count: 60, avgMs: 18, maxMs: 90, totalMs: 1080, errors: 0 },
    { cmd: "git log", count: 24, avgMs: 14, maxMs: 70, totalMs: 336, errors: 0 },
    { cmd: "powershell", count: 8, avgMs: 410, maxMs: 720, totalMs: 3280, errors: 0 },
    { cmd: "gh api", count: 18, avgMs: 190, maxMs: 540, totalMs: 3420, errors: 2 },
    { cmd: "launch", count: 6, avgMs: 0, maxMs: 0, totalMs: 0, errors: 0 },
    { cmd: "lsof", count: 8, avgMs: 35, maxMs: 80, totalMs: 280, errors: 0 },
  ],
};
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => window.__outbox?.some((m) => m.type === "ready"), { timeout: 15000 });
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(() => {
    window.postMessage({ type: "settings", caps: { github: { connected: false } }, scopeHelp: [] }, "*");
    window.postMessage({ type: "openSettings", tab: "debug" }, "*");
  });
  await sleep(500);
  // click the Debug tab to ensure its pane (and #s-exec) is mounted, then inject the tally
  const tab = page.locator('.s-tab[data-tab="debug"]');
  if (await tab.count()) { await tab.click(); await sleep(250); }
  await page.evaluate((stats) => window.postMessage({ type: "execStats", stats }, "*"), mockStats);
  await sleep(400);
  const card = page.locator(".settings-card");
  await card.screenshot({ path: path.join(OUT, "settings-execcalls.png") });
  await browser.close();
  console.log("wrote", path.relative(ROOT, path.join(OUT, "settings-execcalls.png")));
})().catch((e) => { console.error(e); process.exit(1); });
