// Helpdesk 1.19.4: keeping text readable on the desk's background artwork
// (lib/helpdesk/appearance). Pure and client-safe: the server measures each
// artwork once with it, the admin page's preview and the desk resolve the
// same alphas from it, and test/helpdesk-appearance proves the built-ins.
//
// How the desk is painted over an artwork (desk-look.css):
//
//   the picture       blurred 8px, `cover`, fixed behind the whole desk;
//   the scrim         rgb(var(--surface) / S) over all of it, so text that
//                     sits straight on the artwork (the views column, the
//                     ticket pane, a settings page) has a calm ground;
//   the panels        `.bg-surface` (top bar, rail, list, cards) add
//                     rgb(var(--surface) / P) on top, with a backdrop blur.
//
// S is the level's base (Glass 0.38, Subtle 0.6: the approved mock-ups) or
// more: whatever the picture needs for every text colour the desk uses to
// keep WCAG AA (4.5:1) everywhere on it. P is fixed per level (Glass 0.355,
// Subtle 0.6) so that over the base scrim a panel composes to the mock-ups'
// 0.6 / 0.84; over a stronger scrim it is more opaque still, and never less
// readable than the scrim under it.
//
// The need is measured on a probe of the whole picture as the desk paints
// it (lib/helpdesk/appearance-upload deskArtProbe: scaled to cover a
// 2560 × 1440 screen, blurred σ 8 px like the layer's CSS blur(8px), then
// each of 64 × 40 cells keeps its darkest and its brightest pixel, never an
// average, so a thin bright or dark feature counts at full strength),
// composited the way the browser does (in sRGB) with each mode's surface,
// against the weakest text colours the desk uses on it. Over an
// artwork the desk strengthens the weakest of them (desk-look.css, the
// "inks" below) so that a light picture can stay light:
//
//   light  secondary slate-500 reads as slate-600, accent text as the
//          accent's 800 step, red as red-800, amber as amber-800, green as
//          emerald-800;
//   dark   secondary slate-500 reads as slate-600, accent text mixes the
//          accent's ink with 30% white, red as red-300 (amber and green
//          are already the 300 steps).
//
// The accent varies by workspace, so the accent ink is measured as the
// worst any accent can produce (lib/theme: the 800 step of an AA solid is
// at most about 0.08 luminance; 70% of ink-strong plus 30% white is at
// least 0.5), and the need does not change when the accent does.

export type HdDeskTheme = "light" | "dark";
export type HdDeskLevel = "solid" | "subtle" | "glass";

type Rgb = readonly [number, number, number];

/** The approved levels: the scrim's base alpha, the panel layer's alpha, the panels' backdrop blur (px). */
export const HD_DESK_LEVEL_ALPHA: Record<Exclude<HdDeskLevel, "solid">, { scrim: number; panel: number; blur: number }> = {
  glass: { scrim: 0.38, panel: 0.355, blur: 18 },
  subtle: { scrim: 0.6, panel: 0.6, blur: 10 },
};

/** WCAG AA for normal text. */
export const HD_DESK_AA = 4.5;

/** Above this the picture would be all but hidden in that mode; the admin page says so. */
export const HD_DESK_HEAVY_SCRIM = 0.85;

/** The probe every artwork is measured on (width × height cells, RGB). */
export const HD_DESK_PROBE = { width: 64, height: 40 } as const;

/** Each mode's surface (globals.css --surface). */
export const HD_DESK_SURFACE: Record<HdDeskTheme, Rgb> = {
  light: [255, 255, 255],
  dark: [19, 26, 40],
};

/**
 * The text colours that sit on the glass in each mode, as desk-look.css
 * paints them over an artwork. The accent is the worst case for any accent.
 */
export const HD_DESK_INKS: Record<HdDeskTheme, Record<string, Rgb>> = {
  light: {
    "secondary (slate-600)": [71, 85, 105],
    "accent (800 step, any accent)": [80, 80, 80],
    "red-800": [153, 27, 27],
    "amber-800": [146, 64, 14],
    "emerald-800": [6, 95, 70],
  },
  dark: {
    "secondary (slate-600)": [176, 187, 204],
    "accent (ink + 30% white, any accent)": [187, 187, 187],
    "red-300": [252, 165, 165],
    "amber-300": [252, 211, 77],
    "emerald-300": [110, 231, 183],
  },
};

/** The body text (slate-900 in each mode), reported alongside. */
export const HD_DESK_BODY_INK: Record<HdDeskTheme, Rgb> = {
  light: [15, 23, 42],
  dark: [237, 241, 247],
};

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB colour (0..255 channels, fractions allowed). */
export function luminance(c: Rgb): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}

/** WCAG contrast ratio of two colours. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

/** `top` at `alpha` over `under`, composited in sRGB as browsers do. */
export function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  return [top[0] * alpha + under[0] * (1 - alpha), top[1] * alpha + under[1] * (1 - alpha), top[2] * alpha + under[2] * (1 - alpha)];
}

/** The probe's cells as colours. `rgb` is width × height × 3 bytes. */
export function probeCells(rgb: Uint8Array | Buffer): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i + 2 < rgb.length; i += 3) out.push([rgb[i], rgb[i + 1], rgb[i + 2]]);
  return out;
}

/** The lowest ratio any ink reaches anywhere on the picture under a scrim of `alpha`. */
export function worstRatio(cells: readonly Rgb[], theme: HdDeskTheme, alpha: number, inks: readonly Rgb[] = Object.values(HD_DESK_INKS[theme])): number {
  const surface = HD_DESK_SURFACE[theme];
  let worst = Infinity;
  for (const cell of cells) {
    const ground = over(surface, alpha, cell);
    for (const ink of inks) {
      const r = contrast(ink, ground);
      if (r < worst) worst = r;
    }
  }
  return worst;
}

/**
 * How opaque the scrim must be for every ink to keep AA everywhere on the
 * picture in that mode, rounded up to 0.005. 0 when the bare picture
 * already passes; 1 when nothing short of covering it does.
 */
export function measureNeed(cells: readonly Rgb[], theme: HdDeskTheme): number {
  if (!cells.length) return 1;
  if (worstRatio(cells, theme, 0) >= HD_DESK_AA) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (worstRatio(cells, theme, mid) >= HD_DESK_AA) hi = mid;
    else lo = mid;
  }
  return Math.min(1, Math.ceil(hi * 200) / 200);
}

/** The alphas the desk paints with: the scrim (S), the panel layer (P), and what a panel composes to. */
export interface HdDeskAlphas {
  scrim: number;
  panel: number;
  /** S + P(1 − S): the panel's total cover over the picture. */
  composite: number;
  blur: number;
}

/** The alphas for an artwork with this need at this level (never solid: solid shows no artwork). */
export function deskAlphas(need: number, level: Exclude<HdDeskLevel, "solid">): HdDeskAlphas {
  const base = HD_DESK_LEVEL_ALPHA[level];
  const n = Number.isFinite(need) ? Math.min(1, Math.max(0, need)) : 1;
  const scrim = Math.round(Math.max(base.scrim, n) * 1000) / 1000;
  const composite = Math.round((scrim + base.panel * (1 - scrim)) * 1000) / 1000;
  return { scrim, panel: base.panel, composite, blur: base.blur };
}
