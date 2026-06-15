// Capture for the marketplace "ethernet" GIF (media/agent-stream.gif): an agent
// edits its working tree and the change streams up the network cable to the
// room board, where the UNSTAGED column updates live. Frames a single room,
// settles the dev at its desk, then pushes a board update whose unstaged counts
// differ — which fires a cable beam (emitPacket) carrying the new snapshot.
//
// Run, then assemble the GIF:
//   npm run screenshots -- -g agent-stream
//   ffmpeg -y -framerate 25 -i screenshots/out/agentstream/frame-%03d.png \
//     -vf "scale=760:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
//     media/agent-stream.gif
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { harnessHtml } from "./harness";

const OUT = path.join(__dirname, "out");
const FRAMES = path.join(OUT, "agentstream");
const HTML = path.join(__dirname, ".harness.html");

const room = { name: "ATLAS-WEB", path: "/repo", floor: 0, col: 0, worktrees: [{ path: "/repo", branch: "feat/diff-viewer" }] };
const agent = { id: "a1", name: "Nova", state: "active", repo: "ATLAS-WEB", model: "opus-4.8", worktree: "/repo", branch: "feat/diff-viewer", skills: ["code-review"], contextTokens: 96_000, elapsed: "18m" };
// shared board fields; only the unstaged columns change between the two posts.
const base = {
  branch: "feat/diff-viewer", base: "main",
  staged: 3, stagedFiles: [], stagedAdd: 120, stagedDel: 18,
  ahead: 4, unpushed: 0, behind: 0, committedAdd: 540, committedDel: 96,
  commits: [
    { sha: "c4", subject: "Wire diff viewer into panel" },
    { sha: "c3", subject: "Render hunks with line stats" },
    { sha: "c2", subject: "Parse unified diff" },
    { sha: "c1", subject: "Scaffold diff viewer" },
  ],
  prReady: true,
  pr: { number: 142, title: "Live diff viewer panel", url: "https://github.com/acme/x/pull/142", draft: false, checks: "pass", checksPass: 5, checksFailed: 0, checksRunning: 0, checksTotal: 5, review: "approved", approvals: 2, changesRequested: 0, reviewersPending: 0, comments: 1 },
};
const before = { ...base, modified: 0, modifiedFiles: [], unstagedAdd: 0, unstagedDel: 0 };
const after = { ...base, modified: 2, modifiedFiles: [], unstagedAdd: 18, unstagedDel: 4 };

test("capture: agent-stream", async ({ page }) => {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[agent-stream] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((d) => {
    window.postMessage({ type: "config", eco: false }, "*"); // eco off so the cable beam animates
    window.postMessage({ type: "state", agents: [d.agent], rooms: [d.room], boards: { "/repo": d.before } }, "*");
    window.postMessage({ type: "prs", crew: [], review: [], connected: true }, "*");
  }, { agent, room, before });
  await page.evaluate(() => (document as any).fonts?.ready);

  // frame the room (desk + cable + board all in view) and wait for Nova to sit
  await page.evaluate(() => (window as any).DevTowerCrew.focusIsland("ATLAS-WEB"));
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    if (!c) return false;
    const ts = [...c.toons.values()] as any[];
    return ts.length >= 1 && ts.every((t) => t.sitting && !t.entering);
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => {
    const c = (window as any).DevTowerCrew?._instance;
    const z = c.cam.z, prev = (window as any).__z; (window as any).__z = z;
    return prev !== undefined && Math.abs(z - prev) < 0.002;
  }, { timeout: 8000, polling: 200 }).catch(() => {});
  await page.waitForTimeout(400);

  let f = 0;
  const shot = async () => page.screenshot({ path: path.join(FRAMES, `frame-${String(f++).padStart(3, "0")}.png`) });

  for (let i = 0; i < 5; i++) { await shot(); await page.waitForTimeout(40); } // a beat at rest
  // the agent edits: push the changed board → fires the cable beam carrying it
  await page.evaluate((d) => window.postMessage({ type: "state", agents: [d.agent], rooms: [d.room], boards: { "/repo": d.after } }, "*"), { agent, room, after });
  for (let i = 0; i < 44; i++) { await shot(); await page.waitForTimeout(33); } // beam travels + UNSTAGED flips
  for (let i = 0; i < 6; i++) { await shot(); await page.waitForTimeout(40); } // settle

  console.log(`wrote ${f} frames to ${FRAMES}`);
});
