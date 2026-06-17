import * as vscode from "vscode";
import * as path from "path";
import { Agent, DevTowerStore } from "./store";
import { resolveCwd } from "./git";
import { dlog, recordExec } from "./debugLog";

/** The console tab title for an agent: its AI session summary when one exists,
 *  else the dev's name. The summary tracks what the session is actually doing,
 *  so it makes a more useful tab label than the generated dev name. */
export function consoleTitle(agent: Pick<Agent, "name" | "aiTitle">): string {
  return agent.aiTitle?.trim() || agent.name;
}

/**
 * Binds one NATIVE integrated terminal per agent, rooted in the agent's real
 * worktree. Selecting an agent reveals its terminal; sending input writes to
 * that terminal's PTY. If `devtower.launchCommand` is set, it runs on first open
 * (e.g. to resume an agent session), so subsequent sends go to that process's
 * stdin — this is how a live session is continued.
 */
export class TerminalManager {
  private terminals = new Map<string, vscode.Terminal>();
  /** Last title applied to each agent's console tab, so a store poll only re-renames
   *  when the computed title (its AI summary) actually changed — renaming focuses
   *  the terminal, so a no-op rename every poll would steal focus repeatedly. */
  private titles = new Map<string, string>();
  /** Called when an OWNED dev's terminal closes (its claude process dies with the
   *  PTY) so discovery can retire it now + suppress its transcript from
   *  rediscovery, rather than leaving an orphan to resurface as a ghost. */
  private onOwnedClose?: (agentId: string) => void;

  constructor(private store: DevTowerStore, private extensionUri: vscode.Uri) {
    // The AI summary lands (and changes) as a session runs, after its terminal was
    // already opened — re-title the tab whenever the store updates so the console
    // name keeps tracking what the session is doing.
    this.store.onChange(() => this.syncTitles());
    // A window reload revives DevTower's terminals (the pty host keeps the claude
    // process alive) but this manager starts with an empty map, so without
    // rebinding, revealing an agent would fork a SECOND `claude --resume`. VS Code
    // revives terminals asynchronously, so some appear after activation's
    // reconcile() — bind those as they open.
    vscode.window.onDidOpenTerminal((t) => {
      void t.processId.then((pid) => this.tryBind(t, pid));
    });
    vscode.window.onDidCloseTerminal((t) => {
      for (const [id, term] of this.terminals) {
        if (term !== t) continue;
        this.terminals.delete(id);
        this.titles.delete(id);
        // A panel-created placeholder (no live Claude transcript yet) has nothing
        // else tracking it, so stopping its terminal means the operator dropped
        // the agent — remove it from the tower. An OWNED dev with a live transcript
        // had its claude process killed with the PTY, so retire it deterministically
        // (suppressing the orphan transcript so it can't resurface as a ghost) —
        // this used to wait for a discovery poll that might never run before a
        // reload. EXTERNAL sessions run in their own terminal, so closing DevTower's
        // shell doesn't end them — left to discovery.
        const agent = this.store.get(id);
        const dropped = !!(agent && !agent.transcriptPath);
        dlog("terminal.closed", { agentId: id, droppedPlaceholder: dropped });
        if (dropped) this.store.remove(id);
        else if (agent && !agent.external) this.onOwnedClose?.(id);
        break;
      }
    });
  }

  /** Wire the owned-dev close handler (discovery is constructed after this, so it
   *  is injected here rather than via the constructor). */
  setOwnedCloseHandler(cb: (agentId: string) => void): void {
    this.onOwnedClose = cb;
  }

  /**
   * Bind a (revived) terminal to the agent it belongs to, so revealing that agent
   * reuses this terminal instead of forking a fresh `claude --resume`. Matches an
   * agent that is NOT already bound by stored shell PID (primary — stable across a
   * window reload) or the agent-name terminal title (fallback). Only adopts
   * matching terminals: a name-mismatch with no PID match is left alone, so
   * unrelated user terminals are never claimed.
   */
  private tryBind(term: vscode.Terminal, pid?: number): void {
    const bound = new Set(this.terminals.keys());
    for (const t of this.terminals.values()) if (t === term) return; // already mapped
    let match: { id: string; by: "pid" | "name" } | undefined;
    for (const a of this.store.list()) {
      if (bound.has(a.id)) continue;
      if (pid !== undefined && a.terminalPid === pid) { match = { id: a.id, by: "pid" }; break; }
      if (term.name === consoleTitle(a) && !match) match = { id: a.id, by: "name" };
    }
    if (!match) return;
    this.terminals.set(match.id, term);
    dlog("terminal.reconcile", { agentId: match.id, terminalPid: pid, by: match.by });
    if (pid !== undefined && this.store.get(match.id)?.terminalPid !== pid) {
      this.store.apply({ id: match.id, terminalPid: pid });
    }
  }

  /** Re-bind every revived terminal to its agent (activation + manual resync). */
  async reconcile(): Promise<void> {
    const open = await Promise.all(
      vscode.window.terminals.map(async (t) => ({
        t,
        pid: await Promise.resolve(t.processId).catch(() => undefined),
      }))
    );
    for (const { t, pid } of open) this.tryBind(t, pid);
  }

  private ensure(agentId: string): vscode.Terminal | undefined {
    const agent = this.store.get(agentId);
    if (!agent) return undefined;
    let term = this.terminals.get(agentId);
    if (!term) {
      const cwd = resolveCwd(agent);
      const title = consoleTitle(agent);
      term = vscode.window.createTerminal({
        name: title,
        // theme-aware pair so the tower stays visible: file-URI SVGs don't get a
        // currentColor context here, so a single svg renders black on dark themes.
        iconPath: {
          light: vscode.Uri.joinPath(this.extensionUri, "media", "devtower-light.svg"),
          dark: vscode.Uri.joinPath(this.extensionUri, "media", "devtower-dark.svg"),
        },
        cwd,
        message: `DevTower session — ${agent.repo} ⌥ ${agent.branch}`,
      });
      this.terminals.set(agentId, term);
      this.titles.set(agentId, title);
      dlog("terminal.create", { agentId, name: title, cwd, external: !!agent.external, hasTranscript: !!agent.transcriptPath });
      // Record the shell PID for this owned dev's terminal. The claude process is
      // a child of this shell, and the shell PID survives /clear (only the
      // transcript uuid changes), so it is the most reliable agent↔session tie.
      // processId resolves async (the PTY spawns a beat after createTerminal), so
      // capture it when ready and flow it into the store for the binding snapshot.
      term.processId.then((pid) => {
        if (pid === undefined || this.terminals.get(agentId) !== term) return;
        dlog("terminal.pid", { agentId, terminalPid: pid });
        this.store.apply({ id: agentId, terminalPid: pid });
      });

      const cfg = vscode.workspace.getConfiguration("devtower");
      // a session running outside DevTower is managed in its own terminal — never
      // resume/relaunch it here (that would fork a second, conflicting session)
      const cmd = agent.external ? "" : cfg.get<string>("launchCommand", "").trim();
      if (agent.external) {
        /* plain shell in the worktree; no claude --resume */
      } else if (cmd) {
        const resolved = cmd
          .replace(/\$\{worktree\}/g, cwd ?? ".")
          .replace(/\$\{branch\}/g, agent.branch)
          .replace(/\$\{id\}/g, agent.id);
        recordExec("launch", [resolved], cwd, 0, true); // a "starting command" the user can see
        term.sendText(resolved, true);
      } else if (agent.transcriptPath) {
        // discovered Claude session → attach the REAL conversation here, so
        // this terminal IS the agent's chat
        const claudeCmd = cfg.get<string>("claudeCommand", "claude").trim() || "claude";
        const sessionId = path.basename(agent.transcriptPath, ".jsonl");
        recordExec("launch", [`${claudeCmd} --resume ${sessionId}`], cwd, 0, true);
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
    dlog("terminal.send", { agentId, text });
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

  /** Re-title every open console whose computed title changed (a fresh AI summary
   *  or a `/rename`). Cheap when nothing moved — only a changed title triggers the
   *  focus-stealing rename below. */
  private syncTitles(): void {
    for (const id of this.terminals.keys()) void this.syncTitle(id);
  }

  /** Retitle an agent's console to its current title (AI summary, else dev name),
   *  WITHOUT killing the live session. VS Code exposes no setter for a terminal's
   *  name, so reveal the terminal (focused, so it becomes the active one) and
   *  rename it in place via the built-in command. No-ops when the title is
   *  unchanged so a store poll doesn't repeatedly steal focus. */
  async syncTitle(agentId: string): Promise<void> {
    const term = this.terminals.get(agentId);
    const agent = this.store.get(agentId);
    if (!term || !agent) return;
    const title = consoleTitle(agent);
    if (!title.trim() || this.titles.get(agentId) === title) return;
    this.titles.set(agentId, title);
    term.show(false); // focus it → renameWithArg targets the active terminal
    try {
      await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", {
        name: title,
      });
      dlog("terminal.rename", { agentId, name: title });
    } catch (e) {
      dlog("terminal.rename.fail", { agentId, err: String(e) });
    }
  }

  /** Kill one agent's terminal (and the session process running in it). */
  disposeAgent(agentId: string): void {
    const term = this.terminals.get(agentId);
    if (term) {
      term.dispose();
      this.terminals.delete(agentId);
      this.titles.delete(agentId);
    }
  }

  dispose(): void {
    for (const t of this.terminals.values()) t.dispose();
    this.terminals.clear();
  }
}
