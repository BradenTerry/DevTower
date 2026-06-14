// DevTower SessionStart hook.
//
// Claude Code runs this on every `SessionStart` event, with a `source` telling
// us WHY the session started: "startup", "resume", "clear", or "compact". Only
// "clear" matters here: it RETIRES the current session and mints a brand-new
// transcript with a new uuid and no link back to its predecessor, so DevTower
// would otherwise cull the dev (its old session vanished) and surface the new
// session as an unrelated stranger.
//
// To keep the dev in place across /clear we drop a "succession" marker keyed by
// the NEW session id. The link back to the dev is the TERMINAL'S LAUNCH ID — the
// `--session-id <uuid>` the claude process was started with, which stays in its
// argv across every /clear (the transcript uuid changes; the launch id does
// not). Recording it lets discovery rebind deterministically even when several
// live sessions share one cwd. We read it from the parent process's command
// line. See src/hooks.ts (reader/installer) and src/claude.ts (the bind).
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
    // /clear is the only source that mints a new uuid; resume/compact keep the
    // same session id (nothing to rebind) and startup is a genuinely new session.
    if (String(ev.source || "") !== "clear") return;
    const id = String(ev.session_id || "");
    // session ids are uuids; refuse anything that could escape the dir
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    const launch = launchId(process.ppid);
    const dir = path.join(os.homedir(), ".claude", "devtower", "succession");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, id + ".json"),
      JSON.stringify({ cwd: String(ev.cwd || ""), source: "clear", ts: Date.now(), launchId: launch })
    );
  } catch {
    /* swallow: a broken hook must not disrupt Claude Code */
  }
});
