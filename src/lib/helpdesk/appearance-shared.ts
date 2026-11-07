// Helpdesk 1.19.4: the desk's background artwork, client-safe (mock-ups t1
// to t5; the server is lib/helpdesk/appearance). An admin picks an artwork
// for light mode and one for dark mode (a built-in or one they uploaded)
// and how see-through the desk is (Solid, Subtle, Glass), and may let
// agents choose their own from the desk's user menu: the workspace's, one
// they upload (only they see it), or none, with their own level.
//
// What the desk paints is an HdDeskLook, resolved on the server for the
// person (resolveDeskLook) and by the admin page for its preview, from the
// same alphas (lib/helpdesk/appearance-contrast deskAlphas).

import { deskAlphas, HD_DESK_HEAVY_SCRIM, type HdDeskLevel, type HdDeskTheme } from "./appearance-contrast";

export type { HdDeskLevel, HdDeskTheme } from "./appearance-contrast";

/** A refusal with a sentence for the person and the HTTP status it answers with. */
export class DeskArtError extends Error {
  constructor(
    message: string,
    readonly status = 422
  ) {
    super(message);
  }
}

export const HD_DESK_LEVELS: readonly HdDeskLevel[] = ["solid", "subtle", "glass"];
export const HD_DESK_LEVEL_LABEL: Record<HdDeskLevel, string> = { solid: "Solid", subtle: "Subtle", glass: "Glass" };

export function isDeskLevel(v: unknown): v is HdDeskLevel {
  return v === "solid" || v === "subtle" || v === "glass";
}

/** Uploads: JPG, PNG or WebP up to 8 MB, at least 1920 × 1080 once the camera's rotation is applied. */
export const HD_ART_MAX_BYTES = 8 * 1024 * 1024;
export const HD_ART_MIN = { width: 1920, height: 1080 } as const;
export const HD_ART_MAX_PIXELS = 100_000_000;
/** Landscape only, at most 4:1: the desk shows the picture with `cover` on a landscape screen. */
export const HD_ART_MAX_ASPECT = 4;
/** Ids are Postgres integers: anything larger names nothing (and must not reach a query). */
export const HD_ART_MAX_ID = 2147483647;

export function isArtId(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= HD_ART_MAX_ID;
}
/** The stored WebP widths: 480 for thumbnails, the rest for screens. */
export const HD_ART_WIDTHS = [480, 1280, 1920, 2560] as const;
export type HdArtWidth = (typeof HD_ART_WIDTHS)[number];
/** The workspace library holds at most this many uploads. */
export const HD_ART_LIBRARY_MAX = 12;
/** The accept attribute for the file inputs. */
export const HD_ART_ACCEPT = "image/jpeg,image/png,image/webp";
/** The one line under every upload control. */
export const HD_ART_RULES = "A landscape JPG, PNG or WebP up to 8 MB, at least 1920 × 1080.";

export interface HdBuiltinArt {
  key: "aurora" | "night-ridge" | "sunrise";
  label: string;
  /** Served from public/desk-art. */
  src: string;
  tint: string;
  /** Measured by test/helpdesk-appearance from the SVG (appearance-contrast measureNeed). */
  need: { light: number; dark: number };
}

/**
 * The built-in artworks (public/desk-art, SVG). The needs are the scrim
 * each mode must reach for text to keep 4.5:1 (see appearance-contrast);
 * test/helpdesk-appearance re-measures the files and fails if these drift.
 */
export const HD_DESK_BUILTINS: readonly HdBuiltinArt[] = [
  { key: "aurora", label: "Aurora", src: "/desk-art/aurora.svg", tint: "#a9c6f1", need: { light: 0.51, dark: 0.76 } },
  { key: "night-ridge", label: "Night ridge", src: "/desk-art/night-ridge.svg", tint: "#19244b", need: { light: 0.795, dark: 0.51 } },
  { key: "sunrise", label: "Sunrise", src: "/desk-art/sunrise.svg", tint: "#fdb885", need: { light: 0.54, dark: 0.775 } },
];

/** "none", "builtin:<key>" or "upload:<id>" (a workspace upload). */
export type HdArtRef = string;

export function builtinRef(key: HdBuiltinArt["key"]): HdArtRef {
  return `builtin:${key}`;
}
export function uploadRef(id: number): HdArtRef {
  return `upload:${id}`;
}
export function parseArtRef(v: unknown): { kind: "none" } | { kind: "builtin"; art: HdBuiltinArt } | { kind: "upload"; id: number } | null {
  if (v === "none" || v === "" || v === null || v === undefined) return { kind: "none" };
  if (typeof v !== "string") return null;
  const b = /^builtin:([a-z-]{1,32})$/.exec(v);
  if (b) {
    const art = HD_DESK_BUILTINS.find((a) => a.key === b[1]);
    return art ? { kind: "builtin", art } : null;
  }
  const u = /^upload:([1-9]\d{0,9})$/.exec(v);
  if (u && isArtId(Number(u[1]))) return { kind: "upload", id: Number(u[1]) };
  return null;
}

/** The workspace's choice (settings key helpdesk_appearance). */
export interface HdAppearanceSettings {
  light: HdArtRef;
  dark: HdArtRef;
  level: HdDeskLevel;
  agents_choose: boolean;
}

/**
 * Off until an admin turns it on: an upgrade changes nothing on the desk (no artwork, no
 * "Desk background…" row in the user menu, no uploads by agents).
 */
export const HD_APPEARANCE_DEFAULTS: HdAppearanceSettings = { light: "none", dark: "none", level: "glass", agents_choose: false };

/** An artwork as the pages list it (a built-in or an upload). */
export interface HdArtView {
  ref: HdArtRef;
  label: string;
  builtin: boolean;
  /** The 480px copy, for a thumbnail. */
  thumb: string;
  /** For the desk: one URL (a built-in) or the stored widths. */
  src: string;
  srcset: { w: number; url: string }[] | null;
  tint: string;
  need: { light: number; dark: number };
  /** Uploads only. */
  width?: number;
  height?: number;
  created_at?: string;
  created_by_name?: string;
}

export function builtinView(a: HdBuiltinArt): HdArtView {
  return { ref: builtinRef(a.key), label: a.label, builtin: true, thumb: a.src, src: a.src, srcset: null, tint: a.tint, need: a.need };
}

/** What the desk paints in one mode. */
export interface HdDeskLookSide {
  label: string;
  src: string;
  srcset: { w: number; url: string }[] | null;
  tint: string;
  /** The scrim's alpha over the whole picture. */
  scrim: number;
}

/** What the desk paints: null is the plain desk. */
export interface HdDeskLook {
  level: Exclude<HdDeskLevel, "solid">;
  /** The panel layer's alpha (over the scrim). */
  panel: number;
  /** The panels' backdrop blur, px. */
  blur: number;
  light: HdDeskLookSide | null;
  dark: HdDeskLookSide | null;
}

function side(art: HdArtView | null, theme: HdDeskTheme, level: Exclude<HdDeskLevel, "solid">): HdDeskLookSide | null {
  if (!art) return null;
  const a = deskAlphas(art.need[theme], level);
  return { label: art.label, src: art.src, srcset: art.srcset, tint: art.tint, scrim: a.scrim };
}

/** The look for an artwork per mode at a level (Solid, or no artwork in either mode, is the plain desk). */
export function resolveDeskLook(light: HdArtView | null, dark: HdArtView | null, level: HdDeskLevel): HdDeskLook | null {
  if (level === "solid" || (!light && !dark)) return null;
  const a = deskAlphas(0, level);
  return { level, panel: a.panel, blur: a.blur, light: side(light, "light", level), dark: side(dark, "dark", level) };
}

/** How far above the level's base scrim a picture must be dimmed before the Appearance page says so. */
export const HD_DESK_NOTE_MARGIN = 0.2;

/** A sentence for the admin when a picture must be dimmed hard in a mode, or null. */
export function heavyScrimNote(art: HdArtView | null, theme: HdDeskTheme, level: HdDeskLevel): string | null {
  if (!art || level === "solid") return null;
  const s = deskAlphas(art.need[theme], level).scrim;
  // Only a picture dimmed well beyond the level's own scrim (a dark picture in light mode, a bright one in dark).
  if (s <= deskAlphas(0, level).scrim + HD_DESK_NOTE_MARGIN) return null;
  const pct = Math.round(s * 100);
  return s > HD_DESK_HEAVY_SCRIM
    ? `${art.label} is very ${theme === "dark" ? "bright" : "dark"} for ${theme} mode: the desk covers it ${pct}% so text stays readable.`
    : `In ${theme} mode the desk covers ${art.label} ${pct}% so text stays readable.`;
}

/** An agent's own choice. */
export type HdDeskBgChoice = "workspace" | "own" | "none";
export function isDeskBgChoice(v: unknown): v is HdDeskBgChoice {
  return v === "workspace" || v === "own" || v === "none";
}

/** The admin page's data (GET /api/helpdesk/admin/appearance). */
export interface HdAppearanceAdminView {
  settings: HdAppearanceSettings;
  library: HdArtView[];
  /** Workspace uploads in the library (the limit is HD_ART_LIBRARY_MAX). */
  uploads: number;
}

/** "My desk background" (GET /api/helpdesk/me/appearance). */
export interface HdMyDeskView {
  /** The workspace lets agents choose. */
  allowed: boolean;
  choice: HdDeskBgChoice;
  /** Their own level, or null to follow the workspace's. */
  level: HdDeskLevel | null;
  workspace: { light: string | null; dark: string | null; level: HdDeskLevel };
  own: HdArtView | null;
  /** What the desk paints for them now. */
  look: HdDeskLook | null;
}

/** "Fernwood brand · Night ridge in dark mode", "Night ridge", or null when the workspace has none. */
export function workspaceArtLine(light: string | null, dark: string | null): string | null {
  if (!light && !dark) return null;
  if (light && dark) return light === dark ? light : `${light} · ${dark} in dark mode`;
  return light ? `${light} in light mode` : `${dark} in dark mode`;
}
