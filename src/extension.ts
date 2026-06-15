import * as vscode from "vscode";
import { DevTowerStore } from "./store";
import { TerminalManager } from "./terminals";
import { DiffProvider, GIT_SCHEME, MOCK_SCHEME } from "./diffProvider";
import { registerChanges } from "./changesView";
import { registerDirectory } from "./directoryView";
import { ConsolePanel } from "./consolePanel";
import { PrService } from "./prs";
import { ClaudeDiscovery } from "./claude";
import { syncHooks } from "./hooks";
import { initGithubAuth } from "./github";
import { initDebugLog, dlog, elog, errorLogPath } from "./debugLog";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initDebugLog(context);
  dlog("activate", {});
  const store = new DevTowerStore(context);
  const terminals = new TerminalManager(store);
  const diffProvider = new DiffProvider(store);
  const prs = new PrService(store);
  const discovery = new ClaudeDiscovery(store);
  // DevTower authenticates to GitHub with a PAT the user adds in the settings
  // page (stored in SecretStorage); initialize the secret-backed auth + cache
  initGithubAuth(context);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, diffProvider),
    vscode.workspace.registerTextDocumentContentProvider(MOCK_SCHEME, diffProvider),
    { dispose: () => store.dispose() },
    { dispose: () => terminals.dispose() },
    { dispose: () => prs.dispose() },
    { dispose: () => discovery.dispose() }
  );

  const cfg = vscode.workspace.getConfiguration("devtower");
  // discover real Claude CLI sessions (there is no mock data)
  if (cfg.get<boolean>("discoverClaudeSessions", true)) {
    await discovery.refresh().catch((e) => { elog("discovery.activate", { message: String(e), stack: (e as any)?.stack }); return 0; });
    discovery.start(cfg.get<number>("pollIntervalMs", 8_000));
  }
  store.watchStateFile();
  prs.start(4_000); // adaptive PR polling (fast while a build runs); off the startup path
  // when an agent runs `gh pr create`, discovery sees it in the transcript and
  // fires this → chase that PR onto the board now. A lone refresh races GitHub's
  // pr-list index (which lags creation) and a checkless PR idles the poller at
  // 60s, so a brand-new PR could sit off the board for up to a minute.
  context.subscriptions.push(discovery.onPrCreated(() => void prs.chaseNewPr()));
  // when an agent runs `gh pr merge`/`close`, discovery fires this → refresh now so
  // the no-longer-open PR drops off the board immediately instead of lingering
  // until the poller's lazy ~60s tick.
  context.subscriptions.push(discovery.onPrClosed(() => void prs.refresh(true)));

  // Repair installed hook paths and, if a build shipped a brand-new hook, nudge
  // the user once to review it on Settings > Hooks. Never installs without a
  // choice; never blocks the tower opening.
  if (cfg.get<boolean>("discoverClaudeSessions", true)) {
    syncHooks(context).catch((e) => dlog("hooks.sync.fail", { err: String(e) }));
  }

  // DevTower tab: a file browser for the selected room's worktree, plus the
  // Changes tree (staged/unstaged, stage/unstage, open diff to the right).
  registerDirectory(context, store);
  registerChanges(context, store);

  context.subscriptions.push(
    vscode.commands.registerCommand("devtower.refresh", () => store.watchStateFile()),
    vscode.commands.registerCommand("devtower.openSettings", (tab?: string) =>
      ConsolePanel.createOrShow(context, store, terminals, prs, discovery).openSettings(tab)
    ),
    vscode.commands.registerCommand("devtower.openConsole", () =>
      ConsolePanel.createOrShow(context, store, terminals, prs, discovery)
    ),
    vscode.commands.registerCommand("devtower.installHooks", () =>
      ConsolePanel.createOrShow(context, store, terminals, prs, discovery).openSettings("hooks")
    ),
    vscode.commands.registerCommand("devtower.openErrorLog", async () => {
      const p = errorLogPath();
      if (!p) {
        void vscode.window.showInformationMessage("DevTower: error log is unavailable (global storage not writable).");
        return;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
        await vscode.window.showTextDocument(doc);
      } catch {
        void vscode.window.showInformationMessage(`DevTower: no errors logged yet. The log will appear at ${p}`);
      }
    })
  );

  // The 3D console is the primary interface — open it on activation.
  ConsolePanel.createOrShow(context, store, terminals, prs, discovery);
}

export function deactivate(): void {
  /* subscriptions disposed by VS Code */
}
