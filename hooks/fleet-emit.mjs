#!/usr/bin/env node
/**
 * Fleet state emitter for Claude Code hooks.
 *
 * Reads a hook payload (JSON) on stdin, derives the agent's identity from its
 * git worktree, maps the hook event to a Fleet state, and appends one JSON
 * event line to the state feed that the VS Code extension watches.
 *
 * Wire it from .claude/settings.json (see hooks/claude-settings.sample.json).
 * One script handles every event — it switches on `hook_event_name`.
 *
 * State file resolution:
 *   $FLEET_STATE_FILE  (absolute), else  <git toplevel>/.fleet/state.jsonl
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";

function readStdinSafe() {
  try {
    // fd 0 = stdin; Claude Code pipes the hook payload here
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const EVENT_STATE = {
  UserPromptSubmit: "active",
  PreToolUse: "active",
  PostToolUse: "active",
  SubagentStop: "active",
  Notification: "waiting",
  Stop: "idle",
  SessionStart: "idle",
  SessionEnd: "idle",
};

function main() {
  let payload = {};
  const raw = readStdinSafe();
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      /* tolerate non-JSON */
    }
  }

  const event = payload.hook_event_name || process.argv[2] || "Notification";
  const cwd = payload.cwd || process.cwd();

  const top = git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
  // repo name = the common dir's parent basename (handles worktrees)
  const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]) || top;
  const repo = basename(dirname(commonDir.endsWith(".git") ? dirname(commonDir) : commonDir)) || basename(top);

  const id = payload.session_id || basename(top);
  const state = EVENT_STATE[event] || "active";

  let task = "";
  if (event === "UserPromptSubmit" && payload.prompt) task = String(payload.prompt).slice(0, 120);
  else if (event === "Notification" && payload.message) task = String(payload.message).slice(0, 120);
  else if (event === "PreToolUse" && payload.tool_name) task = `running ${payload.tool_name}`;
  else if (event === "Stop") task = "awaiting next instruction";

  const ev = {
    id,
    name: basename(top),
    model: payload.model || "claude",
    repo,
    worktree: top,
    branch,
    state,
    ...(task ? { task } : {}),
  };

  const target =
    process.env.FLEET_STATE_FILE || join(top, ".fleet", "state.jsonl");
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, JSON.stringify(ev) + "\n");
}

main();
