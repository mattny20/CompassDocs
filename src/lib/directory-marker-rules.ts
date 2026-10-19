// Directory export markers, the pure half: a marker is a symbol printed in
// front of a person's name on an export (the PDF's table and cards, the CSV's
// name column) when the person matches a field value — "*" for a public
// notary, "†" for a partner — with a key in the PDF's footer. The
// definitions are workspace-level (lib/directory-markers holds the store);
// each preset picks which of them it prints.
//
// Client-safe: the Markers card validates with the same rules the PUT route
// refuses with, so what is typed is what is saved. The matching is the
// export filter's (matchesValue), so "Office = Phoenix" means one thing.

import { assistantDetailKeys, cellValue, matchesValue, type FieldLike, type PersonLike } from "./directory-display";

export interface ExportMarker {
  id: string;
  /** What the key calls it: "Public notary". */
  label: string;
  /** One to three printable characters: "*", "†", "¹". */
  symbol: string;
  /** The field read: any column but the name and the link columns. */
  key: string;
  /** The value that earns the mark, matched as the export filter matches;
   *  "" marks everyone who has any value. */
  value: string;
}

/** The symbols the card offers; "Other…" takes any printable character. */
export const MARKER_SYMBOLS = ["*", "†", "‡", "§", "¶", "•", "°", "¹", "²", "³", "^", "~", "+", "#"] as const;

export const MARKER_LIMIT = 24;
export const MARKER_LABEL_MAX = 40;
export const MARKER_SYMBOL_MAX = 3;
export const MARKER_VALUE_MAX = 120;

/** What the key prints between markers. */
export const MARKER_KEY_SEPARATOR = "  ·  ";

/**
 * Beyond ASCII, the Latin-1 symbols the built-in Helvetica prints (WinAnsi):
 * the renderer embeds no font, so anything outside this set comes out as a
 * blank or a box on paper. Accented Latin-1 letters (U+00C0–U+00FF) print too.
 */
const WINANSI_SYMBOLS = "†‡§¶•°¹²³ªº‰©®™¿¡«»";

/** True when every character of `s` is one the PDF's Helvetica can print. */
export function printableSymbol(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xc0 && c <= 0xff) continue;
    if (WINANSI_SYMBOLS.includes(ch)) continue;
    return false;
  }
  return true;
}

/** The fields a marker may read: any column but the name and the link columns (the list assistantDetailKeys keeps). */
export function markerFields(fields: FieldLike[]): { key: string; label: string }[] {
  return assistantDetailKeys(fields);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export interface MarkerProblem {
  /** The control at fault. */
  field: "label" | "symbol" | "key" | "value";
  /** The sentence the route answers with and the card shows: `Marker "Public notary": the symbol "★" cannot be printed.` */
  message: string;
}

/**
 * The first thing wrong with one marker as typed, or nothing. `index` names
 * a marker that has no name yet; `keys` are the eligible field keys.
 */
export function markerProblem(raw: unknown, index: number, keys: ReadonlySet<string>): MarkerProblem | undefined {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const label = String(o.label ?? "").trim();
  const symbol = String(o.symbol ?? "").trim();
  const key = String(o.key ?? "").trim();
  const value = String(o.value ?? "").trim();
  const who = label ? `Marker "${label}"` : `Marker ${index + 1}`;
  if (!label) return { field: "label", message: `${who}: give it a name.` };
  if (label.length > MARKER_LABEL_MAX) return { field: "label", message: `${who}: the name is longer than ${MARKER_LABEL_MAX} characters.` };
  if (!symbol) return { field: "symbol", message: `${who}: pick a symbol.` };
  if ([...symbol].length > MARKER_SYMBOL_MAX) return { field: "symbol", message: `${who}: the symbol is longer than ${MARKER_SYMBOL_MAX} characters.` };
  if (!printableSymbol(symbol)) return { field: "symbol", message: `${who}: the symbol "${symbol}" cannot be printed.` };
  if (!key || !keys.has(key)) return { field: "key", message: `${who}: pick a field.` };
  if (value.length > MARKER_VALUE_MAX) return { field: "value", message: `${who}: the value is longer than ${MARKER_VALUE_MAX} characters.` };
  return undefined;
}

/** The first problem in a list of markers as typed, or nothing; what saveMarkers refuses with. */
export function markersProblem(raw: unknown, fields: FieldLike[]): string | undefined {
  if (!Array.isArray(raw)) return "Send the markers as a list.";
  if (raw.length > MARKER_LIMIT) return `Up to ${MARKER_LIMIT} markers.`;
  const keys = new Set(markerFields(fields).map((f) => f.key));
  for (let i = 0; i < raw.length; i++) {
    const problem = markerProblem(raw[i], i, keys);
    if (problem) return problem.message;
  }
  return undefined;
}

/**
 * Coerce untrusted JSON into markers: at most MARKER_LIMIT; a label of 1..40
 * characters; a symbol of 1..3 printable characters; a field key markers
 * may read; a value of up to 120 characters. Anything short of that is
 * dropped. Ids are unique slugs, assigned in two passes: every stored id is
 * reserved first (presets refer to it, so a new marker whose label slugs to
 * one never takes it, wherever it sits in the list; a stored id given twice
 * keeps its first holder), then a new marker's id comes from its label,
 * suffixed past anything in use.
 */
export function sanitizeMarkers(raw: unknown, fields: FieldLike[]): ExportMarker[] {
  if (!Array.isArray(raw)) return [];
  const keys = new Set(markerFields(fields).map((f) => f.key));
  const kept: ExportMarker[] = [];
  for (const item of raw.slice(0, MARKER_LIMIT)) {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const label = String(o.label ?? "").trim().slice(0, MARKER_LABEL_MAX);
    const symbol = String(o.symbol ?? "").trim();
    const key = String(o.key ?? "").trim();
    const value = String(o.value ?? "").trim().slice(0, MARKER_VALUE_MAX);
    if (!label || !symbol || [...symbol].length > MARKER_SYMBOL_MAX || !printableSymbol(symbol) || !keys.has(key)) continue;
    kept.push({ id: slug(String(o.id ?? "")), label, symbol, key, value });
  }
  const seen = new Set<string>();
  for (const m of kept) {
    if (m.id && !seen.has(m.id)) seen.add(m.id);
    else m.id = "";
  }
  return kept.map((m, i) => {
    if (m.id) return m;
    const base = slug(m.label) || `marker-${i + 1}`;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
    seen.add(id);
    return { ...m, id };
  });
}

/**
 * The markers a viewer's export may print: those whose field the viewer may
 * see. A marker on a restricted column (a mobile number for admins only)
 * would mark no one, since the value is redacted, but its label would still
 * show in the footer key and the CSV's Markers column; so it goes with the
 * column. Admins have no hidden keys and keep every marker.
 */
export function markersForViewer(markers: ExportMarker[], hidden: ReadonlySet<string>): ExportMarker[] {
  return hidden.size ? markers.filter((m) => !hidden.has(m.key)) : markers;
}

/** Does this person earn this marker? A blank value marks anyone with a value. */
export function marked(p: PersonLike, marker: ExportMarker, fields: FieldLike[]): boolean {
  if (!marker.value) return cellValue(p, marker.key, fields).trim() !== "";
  return matchesValue(p, marker.key, marker.value, fields);
}

/** The markers a person earns, in the markers' own order. */
export function markersFor(p: PersonLike, markers: ExportMarker[], fields: FieldLike[]): ExportMarker[] {
  return markers.filter((m) => marked(p, m, fields));
}

/** The symbols before a person's name, joined: "*†"; "" when none. */
export function markerPrefix(p: PersonLike, markers: ExportMarker[], fields: FieldLike[]): string {
  return markersFor(p, markers, fields)
    .map((m) => m.symbol)
    .join("");
}

/** The footer's key: "* Public notary  ·  † Partner"; "" when there are no markers. */
export function markerKeyLine(markers: ExportMarker[]): string {
  return markers.map((m) => `${m.symbol} ${m.label}`).join(MARKER_KEY_SEPARATOR);
}
