import * as vscode from "vscode";
import { FleetStore } from "./fleet";
import { TerminalManager } from "./terminals";
import { DiffProvider, GIT_SCHEME, MOCK_SCHEME } from "./diffProvider";
import { registerChanges } from "./changesView";
import { ConsolePanel } from "./consolePanel";
import { PrService } from "./prs";
import { ClaudeDiscovery } from "./claude";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new FleetStore(context);
  const terminals = new TerminalManager(store);
  const diffProvider = new DiffProvider(store);
  const prs = new PrService(store);
  const discovery = new ClaudeDiscovery(store);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, diffProvider),
    vscode.workspace.registerTextDocumentContentProvider(MOCK_SCHEME, diffProvider),
    { dispose: () => store.dispose() },
    { dispose: () => terminals.dispose() },
    { dispose: () => prs.dispose() },
    { dispose: () => discovery.dispose() }
  );

  const cfg = vscode.workspace.getConfiguration("fleet");
  // real Claude CLI sessions first; mock fleet only if nothing real exists
  let liveSessions = 0;
  if (cfg.get<boolean>("discoverClaudeSessions", true)) {
    liveSessions = await discovery.refresh().catch(() => 0);
    discovery.start();
  }
  if (liveSessions === 0 && cfg.get<boolean>("useMockData", true)) store.seedMock();
  store.watchStateFile();
  prs.start(120_000, 4_000); // PR polling stays off the startup path

  // Native Changes tree (staged/unstaged, stage/unstage, open diff to the right).
  registerChanges(context, store);

  context.subscriptions.push(
    vscode.commands.registerCommand("fleet.refresh", () => store.watchStateFile()),
    vscode.commands.registerCommand("fleet.openConsole", () =>
      ConsolePanel.createOrShow(context, store, terminals, prs, discovery)
    )
  );

  // The 3D console is the primary interface — open it on activation.
  ConsolePanel.createOrShow(context, store, terminals, prs, discovery);
}

export function deactivate(): void {
  /* subscriptions disposed by VS Code */
}
