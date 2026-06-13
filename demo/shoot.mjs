import { fileURLToPath } from "url";
import { dirname, join } from "path";

// playwright is not a project dependency; resolve it from wherever it is
// installed (project, global, or an `npx playwright` cache). Run via:
//   npx playwright@latest node demo/shoot.mjs
// or install it first: npm i -D playwright && npx playwright install chromium
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not found. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlUrl = "file://" + join(__dirname, "harness.html");

async function launch() {
  // allow an explicit browser via PW_EXECUTABLE, else let playwright pick
  const executablePath = process.env.PW_EXECUTABLE || undefined;
  try { return await chromium.launch({ executablePath }); }
  catch { return await chromium.launch({ channel: "chrome" }); }
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
page.on("console", (m) => console.log("[page]", m.type(), m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(htmlUrl, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.DevTowerCrew && !!window.DevTowerCrew._instance);
await page.evaluate(() => window.__feed());
// let the scene frame the tower and run a few animation frames
await page.waitForTimeout(2500);
await page.screenshot({ path: join(__dirname, "01-overview.png") });

// frame a single room: the dev walks to and sits at the desk (active state),
// the board shows branch + git churn + the PR cell. Used in the READMEs.
await page.evaluate(() => window.DevTowerCrew._instance.focusOn("atlas-web"));
await page.waitForTimeout(5000); // wait out the walk-in so the dev is seated
await page.screenshot({ path: join(__dirname, "room.png") });

// fly the camera to the central review-requested billboard
await page.evaluate(() => window.__focusBillboard());
await page.waitForTimeout(2500);
await page.screenshot({ path: join(__dirname, "02-billboard.png") });

// open the review-dispatch card for PR #311 (what clicking a billboard row does)
await page.evaluate(() => {
  window.DevTowerCrew._instance.onAssignReviewCb({
    number: 311, repo: "acme/atlas-api",
    title: "Rate limiter cleanup + sliding window",
    url: "https://github.com/acme/atlas-api/pull/311",
  });
});
await page.waitForTimeout(800);
// capture the card itself (the scene behind is irrelevant for this shot)
await page.locator(".rd-card").screenshot({ path: join(__dirname, "03-dispatch.png") });

await browser.close();
console.log("done");
