// Workspace accent theming. The whole compass-* palette is CSS-variable
// driven (see globals.css / tailwind.config.ts), so one admin-chosen hex can
// re-skin every button, link, ring, and tint at runtime: we derive the full
// 50–900 ramp here and the root layout injects it as a <style> block.

export const DEFAULT_ACCENT = "#2e75bd";

export function isHexColor(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Mix `a` toward `b` by t (0..1), returning an "R G B" channel triplet. */
function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  return a.map((ch, i) => Math.round(ch + (b[i] - ch) * t)).join(" ");
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];
// The dark theme's canvas color — dark-mode tints blend toward this so the
// subtle compass-50/100 surfaces stay muted instead of glowing.
const DARK_CANVAS: [number, number, number] = [9, 13, 22];

/**
 * CSS overriding the compass palette for a custom accent. Returns "" for the
 * default accent (globals.css already carries the hand-tuned default ramp).
 */
export function accentCss(accent: string): string {
  const hex = accent.toLowerCase();
  if (!isHexColor(hex) || hex === DEFAULT_ACCENT) return "";
  const a = hexToRgb(hex);
  return `:root{--compass-50:${mix(a, WHITE, 0.93)};--compass-100:${mix(a, WHITE, 0.84)};--compass-200:${mix(a, WHITE, 0.7)};--compass-300:${mix(a, WHITE, 0.5)};--compass-400:${mix(a, WHITE, 0.28)};--compass-500:${mix(a, WHITE, 0.12)};--compass-600:${a.join(" ")};--compass-700:${mix(a, BLACK, 0.18)};--compass-800:${mix(a, BLACK, 0.32)};--compass-900:${mix(a, BLACK, 0.45)}}
:root[data-theme="dark"]{--compass-50:${mix(DARK_CANVAS, a, 0.2)};--compass-100:${mix(DARK_CANVAS, a, 0.3)}}`;
}
