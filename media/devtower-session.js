// DevTower SessionStart hook.
//
// Claude Code runs this on every `SessionStart` event, with a `source` telling
// us WHY the session started: "startup", "resume", "clear", or "compact". Two
// sources matter here:
//
// "clear" RETIRES the current session and mints a brand-new transcript with a
// new uuid and no link back to its predecessor, so DevTower would otherwise cull
// the dev (its old session vanished) and surface the new session as an unrelated
// stranger.
//
// "resume" reopens a PRE-EXISTING transcript (keeping its own uuid). When the
// operator spawns a dev — which launches `claude --session-id <launchId>` — and
// then picks a different session from Claude's resume picker, that resumed uuid
// is not the launch id the placeholder is waiting on, so the placeholder lingers
// AND the resumed session shows up as a stranger in its original worktree. We
// drop a "resume" marker so discovery can adopt it into the waiting placeholder.
//
// Both link back to the dev via the TERMINAL'S LAUNCH ID — the `--session-id
// <uuid>` the claude process was started with, which stays in its argv across
// every /clear or resume (the transcript uuid changes; the launch id does not).
// Recording it lets discovery rebind deterministically even when several live
// sessions share one cwd. We read it from the parent process's command line. See
// src/hooks.ts (readers/installer) and src/claude.ts (the binds). The markers go
// under ~/.claude/devtower/{succession,resume}/<new-or-resumed-uuid>.json.
//
// The event JSON arrives on stdin: { session_id, cwd, source, ... }. This must
// never throw in a way that breaks the host's hook pipeline.
const fs = require("fs");
const os = require("os");
const path = require("path");

// the launching claude process's --session-id (stable across /clear). The hook
// runs as a child of that process, so its parent's argv carries the flag. ""
// when the session wasn't started with --session-id or the lookup fails.
function launchId(ppid) {
  try {
    const { execFileSync } = require("child_process");
    const args = execFileSync("ps", ["-o", "args=", "-p", String(ppid)], { encoding: "utf8", timeout: 2000 });
    const m = /--session-id[= ]([0-9a-fA-F-]{36})/.exec(args);
    return m ? m[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  try {
    const ev = JSON.parse(data || "{}");
    const source = String(ev.source || "");
    // only /clear (mints a new uuid) and resume (reopens another session in a
    // DevTower terminal) need a marker; startup/compact have nothing to rebind.
    if (source !== "clear" && source !== "resume") return;
    const id = String(ev.session_id || "");
    // session ids are uuids; refuse anything that could escape the dir
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    const launch = launchId(process.ppid);
    // a resume marker is only meaningful when this terminal was launched by
    // DevTower (carries a --session-id) AND it reopened a DIFFERENT session than
    // the one we launched; otherwise the deterministic launch-id bind covers it.
    if (source === "resume" && (!launch || launch === id.toLowerCase())) return;
    const sub = source === "clear" ? "succession" : "resume";
    const dir = path.join(os.homedir(), ".claude", "devtower", sub);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, id + ".json"),
      JSON.stringify({ cwd: String(ev.cwd || ""), source, ts: Date.now(), launchId: launch })
    );
  } catch {
    /* swallow: a broken hook must not disrupt Claude Code */
  }
});
