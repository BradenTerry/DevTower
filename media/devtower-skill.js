// DevTower PreToolUse hook (the Skill tool).
//
// Claude Code runs this right BEFORE a tool executes. Installed with a matcher
// for the Skill tool, so it fires the instant a session loads a skill (the Skill
// tool invocation; user-typed slash skills come through UserPromptSubmit). It
// drops a marker recording WHICH session just reached for a skill:
//   ~/.claude/devtower/skill/<session_id>.json = { cwd, ts, skill }
//
// DevTower never polls on a timer: it refreshes only when a hook marker lands
// (it watches the marker dirs). The Skill tool otherwise drops no marker, so the
// dev's "borrow a skill" animation (walk to the bookshelf, or pull out the phone
// in ebook mode) would not play until the NEXT incidental marker — typically the
// session going idle. This marker wakes a refresh immediately, so the animation
// fires when the skill actually loads. The skill NAME is still read from the
// transcript (the unified signal); this marker is the prompt to look.
//
// The event JSON arrives on stdin: { session_id, cwd, tool_name, tool_input, ... }.
// This must never throw in a way that breaks the host's hook pipeline.
const fs = require("fs");
const os = require("os");
const path = require("path");

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  try {
    const ev = JSON.parse(data || "{}");
    const tool = String(ev.tool_name || "");
    if (tool && tool !== "Skill") return; // installed with a matcher, but guard anyway
    const id = String(ev.session_id || "");
    // session ids are uuids; refuse anything that could escape the dir
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    const skill = String((ev.tool_input && ev.tool_input.skill) || "");
    const dir = path.join(os.homedir(), ".claude", "devtower", "skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, id + ".json"),
      JSON.stringify({ cwd: String(ev.cwd || ""), ts: Date.now(), skill })
    );
  } catch {
    /* swallow: a broken hook must not disrupt Claude Code */
  }
});
