// Capture a dev ENTERING through the door as a GIF (companion to shoot-door.mjs).
//   node demo/shoot-door-enter.mjs   -> demo/door-enter.gif
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { rmSync, mkdirSync } from "fs";
const { chromium } = await import("playwright");
const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlUrl = "file://" + join(__dirname, "harness.html");
const frameDir = join(__dirname, "frames-enter");
rmSync(frameDir, { recursive: true, force: true }); mkdirSync(frameDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 3 });
await page.goto(htmlUrl, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.DevTowerCrew);
await page.evaluate(() => {
  window.DevTowerCrew.mount(document.getElementById("crew-wrap"), document.getElementById("crew-canvas"));
  const R = "/repos";
  const rooms = [{ name: "demo", path: R + "/demo", floor: 0, col: 0, worktrees: [{ path: R + "/demo", branch: "main" }] }];
  const blank = (b) => ({ branch: b, base: "main", modified: 0, staged: 0, modifiedFiles: [], stagedFiles: [],
    unstagedAdd: 0, unstagedDel: 0, stagedAdd: 0, stagedDel: 0, committedAdd: 0, committedDel: 0,
    ahead: 0, unpushed: 0, behind: 0, commits: [], prReady: true });
  window.DevTowerCrew.setRooms(rooms);
  window.DevTowerCrew.setBoards({ [R + "/demo"]: blank("main") });
  window.DevTowerCrew.setAgents([]); // building only — no crew yet
  window.__add = () => window.DevTowerCrew.setAgents([{ id: "ground", name: "Ada", state: "active",
    repo: "demo", model: "opus", worktree: R + "/demo", branch: "main", skills: [] }]);
});
await page.waitForTimeout(3500); // let the building rise
await page.evaluate(() => {
  const inst = window.DevTowerCrew._instance;
  inst.zoomMul = 4.2;
  inst.focus.x = -130 + 252; inst.focus.y = -18; inst.focusAgentId = null;
});
await page.waitForTimeout(500);
const c = await page.evaluate(() => window.DevTowerCrew._instance.screenOf(-130 + 250, -18));
const clip = { x: c.x - 150, y: c.y - 150, width: 300, height: 300 };
await page.evaluate(() => window.__add());
for (let i = 0; i < 90; i++) {
  await page.screenshot({ path: join(frameDir, `f${String(i).padStart(3, "0")}.png`), clip });
  await page.waitForTimeout(50);
}
await browser.close();
const out = join(__dirname, "door-enter.gif");
spawnSync("ffmpeg", ["-y", "-framerate", "20", "-i", join(frameDir, "f%03d.png"),
  "-vf", "scale=420:-1:flags=lanczos", out], { stdio: "inherit" });
rmSync(frameDir, { recursive: true, force: true });
console.log("wrote", out);
