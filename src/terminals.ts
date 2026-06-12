import * as vscode from "vscode";
import * as path from "path";
import { FleetStore } from "./fleet";
import { resolveCwd } from "./git";

/**
 * Binds one NATIVE integrated terminal per agent, rooted in the agent's real
 * worktree. Selecting an agent reveals its terminal; sending input writes to
 * that terminal's PTY. If `fleet.launchCommand` is set, it runs on first open
 * (e.g. to resume an agent session), so subsequent sends go to that process's
 * stdin — this is how a live session is continued.
 */
export class TerminalManager {
  private terminals = new Map<string, vscode.Terminal>();

  constructor(private store: FleetStore) {
    vscode.window.onDidCloseTerminal((t) => {
      for (const [id, term] of this.terminals) {
        if (term === t) this.terminals.delete(id);
      }
    });
  }

  private ensure(agentId: string): vscode.Terminal | undefined {
    const agent = this.store.get(agentId);
    if (!agent) return undefined;
    let term = this.terminals.get(agentId);
    if (!term) {
      const cwd = resolveCwd(agent);
      term = vscode.window.createTerminal({
        name: `◆ ${agent.name}`,
        iconPath: new vscode.ThemeIcon("pulse"),
        cwd,
        message: `Fleet session — ${agent.repo} ⌥ ${agent.branch}`,
      });
      this.terminals.set(agentId, term);

      const cfg = vscode.workspace.getConfiguration("fleet");
      const cmd = cfg.get<string>("launchCommand", "").trim();
      if (cmd) {
        const resolved = cmd
          .replace(/\$\{worktree\}/g, cwd ?? ".")
          .replace(/\$\{branch\}/g, agent.branch)
          .replace(/\$\{id\}/g, agent.id);
        term.sendText(resolved, true);
      } else if (agent.transcriptPath) {
        // discovered Claude session → attach the REAL conversation here, so
        // this terminal IS the agent's chat
        const claudeCmd = cfg.get<string>("claudeCommand", "claude").trim() || "claude";
        const sessionId = path.basename(agent.transcriptPath, ".jsonl");
        term.sendText(`${claudeCmd} --resume ${sessionId}`, true);
      }
    }
    return term;
  }

  reveal(agentId: string): void {
    this.ensure(agentId)?.show(true);
  }

  /** Write operator input to the agent's terminal (the agent process stdin). */
  send(agentId: string, text: string): void {
    const term = this.ensure(agentId);
    if (!term) return;
    term.show(true);
    term.sendText(text, true);
  }

  /**
   * Submit a slash command (e.g. `/cd <dir>`) to the agent's Claude session.
   * Typed key-by-key, `/cd ` opens the TUI's path autocomplete, which captures
   * the trailing path and mangles the argument. Wrapping the text in a
   * bracketed-paste sequence makes the TUI ingest it as one literal block
   * (no autocomplete), then a separate Enter submits it.
   */
  command(agentId: string, text: string): void {
    const term = this.ensure(agentId);
    if (!term) return;
    term.show(true);
    term.sendText(`\x1b[200~${text}\x1b[201~`, false); // bracketed paste, no newline
    term.sendText("", true); // Enter → submit
  }

  dispose(): void {
    for (const t of this.terminals.values()) t.dispose();
    this.terminals.clear();
  }
}
