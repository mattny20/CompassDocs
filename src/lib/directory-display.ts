// Directory display helpers — client-safe, shared by the directory page, the
// admin console, the profile page, and the PDF/CSV export, so a value renders
// the same way everywhere: "PHX1 – Phoenix" in a card is "PHX1 – Phoenix" on
// paper.
//
// Options are resolved at read time and raw values stay stored. Relabelling an
// office or adding a synonym to a position takes effect immediately, with no
// resync and no rewrite of anyone's row.

export type FieldKind = "text" | "choice" | "people";
export type FieldDisplay = "field" | "tag" | "phone";
export type ValueFormat = "raw" | "label" | "code_label";

export interface FieldOption {
  value: string;
  label?: string;
  /** Raw values that fold into this option. `*` is a wildcard at either end. */
  matches?: string[];
  /** A chip colour name (see CHIP_COLORS). */
  color?: string;
  /** Excluded from grouped views and the filter menu. */
  hidden?: boolean;
}

/** The shape every consumer needs; DirectoryField satisfies it. */
export interface FieldLike {
  key: string;
  label: string;
  kind: FieldKind;
  multi: number;
  builtin: number;
  group_by: number;
  options: FieldOption[];
  value_format: ValueFormat;
  display: FieldDisplay;
  show_with: string;
  highlight: number;
  inverse_label: string;
  show_in_card: number;
}

export interface LinkRef {
  id: number;
  name: string;
}

/** The person shape the helpers read; DirectoryPerson satisfies it. */
export interface PersonLike {
  id: number;
  name: string;
  title: string;
  department: string;
  email: string;
  phone: string;
  mobile: string;
  office: string;
  custom: Record<string, string>;
  links?: Record<string, LinkRef[]>;
  linked_by?: Record<string, LinkRef[]>;
  pin_order?: number | null;
}

/** Keys that are columns on directory_people, or derived from links. */
export const BUILTIN_COLUMN_KEYS = ["name", "title", "department", "email", "phone", "mobile", "office"] as const;

export const CHIP_COLORS: Record<string, string> = {
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  accent: "border border-compass-200 bg-compass-50 text-compass-700 dark:border-compass-100 dark:text-compass-300",
  emerald: "bg-emerald-100 text-emerald-700",
  amber: "bg-amber-100 text-amber-700",
  red: "bg-red-100 text-red-700",
  sky: "bg-sky-100 text-sky-700",
  violet: "bg-violet-100 text-violet-700",
};

export function splitMulti(value: string): string[] {
  return String(value ?? "")
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** The option a raw value belongs to, and its position in the admin's order. */
export function matchOption(field: Pick<FieldLike, "options">, raw: string): { option?: FieldOption; index: number } {
  const v = String(raw ?? "").trim();
  if (!v) return { index: Number.POSITIVE_INFINITY };
  const options = field.options ?? [];
  const lower = v.toLowerCase();
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (o.value.toLowerCase() === lower || (o.label ?? "").toLowerCase() === lower) return { option: o, index: i };
  }
  for (let i = 0; i < options.length; i++) {
    for (const m of options[i].matches ?? []) {
      if (!m) continue;
      if (m.includes("*") ? globToRegExp(m).test(v) : m.toLowerCase() === lower) return { option: options[i], index: i };
    }
  }
  return { index: Number.POSITIVE_INFINITY };
}

export interface ResolvedValue {
  raw: string;
  /** Canonical option value (or the raw value when unmatched). */
  value: string;
  label: string;
  index: number;
  color?: string;
  hidden: boolean;
}

/** Resolve one token against a field's options. */
export function resolveValue(field: Pick<FieldLike, "options" | "value_format">, raw: string): ResolvedValue {
  const { option, index } = matchOption(field, raw);
  const v = String(raw ?? "").trim();
  if (!option) return { raw: v, value: v, label: v, index, hidden: false };
  const label = option.label?.trim() || option.value;
  return { raw: v, value: option.value, label, index, color: option.color, hidden: Boolean(option.hidden) };
}

/** Every token of a value, resolved, in stored order. */
export function resolveValues(field: Pick<FieldLike, "options" | "value_format" | "multi">, raw: string): ResolvedValue[] {
  const tokens = field.multi ? splitMulti(raw) : String(raw ?? "").trim() ? [String(raw).trim()] : [];
  return tokens.map((t) => resolveValue(field, t));
}

/** One token, formatted per the field's value_format. */
export function formatValue(field: Pick<FieldLike, "options" | "value_format">, raw: string): string {
  const r = resolveValue(field, raw);
  if (r.index === Number.POSITIVE_INFINITY) return r.raw;
  switch (field.value_format) {
    case "label":
      return r.label;
    case "code_label":
      return r.label.toLowerCase() === r.value.toLowerCase() ? r.label : `${r.value} – ${r.label}`;
    default:
      return r.raw;
  }
}

/** The whole value as one display string. */
export function displayValue(field: Pick<FieldLike, "options" | "value_format" | "multi">, raw: string): string {
  return resolveValues(field, raw)
    .map((r) => formatValue(field, r.raw))
    .join(", ");
}

/** A person's stored value for a field key: built-in column, link names, or custom. */
export function rawValue(p: PersonLike, key: string): string {
  switch (key) {
    case "name":
      return p.name;
    case "title":
      return p.title;
    case "department":
      return p.department;
    case "email":
      return p.email;
    case "phone":
      return p.phone;
    case "mobile":
      return p.mobile;
    case "office":
      return p.office;
    default:
      return p.custom?.[key] ?? "";
  }
}

/** Names on the other end of a people field, either direction. */
export function linkNames(p: PersonLike, key: string, direction: "out" | "in" = "out"): string {
  const list = direction === "out" ? p.links?.[key] : p.linked_by?.[key];
  return (list ?? []).map((l) => l.name).join(", ");
}

/**
 * What to show for a column key — resolves `assists`-style inverse keys
 * (`<field>:in`), people fields, and option formatting, in one place.
 */
export function cellValue(p: PersonLike, key: string, fields: FieldLike[]): string {
  if (key === "assists") return linkNames(p, "assistant", "in");
  if (key.endsWith(":in")) return linkNames(p, key.slice(0, -3), "in");
  const field = fields.find((f) => f.key === key);
  if (field?.kind === "people") return linkNames(p, key, "out");
  const raw = rawValue(p, key);
  return field ? displayValue(field, raw) : raw;
}

export interface Group<P extends PersonLike> {
  key: string;
  label: string;
  index: number;
  members: P[];
}

/**
 * Split people into sections by a field, in the admin's option order.
 *
 * Options come first in their configured order; raw values that match no
 * option follow alphabetically (a new department is never lost, only unsorted);
 * people with no value go last under "No <field>". A multi-valued field lists a
 * person under every group they belong to. Hidden options are dropped.
 */
export function groupPeople<P extends PersonLike>(people: P[], field: FieldLike): Group<P>[] {
  const groups = new Map<string, Group<P>>();
  const empty: P[] = [];
  for (const p of people) {
    const resolved = resolveValues(field, rawValue(p, field.key)).filter((r) => !r.hidden);
    if (resolved.length === 0) {
      empty.push(p);
      continue;
    }
    const seen = new Set<string>();
    for (const r of resolved) {
      const gkey = r.value.toLowerCase();
      if (seen.has(gkey)) continue;
      seen.add(gkey);
      let g = groups.get(gkey);
      if (!g) {
        // A matched value is labelled by its OPTION (formatted per the field),
        // never by the alias that matched — "Partner" files under Attorney.
        g = {
          key: r.value,
          label: r.index === Number.POSITIVE_INFINITY ? r.raw : formatValue(field, r.value),
          index: r.index,
          members: [],
        };
        groups.set(gkey, g);
      }
      g.members.push(p);
    }
  }
  const out = [...groups.values()].sort(
    (a, b) => a.index - b.index || a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
  );
  if (empty.length) out.push({ key: "", label: `No ${field.label.toLowerCase()}`, index: Number.POSITIVE_INFINITY, members: empty });
  return out;
}

/**
 * Order people by a field: option order first when the field has options,
 * then the display value, then name — so "Attorney" precedes "Paralegal"
 * because the admin said so, not because of the alphabet.
 */
export function comparePeople(fields: FieldLike[], sortKey: string, dir: 1 | -1 = 1) {
  const field = fields.find((f) => f.key === sortKey);
  return (a: PersonLike, b: PersonLike): number => {
    const va = cellValue(a, sortKey, fields);
    const vb = cellValue(b, sortKey, fields);
    // Empties last regardless of direction — a blank office is not "before A".
    if (!va !== !vb) return va ? -1 : 1;
    if (field && field.options.length) {
      const ra = resolveValues(field, rawValue(a, sortKey))[0];
      const rb = resolveValues(field, rawValue(b, sortKey))[0];
      const ia = ra?.index ?? Number.POSITIVE_INFINITY;
      const ib = rb?.index ?? Number.POSITIVE_INFINITY;
      if (ia !== ib) return (ia < ib ? -1 : 1) * dir;
    }
    const c = va.localeCompare(vb, undefined, { sensitivity: "base" });
    if (c !== 0) return c * dir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) * dir;
  };
}

/** Pinned people first (by pin_order), then everyone else in the given order. */
export function pinnedFirst<P extends PersonLike>(people: P[]): { pinned: P[]; rest: P[] } {
  const pinned = people
    .filter((p) => p.pin_order != null)
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0) || a.name.localeCompare(b.name));
  const rest = people.filter((p) => p.pin_order == null);
  return { pinned, rest };
}

/**
 * Avatar/initials fallback. "Smith, Jane" reads JS; honorifics and suffixes
 * are dropped; up to three letters so timekeeper-style initials fit.
 */
export function initialsOf(name: string): string {
  let n = String(name ?? "").trim();
  if (!n) return "";
  if (n.includes(",")) {
    const [last, rest] = n.split(",", 2);
    if (rest && !/^\s*(esq|jr|sr|ii|iii|iv|phd|md|cpa)\.?\s*$/i.test(rest)) n = `${rest.trim()} ${last.trim()}`;
    else n = last.trim();
  }
  return n
    .split(/\s+/)
    .filter((w) => w && !/^(mr|mrs|ms|dr|prof|esq|jr|sr|ii|iii|iv)\.?$/i.test(w))
    .slice(0, 2)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, "")[0] ?? "")
    .join("")
    .toUpperCase();
}

/** A field's column id in the list view / export: built-ins are bare keys. */
export function columnLabel(key: string, fields: FieldLike[]): string {
  if (key === "assists") return fields.find((f) => f.key === "assistant")?.inverse_label || "Assists";
  if (key.endsWith(":in")) {
    const f = fields.find((x) => x.key === key.slice(0, -3));
    return f?.inverse_label || `${f?.label ?? key} (inverse)`;
  }
  const f = fields.find((x) => x.key === key);
  if (f) return f.label;
  const builtin: Record<string, string> = { name: "Name", email: "Email", phone: "Phone", mobile: "Mobile" };
  return builtin[key] ?? key;
}

/** Every column a list or export can show, in a sensible default order. */
export function availableColumns(fields: FieldLike[]): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [{ key: "name", label: "Name" }];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const k of ["title", "department", "email", "phone", "mobile", "office"]) {
    out.push({ key: k, label: byKey.get(k)?.label ?? columnLabel(k, fields) });
  }
  for (const f of fields) {
    if (f.builtin && f.kind !== "people") continue;
    out.push({ key: f.key, label: f.label });
    if (f.kind === "people") out.push({ key: f.key === "assistant" ? "assists" : `${f.key}:in`, label: f.inverse_label || `${f.label} (inverse)` });
  }
  return out;
}
