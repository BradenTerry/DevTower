// Capture a dev leaving (and entering) through the door, as a GIF, to validate
// the door-open + wall-occlusion animation. Run after `npm run build`.
//   TAG=before node demo/shoot-door.mjs
//   TAG=after  node demo/shoot-door.mjs
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { readdirSync, rmSync, mkdirSync } from "fs";

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { console.error("need playwright"); process.exit(1); }

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlUrl = "file://" + join(__dirname, "harness.html");
const tag = process.env.TAG || "after";
const frameDir = join(__dirname, `frames-${tag}`);
rmSync(frameDir, { recursive: true, force: true });
mkdirSync(frameDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 3 });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text()); });
await page.goto(htmlUrl, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.DevTowerCrew);

// mount + two devs in one ground-floor room and one upper-floor room
await page.evaluate(() => {
  const wrap = document.getElementById("crew-wrap");
  const canvas = document.getElementById("crew-canvas");
  window.DevTowerCrew.mount(wrap, canvas);
  const REPOS = "/repos";
  window.__rooms = [{ name: "demo", path: REPOS + "/demo", floor: 0, col: 0,
    worktrees: [
      { path: REPOS + "/demo", branch: "main" },
      { path: REPOS + "/demo-2", branch: "feat/door" },
    ] }];
  const blank = (branch) => ({ branch, base: "main", modified: 0, staged: 0, modifiedFiles: [],
    stagedFiles: [], unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0,
    committedAdd: 0, committedDel: 0, ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true });
  window.__boards = { [REPOS + "/demo"]: blank("main"), [REPOS + "/demo-2"]: blank("feat/door") };
  window.__agents = [
    { id: "ground", name: "Ada", state: "active", repo: "demo", model: "opus",
      worktree: REPOS + "/demo", branch: "main", skills: [] },
    { id: "upper", name: "Lee", state: "active", repo: "demo", model: "opus",
      worktree: REPOS + "/demo-2", branch: "feat/door", skills: [] },
  ];
  window.DevTowerCrew.setRooms(window.__rooms);
  window.DevTowerCrew.setBoards(window.__boards);
  window.DevTowerCrew.setAgents(window.__agents);
});

// let both devs walk in and settle
await page.waitForTimeout(15000);

// frame the ground-floor room's right door
await page.evaluate(() => {
  const inst = window.DevTowerCrew._instance;
  inst.zoomMul = 4.2;
  const tn = inst.toons.get("ground");
  inst.focus.x = tn.x0 + 252; // the right wall / door
  inst.focus.y = tn.base - 18;
  inst.focusAgentId = null;
});
await page.waitForTimeout(800);

// compute a clip box centered on the door, in device pixels
const clip = await page.evaluate(() => {
  const inst = window.DevTowerCrew._instance;
  const tn = inst.toons.get("ground");
  const s = inst.screenOf(tn.x0 + 250, tn.base - 18);
  const dpr = Math.min(window.devicePixelRatio, 2);
  return { x: s.x - 150, y: s.y - 150, width: 300, height: 300 };
});

// trigger the ground dev leaving: re-send agents WITHOUT it
await page.evaluate(() => {
  window.DevTowerCrew.setAgents(window.__agents.filter((a) => a.id !== "ground"));
});

// record ~6s of frames at ~20fps
const N = 120;
for (let i = 0; i < N; i++) {
  await page.screenshot({ path: join(frameDir, `f${String(i).padStart(3, "0")}.png`), clip });
  await page.waitForTimeout(50);
}

await browser.close();

// assemble a gif with ffmpeg
const out = join(__dirname, `door-${tag}.gif`);
const r = spawnSync("ffmpeg", ["-y", "-framerate", "20", "-i", join(frameDir, "f%03d.png"),
  "-vf", "scale=420:-1:flags=lanczos", out], { stdio: "inherit" });
if (r.status === 0) { console.log("wrote", out); rmSync(frameDir, { recursive: true, force: true }); }
else console.log("ffmpeg failed; frames in", frameDir);
