// Diff two bench runs: node screenshots/bench-compare.js before.json after.json
// Matches rows by (dpr, camera, preset) and prints the draw-cost delta.
const fs = require("fs");
const [, , beforeF, afterF] = process.argv;
const load = (f) => JSON.parse(fs.readFileSync(f, "utf8")).results;
const key = (r) => `${r.dpr}|${r.camera}|${r.preset}`;
const before = new Map(load(beforeF).map((r) => [key(r), r]));
const after = load(afterF);

console.log(`\nbefore: ${beforeF}\nafter:  ${afterF}\n`);
console.log("  dpr  camera     preset     before p50   after p50    change      rooms(after)");
console.log("  " + "-".repeat(78));
for (const a of after) {
  const b = before.get(key(a));
  if (!b) continue;
  const speedup = b.p50 / a.p50;
  const tag = speedup >= 1.15 ? `${speedup.toFixed(1)}x faster` : speedup <= 0.87 ? `${(1 / speedup).toFixed(1)}x SLOWER` : "~same";
  console.log(
    `  ${String(a.dpr).padStart(3)}  ${a.camera.padEnd(9)}  ${a.preset.padEnd(9)}  ` +
    `${(b.p50 + "ms").padStart(9)}  ${(a.p50 + "ms").padStart(9)}   ${tag.padEnd(12)} ${a.sample ? a.sample.roomsDrawn + "/" + a.sample.roomsTotal : ""}`
  );
}
console.log("");
