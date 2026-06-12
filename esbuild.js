const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "out/extension.js",
  external: ["vscode"],
  logLevel: "info",
};

/** Webview crew bundle: Three.js scene, runs in the browser/webview. */
/** @type {import('esbuild').BuildOptions} */
const crew = {
  entryPoints: ["src/webview/crew.ts"],
  bundle: true,
  format: "iife",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  target: ["es2020"],
  outfile: "media/crew.js",
  logLevel: "info",
};

async function main() {
  if (watch) {
    const a = await esbuild.context(extension);
    const b = await esbuild.context(crew);
    await Promise.all([a.watch(), b.watch()]);
    console.log("[esbuild] watching extension + crew…");
  } else {
    await Promise.all([esbuild.build(extension), esbuild.build(crew)]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
