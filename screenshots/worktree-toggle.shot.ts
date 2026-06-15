// Before/after for the "Exclude Agent Worktrees" SCM title-bar toggle.
//
// This control lives in VS Code's NATIVE Source Control panel, not the DevTower
// canvas, so the regular webview harness can't render it. Instead we render a
// faithful HTML mockup of the Source Control panel in the same headless Chromium
// the other shots use. These are ILLUSTRATIVE mockups for the PR body, not live
// captures of the running extension.
//
// Run: npm run screenshots -- -g worktree-toggle
import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

const OUT = path.join(__dirname, "..", "docs", "screenshots", "worktree-toggle");
const HTML = path.join(__dirname, ".scm-mock.html");

// repos VS Code's built-in Git auto-opens: our own provider, the real repo, and
// one section per agent worktree under .claude/worktrees/ (the clutter).
const WORKTREES = [
  { name: "mellow-rolling-lynx", branch: "devtower/mellow-rolling-lynx", count: 2 },
  { name: "swift-gliding-heron", branch: "devtower/swift-gliding-heron", count: 4 },
  { name: "brave-dancing-falcon", branch: "devtower/brave-dancing-falcon", count: 1 },
  { name: "calm-running-otter", branch: "devtower/calm-running-otter", count: 7 },
  { name: "eager-soaring-comet", branch: "devtower/eager-soaring-comet", count: 3 },
];

// tree-in-the-ground (worktrees shown) and a slashed tree (worktrees excluded) —
// these mirror media/tree-*.svg, the actual command icons.
const TREE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><g fill="currentColor"><circle cx="8" cy="5" r="3.4"/><circle cx="5.6" cy="6.6" r="2.5"/><circle cx="10.4" cy="6.6" r="2.5"/><rect x="7.2" y="7.5" width="1.6" height="5.2"/></g><path d="M2.6 13.2H13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const TREE_SLASH = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><mask id="c"><rect width="16" height="16" fill="#fff"/><path d="M3 13L13 3" stroke="#000" stroke-width="2.8" stroke-linecap="round"/></mask><g mask="url(#c)"><g fill="currentColor"><circle cx="8" cy="5" r="3.4"/><circle cx="5.6" cy="6.6" r="2.5"/><circle cx="10.4" cy="6.6" r="2.5"/><rect x="7.2" y="7.5" width="1.6" height="5.2"/></g><path d="M2.6 13.2H13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></g><path d="M3 13L13 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const CHECK = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const REFRESH = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12.5 6A5 5 0 1 0 13 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M12.7 3v3h-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function section(name: string, sub: string, count: number, opts: { actions?: string; muted?: boolean } = {}): string {
  return `
  <div class="prov${opts.muted ? " muted" : ""}">
    <div class="prov-head">
      <span class="chev">⌄</span>
      <span class="prov-name">${name}</span>
      <span class="prov-sub">${sub}</span>
      <span class="spacer"></span>
      ${opts.actions ?? ""}
      <span class="badge">${count}</span>
    </div>
  </div>`;
}

function scmHtml(state: "before" | "after"): string {
  const filtering = state === "after";
  // the toggle sits in the DevTower Changes title actions
  const dtActions = `
    <span class="act">${CHECK}</span>
    <span class="act">${REFRESH}</span>
    <span class="act tog${filtering ? " on" : ""}" title="${filtering ? "Include Agent Worktrees in Source Control" : "Exclude Agent Worktrees from Source Control"}">${filtering ? TREE_SLASH : TREE}</span>`;

  const worktreeSections = filtering
    ? "" // toggle on: every agent worktree repo is hidden
    : WORKTREES.map((w) => section(w.name, w.branch, w.count, { muted: true })).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  :root{
    --bg:#1e1e1e; --fg:#cccccc; --muted:#8a8a8a; --hdr:#bbbbbb;
    --border:#2b2b2b; --badge:#4d4d4d; --accent:#0e639c; --accentfg:#ffffff;
    --hover:#2a2d2e;
  }
  *{box-sizing:border-box;}
  body{margin:0;background:#181818;font-family:-apple-system,"Segoe UI",system-ui,sans-serif;}
  .panel{width:460px;background:var(--bg);color:var(--fg);border:1px solid var(--border);}
  .view-title{display:flex;align-items:center;height:35px;padding:0 8px 0 14px;
    font-size:11px;letter-spacing:.08em;color:var(--hdr);text-transform:uppercase;}
  .view-title .spacer{flex:1;}
  .act{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
    color:#c5c5c5;border-radius:5px;cursor:pointer;}
  .act.tog.on{color:var(--accent);background:rgba(14,99,156,.18);}
  .prov{border-top:1px solid var(--border);}
  .prov-head{display:flex;align-items:center;height:30px;padding:0 8px 0 8px;gap:6px;font-size:13px;}
  .prov-head .chev{color:#9a9a9a;font-size:11px;width:12px;}
  .prov-name{font-weight:600;color:#e6e6e6;white-space:nowrap;}
  .prov-sub{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .prov-head .spacer{flex:1;}
  .badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--badge);
    color:#e6e6e6;font-size:11px;line-height:18px;text-align:center;}
  .prov.muted .prov-name{color:#c8c8c8;font-weight:500;}
  .prov.dt{background:rgba(255,255,255,.015);}
  .note{padding:9px 12px;color:var(--muted);font-size:11.5px;border-top:1px solid var(--border);
    display:flex;align-items:center;gap:7px;}
  .note .dot{color:var(--accent);}
</style></head><body>
  <div class="panel">
    <div class="view-title"><span>Source Control</span><span class="spacer"></span></div>
    <div class="prov dt">
      <div class="prov-head">
        <span class="chev">⌄</span>
        <span class="prov-name">DevTower Changes</span>
        <span class="prov-sub">mellow-rolling-lynx</span>
        <span class="spacer"></span>
        ${dtActions}
        <span class="badge">2</span>
      </div>
    </div>
    ${section("DevTower", "main", 3)}
    ${worktreeSections}
    ${filtering
      ? `<div class="note"><span class="dot">●</span> Agent worktrees excluded. Toggle the tree to show them.</div>`
      : `<div class="note"><span class="dot">●</span> ${WORKTREES.length} agent worktrees auto-opened by built-in Git.</div>`}
  </div>
</body></html>`;
}

for (const state of ["before", "after"] as const) {
  test(`worktree-toggle: ${state}`, async ({ page }) => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(HTML, scmHtml(state), "utf8");
    await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
    await page.evaluate(() => (document as any).fonts?.ready);
    await page.waitForTimeout(200);
    const panel = page.locator(".panel");
    await panel.screenshot({ path: path.join(OUT, `${state}.png`) });
    console.log(`wrote ${state}.png`);
  });
}
