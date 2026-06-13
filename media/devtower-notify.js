// DevTower Notification hook.
//
// Claude Code runs this on every `Notification` event — i.e. exactly when a
// session needs the user (awaiting tool permission, or idle waiting for input).
// It records that the session is parked by dropping a marker file the tower
// polls, so the agent's hand goes up reliably instead of being guessed from
// transcript text. See src/hooks.ts for the installer + reader.
//
// The event JSON arrives on stdin: { session_id, cwd, message, ... }. This must
// never throw in a way that breaks the host's hook pipeline.
const fs = require("fs");
const os = require("os");
const path = require("path");

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  try {
    const ev = JSON.parse(data || "{}");
    const id = String(ev.session_id || "");
    // session ids are uuids; refuse anything that could escape the dir
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    const dir = path.join(os.homedir(), ".claude", "devtower", "waiting");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, id + ".json"),
      JSON.stringify({ message: String(ev.message || ""), cwd: String(ev.cwd || ""), ts: Date.now() })
    );
  } catch {
    /* swallow: a broken hook must not disrupt Claude Code */
  }
});
