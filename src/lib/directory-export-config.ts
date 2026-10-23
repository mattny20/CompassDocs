// Directory export presets: the admin-defined layouts a PDF or CSV export
// starts from. Stored as one JSON setting rather than a table — a workspace
// has a handful of these, they are edited as a set, and "exactly one is the
// default" is easier to hold in one document than across rows.
//
// The pre-1.2 single "print columns" setting migrates into the first preset
// on first read, so a workspace that had configured its phone list keeps it.

import { sanitizeSchedule, stampSchedule, SCHEDULE_OFF, type ExportSchedule } from "./directory-export-schedule-rules";
import { COLUMN_LIMIT, MARGIN_INCHES, MARGIN_PRESETS, type MarginBox, type MarginPreset } from "./directory-export-layout";
import { NAME_FORMAT_KEYS, NAME_SORT_KEYS, assistantDetailKeys, type NameFormat } from "./directory-display";
import { MARKER_LIMIT, listMarkers, type ExportMarker } from "./directory-markers";
import { getSetting, setSetting } from "./db";
import { listFields, validColumnKeys, type DirectoryField } from "./directory";

export const PAPER_SIZES = ["letter", "a4", "legal"] as const;
export const ORIENTATIONS = ["portrait", "landscape"] as const;
export const DENSITIES = ["compact", "normal", "comfortable"] as const;
export { MARGIN_PRESETS, MARGIN_INCHES, COLUMN_LIMIT };
export type { MarginBox, MarginPreset };

export interface ExportPreset {
  id: string;
  name: string;
  /** Document title; "" renders "<Company> directory". */
  title: string;
  subtitle: string;
  paper: (typeof PAPER_SIZES)[number];
  orientation: (typeof ORIENTATIONS)[number];
  density: (typeof DENSITIES)[number];
  logo: boolean;
  columns: string[];
  /** A group_by field key, or "" for one flat list. */
  group_by: string;
  /** The group_by field's values (an option's value, else the raw value) in
   *  the order their sections print; values not listed follow in the field's
   *  own order. Empty, the sections print in the field's order, as every
   *  preset before 1.13.0 did. Always empty when group_by is "". */
  section_order: string[];
  /** Print each section's heads (the option's `heads`) at its top, marked
   *  Head, whatever their own value; off, a head prints only where their
   *  value puts them. True for every preset before 1.13.0. */
  section_heads: boolean;
  sort: string;
  sort_dir: "asc" | "desc";
  /** A second key the sort falls through to — "Office, then Title". "" for none. */
  sort2: string;
  sort2_dir: "asc" | "desc";
  /** Lay the table out in two or three side-by-side columns on each page —
   *  a short table (name, extension) fills a sheet instead of a strip down
   *  the left. */
  page_columns: 1 | 2 | 3;
  /** Shade every other row so the eye keeps its line across a wide page. */
  zebra: boolean;
  /** Only people whose field value matches — e.g. one office's sheet. */
  filter: { key: string; value: string } | null;
  photos: boolean;
  pinned_first: boolean;
  page_numbers: boolean;
  printed_date: boolean;
  /** A footer line such as "Internal use only". */
  footer_note: string;
  /** File name without extension; "" derives one from the name. */
  filename: string;
  /** Close the PDF with the office profiles of every office that appears in it. */
  office_info: boolean;
  /** Office blocks side by side, 1–4 to a row; 1 lays a block's fields two abreast. */
  office_columns: 1 | 2 | 3 | 4;
  /** "table" is the sheet; "cards" is the who's who — photo cards in a grid. */
  layout: "table" | "cards";
  /** Cards to a row in the who's-who layout. */
  cards_per_row: 2 | 3 | 4 | 5;
  /** A group_by field key: one file per value, zipped. "" for one file. */
  split_by: string;
  /** Email the file on a schedule. */
  schedule: ExportSchedule;
  /** Characters per line, per column key; a column listed here wraps its
   *  value after that many characters instead of running on (or, in the
   *  two-/three-column layouts, being cut with an ellipsis). Absent = automatic. */
  column_limits: Record<string, number>;
  /** For the assistant column: the assistant's own fields shown after the
   *  name, e.g. ["phone", "extension"]; keys from assistantDetailKeys. */
  assistant_fields: string[];
  /** Page margins; "normal" is the page every export had before 1.11.1. */
  margins: MarginPreset;
  /** Inches per side, used when margins is "custom"; each 0.2 to 2.0. */
  margin_custom: MarginBox;
  /** Ids of the workspace's export markers this preset prints (a symbol in
   *  front of the name, the key in the footer); see lib/directory-markers. */
  markers: string[];
  /** How the Name column, the cards and assistant names write a name;
   *  "as_written" is the stored name. Sorting never reads this. */
  name_format: NameFormat;
  is_default: boolean;
}

export const PRESET_DEFAULTS: Omit<ExportPreset, "id" | "name"> = {
  title: "",
  subtitle: "",
  paper: "letter",
  orientation: "portrait",
  density: "normal",
  logo: true,
  columns: ["name", "title", "department", "phone", "email"],
  group_by: "",
  section_order: [],
  section_heads: true,
  sort: "name",
  sort_dir: "asc",
  sort2: "",
  sort2_dir: "asc",
  page_columns: 1,
  zebra: true,
  filter: null,
  photos: false,
  pinned_first: false,
  page_numbers: true,
  printed_date: true,
  footer_note: "",
  filename: "",
  office_info: true,
  office_columns: 2,
  layout: "table",
  cards_per_row: 4,
  split_by: "",
  schedule: SCHEDULE_OFF,
  column_limits: {},
  assistant_fields: [],
  margins: "normal",
  margin_custom: { top: 0.5, right: 0.5, bottom: 0.6, left: 0.5 },
  markers: [],
  name_format: "as_written",
  is_default: false,
};

const SETTING = "directory_export_presets";
const MAX_PRESETS = 20;
/** A section order lists at most this many values, each at most SECTION_VALUE_MAX characters (an option's length). */
export const SECTION_ORDER_LIMIT = 200;
const SECTION_VALUE_MAX = 120;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function oneOf<T extends readonly string[]>(list: T, v: unknown, fallback: T[number]): T[number] {
  return (list as readonly string[]).includes(String(v)) ? (String(v) as T[number]) : fallback;
}

/** Column limits: the preset's own columns only, each a whole number of characters in range; 0 or junk is dropped (automatic). */
function sanitizeColumnLimits(raw: unknown, valid: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!valid.has(key)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    out[key] = Math.min(COLUMN_LIMIT.max, Math.max(COLUMN_LIMIT.min, Math.round(n)));
  }
  return out;
}

/**
 * A section order: group values as strings, trimmed, blanks dropped, cut to
 * 120 characters, each once (case-insensitively, as groupPeople files a
 * value), at most 200. A value no section has is kept: it is harmless and
 * the editor shows only the sections that exist.
 */
function sanitizeSectionOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    const s = String(v).trim().slice(0, SECTION_VALUE_MAX);
    const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= SECTION_ORDER_LIMIT) break;
  }
  return out;
}

/** Custom margins in inches, each side clamped to the allowed range at one decimal; a missing side keeps its default. */
function sanitizeMarginCustom(raw: unknown): MarginBox {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const side = (k: keyof MarginBox): number => {
    const v = o[k];
    const n = v === "" || v == null ? Number.NaN : Number(v);
    if (!Number.isFinite(n)) return PRESET_DEFAULTS.margin_custom[k];
    return Math.round(Math.min(MARGIN_INCHES.max, Math.max(MARGIN_INCHES.min, n)) * 10) / 10;
  };
  return { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
}

/**
 * Coerce untrusted JSON into a preset. Unknown columns are dropped, as are
 * marker ids outside `markerIds` (the stored markers) when it is given; a
 * caller without the store keeps any non-blank id.
 */
export function sanitizePreset(raw: unknown, fields: DirectoryField[], fallbackId = "preset", markerIds?: ReadonlySet<string>): ExportPreset {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const valid = validColumnKeys(fields);
  // A sort may also use the virtual first-/last-name keys; a column may not.
  const sortable = new Set<string>([...valid, ...NAME_SORT_KEYS.map((k) => k.key)]);
  const detailKeys = new Set(assistantDetailKeys(fields).map((c) => c.key));
  const columns = Array.isArray(o.columns)
    ? o.columns.map(String).filter((k, i, a) => valid.has(k) && a.indexOf(k) === i)
    : [...PRESET_DEFAULTS.columns].filter((k) => valid.has(k));
  const groupByRaw = String(o.group_by ?? "").trim();
  const groupBy = groupByRaw && fields.some((f) => f.key === groupByRaw && f.group_by) ? groupByRaw : "";
  const sortKey = String(o.sort ?? "").trim();
  const sort2Key = String(o.sort2 ?? "").trim();
  const filterRaw = o.filter && typeof o.filter === "object" ? (o.filter as Record<string, unknown>) : null;
  const filterKey = String(filterRaw?.key ?? "").trim();
  const filterValue = String(filterRaw?.value ?? "").trim().slice(0, 120);
  const name = String(o.name ?? "").trim().slice(0, 60) || "Directory";
  return {
    id: String(o.id ?? "").trim().slice(0, 40) || slug(name) || fallbackId,
    name,
    title: String(o.title ?? "").trim().slice(0, 120),
    subtitle: String(o.subtitle ?? "").trim().slice(0, 200),
    paper: oneOf(PAPER_SIZES, o.paper, PRESET_DEFAULTS.paper),
    orientation: oneOf(ORIENTATIONS, o.orientation, PRESET_DEFAULTS.orientation),
    density: oneOf(DENSITIES, o.density, PRESET_DEFAULTS.density),
    logo: o.logo === undefined ? PRESET_DEFAULTS.logo : Boolean(o.logo),
    columns: columns.length ? columns : ["name"],
    group_by: groupBy,
    // An order belongs to its field: with no sections there is nothing to
    // order (the editor clears it when the field changes).
    section_order: groupBy ? sanitizeSectionOrder(o.section_order) : [],
    // On unless switched off: a preset stored before 1.13.0 prints its heads
    // first the moment a field gets any.
    section_heads: o.section_heads === undefined ? true : Boolean(o.section_heads),
    sort: sortKey && sortable.has(sortKey) ? sortKey : "name",
    sort_dir: o.sort_dir === "desc" ? "desc" : "asc",
    sort2: sort2Key && sortable.has(sort2Key) && sort2Key !== sortKey ? sort2Key : "",
    sort2_dir: o.sort2_dir === "desc" ? "desc" : "asc",
    page_columns: Number(o.page_columns) === 3 ? 3 : Number(o.page_columns) === 2 ? 2 : 1,
    zebra: o.zebra === undefined ? true : Boolean(o.zebra),
    filter: filterKey && filterValue && valid.has(filterKey) ? { key: filterKey, value: filterValue } : null,
    photos: Boolean(o.photos),
    pinned_first: Boolean(o.pinned_first),
    page_numbers: o.page_numbers === undefined ? true : Boolean(o.page_numbers),
    printed_date: o.printed_date === undefined ? true : Boolean(o.printed_date),
    footer_note: String(o.footer_note ?? "").trim().slice(0, 200),
    filename: slug(String(o.filename ?? "")).slice(0, 60),
    office_info: o.office_info === undefined ? true : Boolean(o.office_info),
    office_columns: ([1, 2, 3, 4].includes(Number(o.office_columns)) ? Number(o.office_columns) : 2) as 1 | 2 | 3 | 4,
    layout: o.layout === "cards" ? "cards" : "table",
    cards_per_row: ([2, 3, 4, 5].includes(Number(o.cards_per_row)) ? Number(o.cards_per_row) : 4) as 2 | 3 | 4 | 5,
    split_by: (() => {
      const k = String(o.split_by ?? "").trim();
      return k && fields.some((f) => f.key === k && f.group_by) ? k : "";
    })(),
    schedule: sanitizeSchedule(o.schedule),
    // Scoped to the columns the preset shows: a column removed and added
    // back later starts automatic, and a "what I see" export carries no
    // limit for a column it does not print.
    column_limits: sanitizeColumnLimits(o.column_limits, new Set(columns.length ? columns : ["name"])),
    assistant_fields: Array.isArray(o.assistant_fields)
      ? o.assistant_fields.map(String).filter((k, i, a) => detailKeys.has(k) && a.indexOf(k) === i)
      : [],
    margins: oneOf(MARGIN_PRESETS, o.margins, PRESET_DEFAULTS.margins),
    margin_custom: sanitizeMarginCustom(o.margin_custom),
    markers: Array.isArray(o.markers)
      ? o.markers
          .map((k) => String(k).trim())
          .filter((k, i, a) => (markerIds ? markerIds.has(k) : k !== "") && a.indexOf(k) === i)
          .slice(0, MARKER_LIMIT)
      : [],
    name_format: oneOf(NAME_FORMAT_KEYS, o.name_format, PRESET_DEFAULTS.name_format),
    is_default: Boolean(o.is_default),
  };
}

/** The ids a preset may list: the stored markers', loaded once per call unless the caller has them. */
async function markerIdSet(fields: DirectoryField[], markers?: ExportMarker[]): Promise<Set<string>> {
  return new Set((markers ?? (await listMarkers(fields))).map((m) => m.id));
}

/** All presets, with the legacy print-columns setting folded in on first read. */
export async function listExportPresets(fields?: DirectoryField[], markers?: ExportMarker[]): Promise<ExportPreset[]> {
  const all = fields ?? (await listFields());
  const raw = await getSetting(SETTING);
  let presets: ExportPreset[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const ids = await markerIdSet(all, markers);
        presets = parsed.map((p, i) => sanitizePreset(p, all, `preset-${i + 1}`, ids));
      }
    } catch {}
  }
  if (presets.length === 0) {
    // Migrate: the one column list an admin may have set before presets existed.
    let columns = [...PRESET_DEFAULTS.columns];
    const legacy = await getSetting("directory_print_columns");
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy);
        if (Array.isArray(parsed) && parsed.length) columns = parsed.map(String);
      } catch {}
    }
    presets = [
      sanitizePreset({ ...PRESET_DEFAULTS, id: "phone-directory", name: "Phone directory", columns, is_default: true }, all),
    ];
  }
  // Exactly one default, and unique ids.
  const seen = new Set<string>();
  presets = presets.map((p, i) => {
    let id = p.id;
    while (seen.has(id)) id = `${p.id}-${i + 1}`;
    seen.add(id);
    return { ...p, id };
  });
  if (!presets.some((p) => p.is_default)) presets[0] = { ...presets[0], is_default: true };
  return presets;
}

export async function saveExportPresets(raw: unknown, fields?: DirectoryField[]): Promise<ExportPreset[]> {
  const all = fields ?? (await listFields());
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("At least one export preset is required.");
  const markers = await listMarkers(all);
  const ids = await markerIdSet(all, markers);
  // A schedule that was just set, or moved, starts from now: its first send
  // is the next slot, not the one that already passed this period.
  const before = new Map((await listExportPresets(all, markers)).map((p) => [p.id, p]));
  const now = new Date();
  const presets = raw.slice(0, MAX_PRESETS).map((p, i) => {
    const s = sanitizePreset(p, all, `preset-${i + 1}`, ids);
    return { ...s, schedule: stampSchedule(s.schedule, before.get(s.id)?.schedule, now) };
  });
  const seen = new Set<string>();
  const unique = presets.map((p, i) => {
    let id = p.id;
    // Counts on past a suffix that is itself taken (["a", "a-3", "a"] used
    // to retry "a-3" forever).
    let n = i + 1;
    while (seen.has(id)) id = `${p.id}-${n++}`;
    seen.add(id);
    return { ...p, id };
  });
  let defaults = unique.filter((p) => p.is_default).length;
  const normalized = unique.map((p) => {
    if (p.is_default && defaults > 1) {
      defaults--;
      return { ...p, is_default: false };
    }
    return p;
  });
  if (!normalized.some((p) => p.is_default)) normalized[0] = { ...normalized[0], is_default: true };
  await setSetting(SETTING, JSON.stringify(normalized));
  return normalized;
}

export async function defaultExportPreset(fields?: DirectoryField[], markers?: ExportMarker[]): Promise<ExportPreset> {
  const presets = await listExportPresets(fields, markers);
  return presets.find((p) => p.is_default) ?? presets[0];
}

export async function getExportPreset(id: string, fields?: DirectoryField[], markers?: ExportMarker[]): Promise<ExportPreset | undefined> {
  return (await listExportPresets(fields, markers)).find((p) => p.id === id);
}
