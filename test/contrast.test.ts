import { describe, it, expect } from "vitest";
import { BOARD_BG, TEXT, ACCENT, contrastRatio, relativeLuminance } from "../src/webview/palette";

// WCAG 2.x AA thresholds. The board labels are small, so we hold them to the
// normal-text bar (4.5:1) rather than the large-text relaxation (3:1) - if these
// pass at small size they are comfortably readable.
const AA_NORMAL = 4.5;

describe("contrastRatio", () => {
  it("is 21:1 for black on white and 1:1 for equal colors", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#123456", "#123456")).toBeCloseTo(1, 5);
  });
  it("is symmetric", () => {
    expect(contrastRatio(TEXT.heading, BOARD_BG)).toBeCloseTo(contrastRatio(BOARD_BG, TEXT.heading), 6);
  });
  it("rejects malformed colors", () => {
    expect(() => relativeLuminance("nope")).toThrow();
  });
});

describe("board label colors meet WCAG AA against the board background", () => {
  for (const [role, hex] of Object.entries(TEXT)) {
    it(`TEXT.${role} (${hex}) >= ${AA_NORMAL}:1`, () => {
      expect(contrastRatio(hex, BOARD_BG)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});

describe("status accent colors meet WCAG AA against the board background", () => {
  for (const [role, hex] of Object.entries(ACCENT)) {
    it(`ACCENT.${role} (${hex}) >= ${AA_NORMAL}:1`, () => {
      expect(contrastRatio(hex, BOARD_BG)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});
