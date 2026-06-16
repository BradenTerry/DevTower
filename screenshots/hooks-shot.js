// Capture the Settings > Hooks tab with the full hook set + event-type chips.
// node screenshots/hooks-shot.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const OUT = path.join(__dirname, "out", "quality");
const HTML = path.join(__dirname, ".hooks.html");
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
// mirrors listHooks() output
const hooks = [
  { id: "notify", event: "Notification", label: "Raised hand", installed: true, description: "Raises an agent's hand the instant Claude needs you (a permission prompt or a question)." },
  { id: "session", event: "SessionStart", label: "Keep dev on /clear", installed: true, description: "Keeps a dev in its place when you /clear its session, instead of a stranger appearing." },
  { id: "sessionEnd", event: "SessionEnd", label: "Leave on /exit", installed: false, description: "Sends a dev home the instant you /exit its session, even with several sessions in one folder." },
  { id: "prompt", event: "UserPromptSubmit", label: "Wake on prompt", installed: false, description: "Lights a dev up active the instant you send it a prompt, instead of waiting for its first transcript line." },
  { id: "edit", event: "PostToolUse", label: "Beam from the right dev", installed: true, description: "Streams the cable beam from the dev that actually edited a file. Git only sees that a worktree changed, not who changed it." },
];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => window.__outbox?.some((m) => m.type === "ready"), { timeout: 15000 });
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate((hk) => {
    window.postMessage({ type: "settings", caps: { github: { connected: false } }, scopeHelp: [] }, "*");
    window.postMessage({ type: "hooks", hooks: hk }, "*");
    window.postMessage({ type: "openSettings", tab: "hooks" }, "*");
  }, hooks);
  await sleep(500);
  const tab = page.locator('.s-tab[data-tab="hooks"]');
  if (await tab.count()) { await tab.click(); await sleep(250); }
  const card = page.locator(".settings-card");
  await card.screenshot({ path: path.join(OUT, "settings-hooks.png") });
  await browser.close();
  console.log("wrote", path.relative(ROOT, path.join(OUT, "settings-hooks.png")));
})().catch((e) => { console.error(e); process.exit(1); });
