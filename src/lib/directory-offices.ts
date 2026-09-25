// Office profiles: what a workspace knows about each office beyond the people
// in it — the street address, the main line and fax, where to park, the
// shared rooms' phones and mailboxes. Admins define the fields once and fill
// them per office; a PDF export then closes with a block for every office
// that appears in it, so a printed sheet for the Phoenix office carries the
// Phoenix address without anyone typing it into the preset.
//
// Pure module: types, defaults, sanitising and matching. Loading and saving
// live in directory-offices-store.ts so this can be imported by the client.

import { resolveValue, type FieldLike } from "./directory-display";

export interface OfficeField {
  key: string;
  label: string;
  /** Renders as a multi-line block (addresses, parking notes, room lists). */
  multiline: boolean;
}

export interface OfficeProfile {
  /** The office as the directory knows it: the option value when Office has
   *  options, else the raw value people carry. Compared case-insensitively. */
  office: string;
  /** Display name for the block; "" uses the option label or the value. */
  name: string;
  values: Record<string, string>;
}

export interface OfficeConfig {
  fields: OfficeField[];
  profiles: OfficeProfile[];
}

export const DEFAULT_OFFICE_FIELDS: OfficeField[] = [
  { key: "address", label: "Address", multiline: true },
  { key: "main_phone", label: "Main phone", multiline: false },
  { key: "fax", label: "Fax", multiline: false },
  { key: "hours", label: "Hours", multiline: false },
  { key: "parking", label: "Parking", multiline: true },
  { key: "shared", label: "Shared spaces", multiline: true },
];

export const MAX_OFFICE_FIELDS = 30;
export const MAX_OFFICES = 200;
const MAX_VALUE = 2000;

export function slugifyOfficeKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

/** Coerce untrusted JSON into a config; unknown keys in a profile are dropped. */
export function sanitizeOfficeConfig(raw: unknown): OfficeConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fields: OfficeField[] = [];
  const seenKeys = new Set<string>();
  const rawFields = Array.isArray(o.fields) ? o.fields : DEFAULT_OFFICE_FIELDS;
  for (const f of rawFields) {
    if (!f || typeof f !== "object") continue;
    const fo = f as Record<string, unknown>;
    const label = String(fo.label ?? "").trim().slice(0, 60);
    if (!label) continue;
    let key = slugifyOfficeKey(String(fo.key ?? "")) || slugifyOfficeKey(label);
    if (!key) continue;
    let n = 2;
    while (seenKeys.has(key)) key = `${key}_${n++}`;
    seenKeys.add(key);
    fields.push({ key, label, multiline: Boolean(fo.multiline) });
    if (fields.length >= MAX_OFFICE_FIELDS) break;
  }

  const profiles: OfficeProfile[] = [];
  const seenOffices = new Set<string>();
  for (const p of Array.isArray(o.profiles) ? o.profiles : []) {
    if (!p || typeof p !== "object") continue;
    const po = p as Record<string, unknown>;
    const office = String(po.office ?? "").trim().slice(0, 120);
    if (!office || seenOffices.has(office.toLowerCase())) continue;
    seenOffices.add(office.toLowerCase());
    const values: Record<string, string> = {};
    const vo = (po.values && typeof po.values === "object" ? po.values : {}) as Record<string, unknown>;
    for (const f of fields) {
      const v = String(vo[f.key] ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_VALUE);
      if (v) values[f.key] = v;
    }
    profiles.push({ office, name: String(po.name ?? "").trim().slice(0, 80), values });
    if (profiles.length >= MAX_OFFICES) break;
  }
  return { fields, profiles };
}

/**
 * The office a person belongs to, as a profile would name it: the matched
 * option's value when Office has options (so "phx" and "PHX1 – Phoenix" both
 * resolve to PHX1), else the raw value trimmed. "" when they have none.
 */
export function officeKeyOf(rawOffice: string, officeField: Pick<FieldLike, "options" | "value_format"> | undefined): string {
  const raw = String(rawOffice ?? "").trim();
  if (!raw) return "";
  if (!officeField) return raw;
  const r = resolveValue(officeField, raw);
  return r.index === Number.POSITIVE_INFINITY ? r.raw : r.value;
}

/** The profile for an office key, matched case-insensitively. */
export function officeProfileFor(config: OfficeConfig, officeKey: string): OfficeProfile | undefined {
  const k = officeKey.trim().toLowerCase();
  if (!k) return undefined;
  return config.profiles.find((p) => p.office.toLowerCase() === k);
}

/** Does a profile say anything at all? Empty ones are skipped on paper. */
export function profileHasContent(profile: OfficeProfile, fields: OfficeField[]): boolean {
  return fields.some((f) => (profile.values[f.key] ?? "").trim() !== "");
}

export interface OfficeBlock {
  name: string;
  /** How many of the given people belong to it. */
  count: number;
  rows: { label: string; value: string; multiline: boolean }[];
}

/**
 * The office blocks for a set of people: one per office that at least one of
 * them belongs to and that has a profile with something in it. Ordered the
 * way the Office field's options are, so the main office leads; offices with
 * no option follow in the order people appear.
 */
export function officeBlocksFor(
  people: { office: string }[],
  officeField: Pick<FieldLike, "options" | "value_format"> | undefined,
  config: OfficeConfig | undefined
): OfficeBlock[] {
  if (!config || config.profiles.length === 0) return [];
  const counts = new Map<string, number>();
  for (const p of people) {
    const key = officeKeyOf(p.office, officeField);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const order = new Map<string, number>();
  (officeField?.options ?? []).forEach((o, i) => order.set(o.value.toLowerCase(), i));
  const keys = [...counts.keys()].sort((a, b) => {
    const ia = order.get(a.toLowerCase()) ?? Number.POSITIVE_INFINITY;
    const ib = order.get(b.toLowerCase()) ?? Number.POSITIVE_INFINITY;
    return ia - ib;
  });
  const out: OfficeBlock[] = [];
  for (const key of keys) {
    const profile = officeProfileFor(config, key);
    if (!profile || !profileHasContent(profile, config.fields)) continue;
    const block = officeBlock(profile, config.fields, officeField);
    out.push({ name: block.name, count: counts.get(key) ?? 0, rows: block.rows });
  }
  return out;
}

/** What a profile's block shows: its display name and the filled fields in order. */
export function officeBlock(
  profile: OfficeProfile,
  fields: OfficeField[],
  officeField: Pick<FieldLike, "options" | "value_format"> | undefined
): { name: string; rows: { label: string; value: string; multiline: boolean }[] } {
  let name = profile.name.trim();
  if (!name) {
    const r = officeField ? resolveValue(officeField, profile.office) : null;
    name = r && r.index !== Number.POSITIVE_INFINITY ? r.label : profile.office;
  }
  const rows = fields
    .filter((f) => (profile.values[f.key] ?? "").trim() !== "")
    .map((f) => ({ label: f.label, value: profile.values[f.key].trim(), multiline: f.multiline }));
  return { name, rows };
}
