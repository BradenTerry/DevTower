import { defineConfig } from "vitest/config";
import * as path from "path";

// Unit/integration tests run in plain Node (not the VS Code extension host), so
// the real `vscode` module is unavailable. Alias it to a hand-written stub.
// Tests live under test/ and exercise the OS-sensitive logic (git, transcript
// scanning, path handling) on whatever OS the CI matrix is running.
export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/__mocks__/vscode.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // git integration tests shell out and create temp repos; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
