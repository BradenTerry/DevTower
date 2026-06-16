// Launch the real DevTower webview bundle (media/crew.js + console.js) in a headed
// Chromium window and seed it with live agents so you can watch/interact. The book
// preference + skill bubbles are exactly what ship in the extension's panel.
//   node screenshots/run-app.js            # ebook mode
//   BOOKS=physical node screenshots/run-app.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

// build the same standalone HTML the screenshot harness uses: lift the <body> from
// consolePanel.ts, drop its nonce'd script tags, and add file:// includes for the
// real runtime bundles (media/crew.js + console.js + console.css).
const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const mediaUrl = (p) => pathToFileURL(path.join(MEDIA, p)).href;
function harnessHtml() {
  const src = fs.readFileSync(path.join(ROOT, "src", "consolePanel.ts"), "utf8");
  const m = src.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  if (!m) throw new Error("could not find <body> in consolePanel.ts");
  const body = m[1].replace(/<script[\s\S]*?<\/script>/g, "").replace(/\$\{[^}]*\}/g, "");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;600;700&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
<link href="${mediaUrl("console.css")}" rel="stylesheet" /><title>DevTower (dev run)</title></head>
<body data-theme="dark">${body}
<script>window.__outbox=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__outbox.push(m),getState:()=>undefined,setState:()=>{}});</script>
<script src="${mediaUrl("crew.js")}"></script>
<script src="${mediaUrl("console.js")}"></script>
</body></html>`;
}

const BOOKS = process.env.BOOKS === "physical" ? "physical" : "ebook";
const HTML = path.join(__dirname, ".harness.run.html");

const room = { name: "DevTower", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "main" }] };
const board = {
  branch: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
  unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0,
  committedDel: 0, base: "main", ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true,
};
const agent = (id, name, state, skills, clearedSession) => ({
  id, name, state, repo: "DevTower", model: "opus-4.8",
  worktree: "/repo", branch: "main", skills, clearedSession, contextTokens: 120000, elapsed: "12m",
});

(async () => {
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  const browser = await chromium.launch({ headless: false, args: ["--window-size=1200,820"] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray(window.__outbox)
    && window.__outbox.some((m) => m.type === "ready"));

  const send = (agents) => page.evaluate((s) =>
    window.postMessage({ type: "state", agents: s.agents, rooms: [s.room], boards: { "/repo": s.board } }, "*"),
    { agents, room, board });

  await page.evaluate((b) => window.postMessage({ type: "config", perf: "smooth", books: b }, "*"), BOOKS);
  await send([agent("cc-aaaa1111", "Atlas", "active", [])]);
  await page.evaluate(() => window.DevTowerCrew.focusIsland("DevTower"));

  console.log(`\nDevTower running in ${BOOKS} mode. Window is open — interact freely.`);
  console.log("Scripted demo will play borrow -> counter -> return; Ctrl+C to stop.\n");

  const sleep = (ms) => page.waitForTimeout(ms);
  // play the lifecycle on a loop so there's always something happening to watch
  /* eslint-disable no-constant-condition */
  while (true) {
    await send([agent("cc-aaaa1111", "Atlas", "active", [])]);
    await sleep(2500);
    await send([agent("cc-aaaa1111", "Atlas", "active", ["code-review", "release", "verify"])]);
    await sleep(4000);
    await send([agent("cc-aaaa1111", "Atlas", "idle", ["code-review", "release", "verify"])]);
    await sleep(3500);
    await send([agent("cc-aaaa1111", "Atlas", "active", [], "clr-" + Math.floor(Date.now() / 1000))]);
    await sleep(5000);
  }
})();
