// Builds a standalone HTML page that boots the real webview front-end
// (media/crew.js + media/console.js + media/console.css) outside VS Code, with a
// stubbed acquireVsCodeApi so the scene + HUD render against mock messages.
//
// The <body> markup is lifted verbatim from ConsolePanel.html() so the DOM the
// scripts query stays in sync with the extension. Throwaway tooling: it exists
// only to produce before/after screenshots, never asserts anything.
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.join(ROOT, "media");
const fileUrl = (p: string) => pathToFileURL(path.join(MEDIA, p)).href;

/** Extract the <body>...</body> inner markup from the extension's html() so the
 *  harness renders the exact same DOM. Strips the real <script> includes (we add
 *  file:// ones) and any ${...} template holes that aren't structural. */
function bodyMarkup(): string {
  const src = fs.readFileSync(path.join(ROOT, "src", "consolePanel.ts"), "utf8");
  const m = src.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  if (!m) throw new Error("could not find <body> in consolePanel.ts html()");
  return m[1]
    .replace(/<script[\s\S]*?<\/script>/g, "") // drop nonce'd script includes
    .replace(/\$\{[^}]*\}/g, ""); // any stray template expressions
}

export function harnessHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;600;700&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
<link href="${fileUrl("console.css")}" rel="stylesheet" />
<title>DevTower screenshot harness</title>
</head>
<body data-theme="dark">
${bodyMarkup()}
<script>
  // minimal VS Code API stub: capture outbound messages, no-op the rest
  window.__outbox = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__outbox.push(m),
    getState: () => undefined,
    setState: () => {},
  });
</script>
<script src="${fileUrl("crew.js")}"></script>
<script src="${fileUrl("console.js")}"></script>
</body>
</html>`;
}
