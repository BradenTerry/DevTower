import * as vscode from "vscode";
import { DevTowerStore } from "./store";
import { TerminalManager } from "./terminals";
import { DiffProvider, GIT_SCHEME, MOCK_SCHEME } from "./diffProvider";
import { registerChanges } from "./changesView";
import { ConsolePanel } from "./consolePanel";
import { PrService } from "./prs";
import { ClaudeDiscovery } from "./claude";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new DevTowerStore(context);
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

  const cfg = vscode.workspace.getConfiguration("devtower");
  // real Claude CLI sessions first; mock crew only if nothing real exists
  let liveSessions = 0;
  if (cfg.get<boolean>("discoverClaudeSessions", true)) {
    liveSessions = await discovery.refresh().catch(() => 0);
    discovery.start(cfg.get<number>("pollIntervalMs", 8_000));
  }
  if (liveSessions === 0 && cfg.get<boolean>("useMockData", false)) store.seedMock();
  store.watchStateFile();
  prs.start(4_000); // adaptive PR polling (fast while a build runs); off the startup path

  // Native Changes tree (staged/unstaged, stage/unstage, open diff to the right).
  registerChanges(context, store);

  context.subscriptions.push(
    vscode.commands.registerCommand("devtower.refresh", () => store.watchStateFile()),
    vscode.commands.registerCommand("devtower.openConsole", () =>
      ConsolePanel.createOrShow(context, store, terminals, prs, discovery)
    )
  );

  // The 3D console is the primary interface — open it on activation.
  ConsolePanel.createOrShow(context, store, terminals, prs, discovery);
}

export function deactivate(): void {
  /* subscriptions disposed by VS Code */
}
