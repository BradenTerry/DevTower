// Capture for the marketplace "ethernet" GIF (media/agent-stream.gif): an agent
// runs a full git turn at its desk and every step streams up the network cable
// to the room board, where the matching column updates live. The sequence walks
// the whole flow so the marketplace shows all the interactions:
//   edit a file → stage → commit → push → open a PR
// Each local change (working tree / staged / commit / unpushed) fires a cable
// beam (emitPacket) carrying the new snapshot; the PR opening is an external
// event, so it flashes the PR cell without a beam.
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
// One worktree walking the full git turn. Each constant below is the board as it
// looks after the labelled step; the harness posts them in order and the canvas
// beams the delta up the cable.
const branch = { branch: "feat/diff-viewer", base: "main", behind: 0 };
// 0) clean tree on a fresh branch, no PR yet
const clean = { ...branch, modified: 0, modifiedFiles: [], unstagedAdd: 0, unstagedDel: 0, staged: 0, stagedFiles: [], stagedAdd: 0, stagedDel: 0, ahead: 0, unpushed: 0, committedAdd: 0, committedDel: 0, commits: [], prReady: true };
// 1) edit a file → UNSTAGED appears
const edit1 = { ...clean, modified: 1, unstagedAdd: 14, unstagedDel: 3 };
// 2) git add → the churn moves UNSTAGED → STAGED
const staged = { ...clean, modified: 0, staged: 1, stagedAdd: 14, stagedDel: 3 };
// 3) git commit → STAGED clears, COMMITS gains one ahead + unpushed
const committed = { ...clean, ahead: 1, unpushed: 1, committedAdd: 14, committedDel: 3, commits: [{ sha: "c1", subject: "Wire diff viewer into panel" }] };
// 4) git push → unpushed drains to 0
const pushed = { ...committed, unpushed: 0 };
// 5a) open a PR → board shows the "checking…" spinner first
const prChecking = { ...pushed, prReady: false };
// 5b) the PR lands on the board with its checks/review
const prOpen = { ...pushed, pr: { number: 142, title: "Live diff viewer panel", url: "https://github.com/acme/x/pull/142", draft: false, checks: "pass", checksPass: 5, checksFailed: 0, checksRunning: 0, checksTotal: 5, review: "approved", approvals: 2, changesRequested: 0, reviewersPending: 0, comments: 1 } };

test("capture: agent-stream", async ({ page }) => {
  test.setTimeout(120_000); // the full git-turn capture runs ~160 frames
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.writeFileSync(HTML, harnessHtml(), "utf8");
  page.on("pageerror", (e) => console.error("[agent-stream] page error:", e.message));
  await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray((window as any).__outbox)
    && (window as any).__outbox.some((m: any) => m.type === "ready"));

  await page.evaluate((d) => {
    window.postMessage({ type: "config", eco: false }, "*"); // eco off so the cable beam animates
    window.postMessage({ type: "state", agents: [d.agent], rooms: [d.room], boards: { "/repo": d.clean } }, "*");
    window.postMessage({ type: "prs", crew: [], review: [], connected: true }, "*");
  }, { agent, room, clean });
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
  // capture `frames` screenshots, ~33ms apart, while the sim keeps animating
  const beat = async (frames: number, wait = 33) => { for (let i = 0; i < frames; i++) { await shot(); await page.waitForTimeout(wait); } };
  const post = (board: any) => page.evaluate((d) => window.postMessage({ type: "state", agents: [d.agent], rooms: [d.room], boards: { "/repo": d.board } }, "*"), { agent, room, board });

  await beat(6, 40);                 // a beat at rest on the clean tree
  await post(edit1);     await beat(34); // edit a file       → UNSTAGED beam
  await post(staged);    await beat(32); // git add           → UNSTAGED → STAGED
  await post(committed); await beat(34); // git commit        → STAGED → COMMITS
  await post(pushed);    await beat(32); // git push          → unpushed drains
  await post(prChecking); await beat(16); // open PR          → "checking…" spinner
  await post(prOpen);    await beat(30); // PR lands on the board
  await beat(6, 40);                 // settle

  console.log(`wrote ${f} frames to ${FRAMES}`);
});
