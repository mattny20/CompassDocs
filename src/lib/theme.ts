// Workspace accent theming. The whole compass-* palette is CSS-variable
// driven (see globals.css), so one admin-chosen hex can re-skin every
// button, link, ring, and tint at runtime: we derive the full 50–900 ramp
// here and the root layout injects it as a <style> block.
//
// Pure module (no server imports): the Workspace settings page uses the
// contrast helpers to show the admin what a chosen accent will become.

export const DEFAULT_ACCENT = "#2e75bd";

/** White text on a primary button must reach WCAG AA for normal text. */
export const AA_CONTRAST = 4.5;

export function isHexColor(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function rgbToHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

/** Mix `a` toward `b` by t (0..1), returning an "R G B" channel triplet. */
function mix(a: Rgb, b: Rgb, t: number): string {
  return mixRgb(a, b, t).join(" ");
}
function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return a.map((ch, i) => Math.round(ch + (b[i] - ch) * t)) as Rgb;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
// The dark theme's canvas color — dark-mode tints blend toward this so the
// subtle compass-50/100 surfaces stay muted instead of glowing.
const DARK_CANVAS: Rgb = [9, 13, 22];

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The accent's SOLID step (compass-600: primary buttons, links, focus
 * rings), darkened toward black in small steps until white text on it reaches
 * AA. Hue is preserved; the tints (50–500) are still derived from the
 * original hex so the brand reads true on surfaces. Returns the input
 * unchanged when it already passes — the default blue is untouched.
 */
export function solidAccent(hex: string): string {
  const h = hex.toLowerCase();
  if (!isHexColor(h)) return h;
  let rgb = hexToRgb(h);
  let out = h;
  for (let i = 0; i < 40 && contrastRatio(out, "#ffffff") < AA_CONTRAST; i++) {
    rgb = mixRgb(rgb, BLACK, 0.06);
    out = rgbToHex(rgb);
  }
  return out;
}

/**
 * CSS overriding the compass palette for a custom accent. Returns "" for the
 * default accent (globals.css already carries the hand-tuned default ramp).
 */
export function accentCss(accent: string): string {
  const hex = accent.toLowerCase();
  if (!isHexColor(hex) || hex === DEFAULT_ACCENT) return "";
  const a = hexToRgb(hex);
  // Solid steps (600 and darker) come from the AA-adjusted colour; tints keep
  // the chosen hue at full strength.
  const s = hexToRgb(solidAccent(hex));
  // Dark-mode accent ink: the 300 / 250 steps of the ramp (globals.css reads
  // --compass-ink for text-compass-600/700 in dark mode). Without these a
  // custom accent gets accent buttons but stock-blue text in dark mode.
  return `:root{--compass-50:${mix(a, WHITE, 0.93)};--compass-100:${mix(a, WHITE, 0.84)};--compass-200:${mix(a, WHITE, 0.7)};--compass-300:${mix(a, WHITE, 0.5)};--compass-400:${mix(a, WHITE, 0.28)};--compass-500:${mix(a, WHITE, 0.12)};--compass-600:${s.join(" ")};--compass-700:${mix(s, BLACK, 0.18)};--compass-800:${mix(s, BLACK, 0.32)};--compass-900:${mix(s, BLACK, 0.45)};--compass-ink:${s.join(" ")};--compass-ink-strong:${mix(s, BLACK, 0.18)}}
:root[data-theme="dark"]{--compass-50:${mix(DARK_CANVAS, a, 0.2)};--compass-100:${mix(DARK_CANVAS, a, 0.3)};--compass-ink:${mix(a, WHITE, 0.5)};--compass-ink-strong:${mix(a, WHITE, 0.62)}}`;
}
