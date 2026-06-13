/**
 * Minimal `vscode` stand-in for unit tests. The extension modules import the
 * real `vscode` API, which only exists inside the VS Code extension host. Tests
 * run in plain Node, so vitest aliases `vscode` to this file (see
 * vitest.config.ts). It implements just the surface the tested modules touch at
 * import time or in the code paths under test — not the whole API.
 *
 * Tests that need to steer configuration or the open workspace can call the
 * helpers exported at the bottom (setConfig / setWorkspaceFolders).
 */

type Listener<T> = (e: T) => void;

export class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();
  event = (fn: Listener<T>) => {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  };
  fire(data: T): void {
    for (const fn of [...this.listeners]) fn(data);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class ThemeIcon {
  constructor(public id: string) {}
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class RelativePattern {
  constructor(public base: string, public pattern: string) {}
}

// ---- mutable test state ------------------------------------------------------
let configValues: Record<string, unknown> = {};
let workspaceFolders: { uri: { fsPath: string } }[] | undefined = undefined;

export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get<T>(key: string, def?: T): T {
        return (key in configValues ? (configValues[key] as T) : (def as T));
      },
      update(key: string, value: unknown) {
        configValues[key] = value;
        return Promise.resolve();
      },
    };
  },
  get workspaceFolders() {
    return workspaceFolders;
  },
  createFileSystemWatcher() {
    return {
      onDidChange: () => ({ dispose() {} }),
      onDidCreate: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    };
  },
};

export const window = {
  createTerminal: () => ({ sendText() {}, show() {}, dispose() {} }),
  onDidCloseTerminal: () => ({ dispose() {} }),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showInformationMessage: () => Promise.resolve(undefined),
  showQuickPick: () => Promise.resolve(undefined),
};

export const commands = {
  registerCommand: () => ({ dispose() {} }),
  executeCommand: () => Promise.resolve(undefined),
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: "file", path: p }),
  parse: (p: string) => ({ fsPath: p, scheme: "file", path: p }),
};

// ---- test helpers ------------------------------------------------------------
export function __setConfig(values: Record<string, unknown>): void {
  configValues = { ...values };
}
export function __setWorkspaceFolders(paths: string[] | undefined): void {
  workspaceFolders = paths?.map((p) => ({ uri: { fsPath: p } }));
}
export function __reset(): void {
  configValues = {};
  workspaceFolders = undefined;
}

export default {
  EventEmitter,
  ThemeIcon,
  ConfigurationTarget,
  RelativePattern,
  workspace,
  window,
  commands,
  Uri,
};
