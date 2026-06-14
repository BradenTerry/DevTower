import { fileURLToPath } from "url";
import { dirname, join } from "path";

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { console.error("need playwright"); process.exit(1); }

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlUrl = "file://" + join(__dirname, "harness.html");
const OUT = process.env.OUT_DIR || __dirname;
const tag = process.env.TAG || "after";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 3 });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(htmlUrl, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.DevTowerCrew);

// console.js doesn't mount cleanly in the bare harness, so mount the crew
// directly and push data through the exposed DevTowerCrew API.
await page.evaluate(() => {
  const wrap = document.getElementById("crew-wrap");
  const canvas = document.getElementById("crew-canvas");
  window.DevTowerCrew.mount(wrap, canvas);
  const REPOS = "/repos";
  const rooms = [{ name: "demo", path: REPOS + "/demo", floor: 0, col: 0,
    worktrees: [
      { path: REPOS + "/demo", branch: "feat/reader" },
      { path: REPOS + "/demo-2", branch: "feat/coffee" },
    ] }];
  const blank = (branch) => ({ branch, base: "main", modified: 0, staged: 0, modifiedFiles: [],
    stagedFiles: [], unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0,
    committedAdd: 0, committedDel: 0, ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true });
  const boards = { [REPOS + "/demo"]: blank("feat/reader"), [REPOS + "/demo-2"]: blank("feat/coffee") };
  const agents = [
    { id: "reader", name: "Ada", state: "active", repo: "demo", model: "opus",
      worktree: REPOS + "/demo", branch: "feat/reader", skills: ["rust"] },
    { id: "coffee", name: "Lee", state: "complete", repo: "demo", model: "opus",
      worktree: REPOS + "/demo-2", branch: "feat/coffee", skills: [] },
  ];
  window.DevTowerCrew.setRooms(rooms);
  window.DevTowerCrew.setBoards(boards);
  window.DevTowerCrew.setAgents(agents);
});

// let the devs walk in and settle
await page.waitForTimeout(14000);

async function shoot(id, name) {
  await page.evaluate((id) => {
    const inst = window.DevTowerCrew._instance;
    const tn = inst.toons.get(id);
    if (tn && id === "reader") { tn.booksInHand = 1; tn.booksShown = 0; } // force the reading pose
    inst.zoomMul = 2.4;
    inst.focusAgent(id, false);
    inst.panY = 22; // focusAgent frames the desk; pan up so the dev centers
  }, id);
  await page.waitForTimeout(1500);
  // project the dev's mid-body to screen and crop a tight square around it
  const c = await page.evaluate((id) => {
    const inst = window.DevTowerCrew._instance;
    const tn = inst.toons.get(id);
    return inst.screenOf(tn.x - 4, tn.base - 15);
  }, id);
  const half = 175;
  await page.screenshot({ path: join(OUT, `${name}-${tag}.png`),
    clip: { x: c.x - half, y: c.y - half, width: half * 2, height: half * 2 } });
}

await shoot("reader", "reading");
await shoot("coffee", "idle");

await browser.close();
console.log("done", tag);
