// DevTower SessionEnd hook.
//
// Claude Code runs this on every `SessionEnd` event, with a `reason` telling us
// WHY the session ended: "clear", "resume", "logout", "prompt_input_exit",
// "bypass_permissions_disabled", or "other". A genuine exit (you typed /exit,
// hit Ctrl-C, logged out, or the session otherwise terminated) is the case that
// matters: the claude process is gone. DevTower no longer scans running processes
// to notice this, so this hook is the authoritative "session left" signal.
//
// We drop an "ended" marker keyed by the exiting session's id (discovery matches
// it to the dev bound to that exact transcript and retires THAT dev) AND delete
// the session's "started" marker, removing it from DevTower's live registry. We
// skip the restart reasons ("clear" is handled by the SessionStart succession
// hook, "resume" keeps the dev) so only true terminations send the dev home. See
// src/hooks.ts (reader/installer) and src/claude.ts (the retire). We also record
// the terminal's launch id (its --session-id argv, stable across /clear) as a
// secondary match.
//
// The event JSON arrives on stdin: { session_id, cwd, reason, ... }. This must
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
    const reason = String(ev.reason || "");
    // restart reasons are NOT exits: "clear" mints a successor (handled by the
    // SessionStart hook) and "resume" continues the same dev. Everything else is
    // a genuine termination — send the dev home.
    if (reason === "clear" || reason === "resume") return;
    const id = String(ev.session_id || "");
    // session ids are uuids; refuse anything that could escape the dir
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    const base = path.join(os.homedir(), ".claude", "devtower");
    const dir = path.join(base, "ended");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, id + ".json"),
      JSON.stringify({ cwd: String(ev.cwd || ""), reason, ts: Date.now(), launchId: launchId(process.ppid) })
    );
    // the session is gone — remove its liveness marker so DevTower's live registry
    // (the `started` dir) reflects the exit immediately, even before discovery
    // consumes the `ended` marker to retire the bound dev.
    try { fs.unlinkSync(path.join(base, "started", id + ".json")); } catch {}
  } catch {
    /* swallow: a broken hook must not disrupt Claude Code */
  }
});
