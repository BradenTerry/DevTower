// DevTower SessionStart hook.
//
// Claude Code runs this on every `SessionStart` event, with a `source` telling
// us WHY the session started: "startup", "resume", "clear", or "compact".
//
// EVERY source drops a `started/<uuid>.json` marker — DevTower's registry of live
// sessions, which is what replaces the old running-process scan: a session counts
// as live from this marker until its SessionEnd marker removes it (or a /clear
// successor under the same launch id supersedes it). Two sources need extra
// markers on top:
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
    const id = String(ev.session_id || "");
    // session ids are uuids; refuse anything that could escape the dir
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    const cwd = String(ev.cwd || "");
    const write = (sub, body) => {
      const dir = path.join(os.homedir(), ".claude", "devtower", sub);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(body));
    };
    const launch = launchId(process.ppid);
    // EVERY SessionStart marks this session LIVE. DevTower's discovery treats the
    // `started` dir as the registry of running sessions — this is what replaces the
    // old `ps`/`lsof`/PowerShell running-process scan. The marker lives until the
    // SessionEnd hook removes it (genuine exit) or a /clear successor under the same
    // launch id supersedes it. `launchId` (the terminal's stable `--session-id`)
    // ties a /clear or resume-picker successor back to its predecessor.
    write("started", { cwd, source, ts: Date.now(), launchId: launch });
    // EVERY resume also drops a liveness marker: reopening a session does not write
    // to the transcript until the first prompt, so without this a just-resumed dev
    // keeps its stale mtime and reads idle even while you are reading/typing.
    if (source === "resume") write("active", { cwd, ts: Date.now() });
    if (source === "clear") {
      // /clear retires this uuid and mints a successor; link them via launch id.
      write("succession", { cwd, source, ts: Date.now(), launchId: launch });
    } else if (source === "resume" && launch && launch !== id.toLowerCase()) {
      // narrow redirect: a DevTower-launched terminal reopened a DIFFERENT session
      // than the one we launched, so the placeholder waiting on `launch` needs to
      // be pointed at this resumed uuid. (Same-session / non-DevTower resumes are
      // covered by the deterministic launch-id bind and the active marker above.)
      write("resume", { cwd, source, ts: Date.now(), launchId: launch });
    }
  } catch {
    /* swallow: a broken hook must not disrupt Claude Code */
  }
});
