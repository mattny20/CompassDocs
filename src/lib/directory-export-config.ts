// Directory export presets: the admin-defined layouts a PDF or CSV export
// starts from. Stored as one JSON setting rather than a table — a workspace
// has a handful of these, they are edited as a set, and "exactly one is the
// default" is easier to hold in one document than across rows.
//
// The pre-1.2 single "print columns" setting migrates into the first preset
// on first read, so a workspace that had configured its phone list keeps it.

import { getSetting, setSetting } from "./db";
import { listFields, validColumnKeys, type DirectoryField } from "./directory";

export const PAPER_SIZES = ["letter", "a4", "legal"] as const;
export const ORIENTATIONS = ["portrait", "landscape"] as const;
export const DENSITIES = ["compact", "normal", "comfortable"] as const;

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
  sort: string;
  sort_dir: "asc" | "desc";
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
  sort: "name",
  sort_dir: "asc",
  filter: null,
  photos: false,
  pinned_first: false,
  page_numbers: true,
  printed_date: true,
  footer_note: "",
  filename: "",
  is_default: false,
};

const SETTING = "directory_export_presets";
const MAX_PRESETS = 20;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function oneOf<T extends readonly string[]>(list: T, v: unknown, fallback: T[number]): T[number] {
  return (list as readonly string[]).includes(String(v)) ? (String(v) as T[number]) : fallback;
}

/** Coerce untrusted JSON into a preset. Unknown columns are dropped. */
export function sanitizePreset(raw: unknown, fields: DirectoryField[], fallbackId = "preset"): ExportPreset {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const valid = validColumnKeys(fields);
  const columns = Array.isArray(o.columns)
    ? o.columns.map(String).filter((k, i, a) => valid.has(k) && a.indexOf(k) === i)
    : [...PRESET_DEFAULTS.columns].filter((k) => valid.has(k));
  const groupBy = String(o.group_by ?? "").trim();
  const sortKey = String(o.sort ?? "").trim();
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
    group_by: groupBy && fields.some((f) => f.key === groupBy && f.group_by) ? groupBy : "",
    sort: sortKey && valid.has(sortKey) ? sortKey : "name",
    sort_dir: o.sort_dir === "desc" ? "desc" : "asc",
    filter: filterKey && filterValue && valid.has(filterKey) ? { key: filterKey, value: filterValue } : null,
    photos: Boolean(o.photos),
    pinned_first: Boolean(o.pinned_first),
    page_numbers: o.page_numbers === undefined ? true : Boolean(o.page_numbers),
    printed_date: o.printed_date === undefined ? true : Boolean(o.printed_date),
    footer_note: String(o.footer_note ?? "").trim().slice(0, 200),
    filename: slug(String(o.filename ?? "")).slice(0, 60),
    is_default: Boolean(o.is_default),
  };
}

/** All presets, with the legacy print-columns setting folded in on first read. */
export async function listExportPresets(fields?: DirectoryField[]): Promise<ExportPreset[]> {
  const all = fields ?? (await listFields());
  const raw = await getSetting(SETTING);
  let presets: ExportPreset[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) presets = parsed.map((p, i) => sanitizePreset(p, all, `preset-${i + 1}`));
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
  const presets = raw.slice(0, MAX_PRESETS).map((p, i) => sanitizePreset(p, all, `preset-${i + 1}`));
  const seen = new Set<string>();
  const unique = presets.map((p, i) => {
    let id = p.id;
    while (seen.has(id)) id = `${p.id}-${i + 1}`;
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

export async function defaultExportPreset(fields?: DirectoryField[]): Promise<ExportPreset> {
  const presets = await listExportPresets(fields);
  return presets.find((p) => p.is_default) ?? presets[0];
}

export async function getExportPreset(id: string, fields?: DirectoryField[]): Promise<ExportPreset | undefined> {
  return (await listExportPresets(fields)).find((p) => p.id === id);
}
