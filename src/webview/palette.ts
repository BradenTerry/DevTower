// Webview color palette for canvas text, plus WCAG contrast helpers.
//
// Kept DOM-free and dependency-free so it can be unit-tested (test/contrast.test.ts
// asserts every label color clears AA contrast against the board background). The
// board "screen" the labels sit on is a dark gradient from #101b27 (top) to
// #0a1118 (bottom); the lighter top is the worst case for light text, so that is
// the contrast reference.

/** Worst-case (lightest) background the board labels are drawn over. */
export const BOARD_BG = "#101b27";

/**
 * Text colors for the board labels, as OPAQUE hex (no alpha) so they don't dim
 * into the dark screen. Roles, brightest to dimmest - all clear AA (>= 4.5:1)
 * against BOARD_BG; see the test.
 */
export const TEXT = {
  /** Primary readout (counts, values) - very light. */
  primary: "#e3ecf1",
  /** Cell/section headings: UNSTAGED / STAGED / COMMITS, "PR". */
  heading: "#ffffff",
  /** Secondary text: "no open PR", repo name, "nothing awaiting you", "+N more". */
  muted: "#a6b4bd",
} as const;

/** Status accents (already high-contrast); kept here so the test covers them too. */
export const ACCENT = {
  amber: "#ffb13d",
  green: "#3ee089",
  blue: "#56c7ff",
  link: "#9fd0f0",
  error: "#ff6055",
} as const;

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance (WCAG 2.x) of a #rrggbb color, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => srgbToLinear(parseInt(h, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colors (1:1 to 21:1). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
