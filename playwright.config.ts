import { defineConfig, devices } from "@playwright/test";

// Browser harness, NOT part of `npm test` (that's vitest, which only includes
// test/** and can't render a canvas). These boot the real webview front-end in
// headless Chromium. *.shot.ts dump PNGs to screenshots/out/ (npm run
// screenshots); *.spec.ts are assertion tests (npm run perf:test). Both need a
// real <canvas>, which is why they live here and not in vitest.
export default defineConfig({
  testDir: "screenshots",
  testMatch: "**/*.{shot,spec}.ts",
  fullyParallel: false,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // crisp, retina-resolution captures
  },
});
