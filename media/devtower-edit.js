// DevTower PostToolUse hook (file-editing tools).
//
// Claude Code runs this right after a tool returns. Installed with a matcher for
// the file-modifying tools (Write / Edit / MultiEdit / NotebookEdit), so it fires
// exactly when a session changes the working tree. It drops a marker recording
// WHICH session just edited:
//   ~/.claude/devtower/edited/<session_id>.json = { cwd, ts, tool }
//
// Git only tells DevTower that a worktree changed, not who changed it, so with
// several devs in one room the cable beam ("lightning") would fire from the wrong
// desk. This marker lets discovery attribute the change to the exact session, so
// the beam streams from the dev that actually made the edit.
//
// The event JSON arrives on stdin: { session_id, cwd, tool_name, ... }. This must
// never throw in a way that breaks the host's hook pipeline.
const fs = require("fs");
const os = require("os");
const path = require("path");

// File-modifying tools, in case the hook is installed without a matcher (then it
// fires for every tool and we filter here).
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  try {
    const ev = JSON.parse(data || "{}");
    const tool = String(ev.tool_name || "");
    if (tool && !EDIT_TOOLS.has(tool)) return; // ignore reads/searches/bash
    const id = String(ev.session_id || "");
    // session ids are uuids; refuse anything that could escape the dir
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    const dir = path.join(os.homedir(), ".claude", "devtower", "edited");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, id + ".json"),
      JSON.stringify({ cwd: String(ev.cwd || ""), ts: Date.now(), tool })
    );
  } catch {
    /* swallow: a broken hook must not disrupt Claude Code */
  }
});
