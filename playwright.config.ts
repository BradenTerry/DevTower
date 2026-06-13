import { defineConfig, devices } from "@playwright/test";

// Screenshot-only harness, NOT part of `npm test` (that's vitest, which only
// includes test/**). These specs boot the real webview front-end in headless
// Chromium and dump PNGs to screenshots/out/. Run with: npm run screenshots
export default defineConfig({
  testDir: "screenshots",
  testMatch: "**/*.shot.ts",
  fullyParallel: false,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // crisp, retina-resolution captures
  },
});
