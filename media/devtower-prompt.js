// DevTower UserPromptSubmit hook.
//
// Claude Code runs this the instant you submit a prompt to a session. It drops a
// liveness marker so the dev reads "active" immediately, instead of waiting for
// the transcript mtime to catch up (the model can think for a beat before it
// writes its first line). Reuses the same `active/` marker the resume hook writes,
// which discovery already folds into the session's activity time.
//   ~/.claude/devtower/active/<session_id>.json = { cwd, ts }
//
// The event JSON arrives on stdin: { session_id, cwd, prompt, ... }. This must
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
    const dir = path.join(os.homedir(), ".claude", "devtower", "active");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, id + ".json"),
      JSON.stringify({ cwd: String(ev.cwd || ""), ts: Date.now() })
    );
  } catch {
    /* swallow: a broken hook must not disrupt Claude Code */
  }
});
