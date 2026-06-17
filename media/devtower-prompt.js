// DevTower UserPromptSubmit hook.
//
// Two jobs, both fired the instant you submit a prompt to a session:
//
// 1) Liveness. Drops a marker so the dev reads "active" immediately, instead of
//    waiting for the transcript mtime to catch up (the model can think for a beat
//    before it writes its first line). Reuses the same `active/` marker the resume
//    hook writes, which discovery already folds into the session's activity time.
//      ~/.claude/devtower/active/<session_id>.json = { cwd, ts }
//
// 2) Control commands. If the prompt is a DevTower control command — `/rename
//    <name>` or `/color <value>` — drop a command marker for discovery to apply
//    (rename the dev + its console, or recolour its toon's shirt) and BLOCK the
//    prompt (exit 2) so the command never reaches the model as a useless turn.
//      ~/.claude/devtower/command/<session_id>.json = { cwd, ts, cmd, arg }
//
// The event JSON arrives on stdin: { session_id, cwd, prompt, ... }. This must
// never throw in a way that breaks the host's hook pipeline.
const fs = require("fs");
const os = require("os");
const path = require("path");

const base = path.join(os.homedir(), ".claude", "devtower");

function write(sub, id, data) {
  const dir = path.join(base, sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(data));
}

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  try {
    const ev = JSON.parse(data || "{}");
    const id = String(ev.session_id || "");
    // session ids are uuids; refuse anything that could escape the dir
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    const cwd = String(ev.cwd || "");
    const prompt = String(ev.prompt || "");

    // a DevTower control command: capture it and block the prompt
    const m = /^\/(rename|color)\b[ \t]*(.*)$/i.exec(prompt.trim());
    if (m) {
      const cmd = m[1].toLowerCase();
      const arg = m[2].trim();
      write("command", id, { cwd, ts: Date.now(), cmd, arg });
      // exit 2 erases the prompt and shows stderr to the operator (their feedback)
      const msg = arg
        ? cmd === "rename"
          ? `DevTower: renaming this dev to "${arg}".`
          : `DevTower: setting this dev's shirt to "${arg}".`
        : `DevTower: usage — /${cmd} ${cmd === "rename" ? "<name>" : "<colour>"}`;
      process.stderr.write(msg + "\n");
      process.exit(2);
      return;
    }

    write("active", id, { cwd, ts: Date.now() });
  } catch {
    /* swallow: a broken hook must not disrupt Claude Code */
  }
});
