import * as fs from "fs";
import { Agent, SessionMessage } from "./fleet";

/**
 * Resolve the session log to render for an agent. Prefers a live Claude Code
 * transcript (JSONL) when `transcriptPath` is set and readable; otherwise
 * falls back to any seeded `session` data (mock agents).
 */
export function getSession(agent: Agent, limit = 200): SessionMessage[] {
  if (agent.transcriptPath && fs.existsSync(agent.transcriptPath)) {
    try {
      return readTranscript(agent.transcriptPath, limit);
    } catch {
      /* fall through to seeded */
    }
  }
  return agent.session ?? [];
}

/** Best-effort parse of a Claude Code transcript JSONL into session messages. */
export function readTranscript(path: string, limit: number): SessionMessage[] {
  const raw = fs.readFileSync(path, "utf8");
  const out: SessionMessage[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec: any;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    const role = rec.type ?? rec.role ?? rec.message?.role;
    const content = rec.message?.content ?? rec.content;

    if (role === "user") {
      const text = flatten(content);
      if (text) out.push({ kind: "user", text });
    } else if (role === "assistant") {
      for (const block of asBlocks(content)) {
        if (block.type === "text" && block.text?.trim()) {
          out.push({ kind: "assistant", text: block.text.trim() });
        } else if (block.type === "tool_use") {
          out.push({ kind: "tool", tool: block.name, text: summarizeInput(block.input) });
        }
      }
    } else if (role === "result" || rec.subtype === "result") {
      const text = flatten(content) || rec.result;
      if (text) out.push({ kind: "result", text: String(text) });
    }
  }
  return out.slice(-limit);
}

function asBlocks(content: any): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function flatten(content: any): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b?.text ?? ""))
      .join("")
      .trim();
  }
  return "";
}

function summarizeInput(input: any): string {
  if (!input) return "";
  if (input.file_path) return String(input.file_path);
  if (input.command) return String(input.command).slice(0, 100);
  if (input.path) return String(input.path);
  const keys = Object.keys(input);
  return keys.length ? `${keys[0]}: ${String(input[keys[0]]).slice(0, 80)}` : "";
}
