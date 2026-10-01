// Workspace accent: every accent must put white text on a primary button at
// WCAG AA (4.5:1), and the default blue must stay byte-identical.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AA_CONTRAST, DEFAULT_ACCENT, accentCss, contrastRatio, solidAccent } from "../src/lib/theme";

describe("workspace accent", () => {
  test("the default accent emits no override", () => {
    assert.equal(accentCss(DEFAULT_ACCENT), "");
    assert.equal(accentCss("#2E75BD"), "");
    assert.equal(accentCss("not a colour"), "");
  });

  test("contrast ratio matches the WCAG reference values", () => {
    assert.equal(Math.round(contrastRatio("#000000", "#ffffff") * 100) / 100, 21);
    assert.equal(Math.round(contrastRatio("#ffffff", "#ffffff")), 1);
    // The default blue is already AA for white text.
    assert.ok(contrastRatio(DEFAULT_ACCENT, "#ffffff") >= AA_CONTRAST);
  });

  test("every preset and a few pathological accents reach AA on the solid step", () => {
    const presets = ["#2e75bd", "#4f46e5", "#7c3aed", "#0f766e", "#047857", "#b45309", "#dc2626", "#db2777", "#475569"];
    const nasty = ["#ffd700", "#00ffff", "#d97706", "#0d9488", "#059669", "#ffffff", "#9ca3af"];
    for (const hex of [...presets, ...nasty]) {
      const solid = solidAccent(hex);
      assert.ok(
        contrastRatio(solid, "#ffffff") >= AA_CONTRAST,
        `${hex} → ${solid} is ${contrastRatio(solid, "#ffffff").toFixed(2)}:1`
      );
    }
    // Already-passing colours are returned unchanged.
    assert.equal(solidAccent("#2e75bd"), "#2e75bd");
    assert.equal(solidAccent("#dc2626"), "#dc2626");
    // Hue is preserved: a darkened amber is still amber (red > green > blue).
    const amber = solidAccent("#d97706");
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(amber.slice(i, i + 2), 16));
    assert.ok(r > g && g > b, amber);
  });

  test("a custom accent emits the solid step as --compass-600 and both ink tokens", () => {
    const css = accentCss("#d97706");
    assert.match(css, /--compass-600:\d+ \d+ \d+/);
    assert.match(css, /--compass-ink:\d+ \d+ \d+/);
    assert.match(css, /--compass-ink-strong:\d+ \d+ \d+/);
    // Tints keep the chosen hue: compass-50 is derived from the original hex.
    assert.match(css, /--compass-50:25[0-5] 24[0-9] 23[0-9]/);
    // Dark block re-emits the ink.
    assert.match(css, /data-theme="dark"\]\{[^}]*--compass-ink:/);
  });
});
