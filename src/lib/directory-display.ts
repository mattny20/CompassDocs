// Directory display helpers — client-safe, shared by the directory page, the
// admin console, the profile page, and the PDF/CSV export, so a value renders
// the same way everywhere: "PHX1 – Phoenix" in a card is "PHX1 – Phoenix" on
// paper.
//
// Options are resolved at read time and raw values stay stored. Relabelling an
// office or adding a synonym to a position takes effect immediately, with no
// resync and no rewrite of anyone's row.

export type FieldKind = "text" | "choice" | "people" | "date";
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
  /** For date fields: what the date means — "" | "start" | "birthday". */
  date_role?: string;
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
  slate: "bg-slate-100 text-slate-600",
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
export function formatValue(field: Pick<FieldLike, "options" | "value_format"> & { kind?: FieldKind }, raw: string): string {
  if (field.kind === "date") return formatDateValue(raw);
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
export function displayValue(field: Pick<FieldLike, "options" | "value_format" | "multi"> & { kind?: FieldKind }, raw: string): string {
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
  // The virtual name keys sort by a part of the name; they are never columns.
  if (key === "name:first") return nameParts(p.name).first;
  if (key === "name:last") return nameParts(p.name).last;
  if (key === "assists") return linkNames(p, "assistant", "in");
  if (key.endsWith(":in")) return linkNames(p, key.slice(0, -3), "in");
  const field = fields.find((f) => f.key === key);
  if (field?.kind === "people") return linkNames(p, key, "out");
  const raw = rawValue(p, key);
  return field ? displayValue(field, raw) : raw;
}

/**
 * Does a person's value for a key equal `want`? The raw, canonical and label
 * forms all count, case-insensitively; a multi-valued field matches on any of
 * its values; a people field or an inverse key matches a linked name. The
 * export's filter and its markers both read this, so "Office = Phoenix"
 * means the same thing to each.
 */
export function matchesValue(p: PersonLike, key: string, want: string, fields: FieldLike[]): boolean {
  const w = String(want ?? "").trim().toLowerCase();
  const field = fields.find((f) => f.key === key);
  if (field?.kind === "people" || key === "assists" || key.endsWith(":in")) {
    return cellValue(p, key, fields).toLowerCase().split(", ").includes(w);
  }
  const raw = rawValue(p, key);
  if (!field) return raw.trim().toLowerCase() === w;
  return resolveValues(field, raw).some(
    (r) => r.raw.toLowerCase() === w || r.value.toLowerCase() === w || r.label.toLowerCase() === w
  );
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
 * Groups in an admin's order (an export preset's `section_order`): the
 * groups whose key is listed come first, in the list's order; the rest
 * follow in the order given, the field's own. An empty list hands the
 * groups back as they are, so a preset without an order prints as it always
 * did. Keys match case-insensitively, as groupPeople files them; a listed
 * key no group has is skipped.
 */
export function orderGroups<G extends { key: string }>(groups: G[], order: readonly string[]): G[] {
  if (order.length === 0) return groups;
  const rank = new Map<string, number>();
  order.forEach((v, i) => {
    const k = String(v ?? "").trim().toLowerCase();
    if (k && !rank.has(k)) rank.set(k, i);
  });
  const listed: { g: G; at: number }[] = [];
  const rest: G[] = [];
  for (const g of groups) {
    const at = rank.get(g.key.toLowerCase());
    if (at === undefined) rest.push(g);
    else listed.push({ g, at });
  }
  listed.sort((a, b) => a.at - b.at);
  return [...listed.map((x) => x.g), ...rest];
}

/** One section an export's "Sections by" field makes, as the preset editor previews it. */
export interface SectionSummary {
  /** The group's key, what `section_order` stores: the option's value, else the raw value. */
  value: string;
  /** The heading the export prints. */
  label: string;
  count: number;
}

/**
 * The sections a field makes of a list of people, in the field's own order
 * (groupPeople's: options first, unmatched values alphabetically), each
 * with its count. A filter (the preset's "only people where") narrows the
 * people first. People with no value are left out: their "No <field>"
 * section has no value to list in an order and always prints last.
 */
export function sectionSummaries<P extends PersonLike>(
  people: P[],
  field: FieldLike,
  fields: FieldLike[],
  filter?: { key: string; value: string } | null
): SectionSummary[] {
  const kept = filter ? people.filter((p) => matchesValue(p, filter.key, filter.value, fields)) : people;
  return groupPeople(kept, field)
    .filter((g) => g.key !== "")
    .map((g) => ({ value: g.key, label: g.label, count: g.members.length }));
}

/**
 * Order people by a field: option order first when the field has options,
 * then the display value, then name — so "Attorney" precedes "Paralegal"
 * because the admin said so, not because of the alphabet.
 */
export function comparePeople(fields: FieldLike[], sortKey: string, dir: 1 | -1 = 1) {
  return compareByKeys(fields, [{ key: sortKey, dir }]);
}

export interface SortKey {
  key: string;
  dir: 1 | -1;
}

/** One key's ordering, with no tie-break — chained by compareByKeys. */
function compareOnKey(fields: FieldLike[], sortKey: string, dir: 1 | -1) {
  const field = fields.find((f) => f.key === sortKey);
  return (a: PersonLike, b: PersonLike): number => {
    const va = cellValue(a, sortKey, fields);
    const vb = cellValue(b, sortKey, fields);
    // Empties last regardless of direction — a blank office is not "before A".
    if (!va !== !vb) return va ? -1 : 1;
    if (field?.kind === "date") {
      const da = parseDateValue(rawValue(a, sortKey));
      const db = parseDateValue(rawValue(b, sortKey));
      const ka = da ? da.y * 10000 + da.m * 100 + da.d : Number.POSITIVE_INFINITY;
      const kb = db ? db.y * 10000 + db.m * 100 + db.d : Number.POSITIVE_INFINITY;
      if (ka !== kb) return (ka < kb ? -1 : 1) * dir;
    }
    if (field && field.options.length) {
      const ra = resolveValues(field, rawValue(a, sortKey))[0];
      const rb = resolveValues(field, rawValue(b, sortKey))[0];
      const ia = ra?.index ?? Number.POSITIVE_INFINITY;
      const ib = rb?.index ?? Number.POSITIVE_INFINITY;
      if (ia !== ib) return (ia < ib ? -1 : 1) * dir;
    }
    return va.localeCompare(vb, undefined, { sensitivity: "base" }) * dir;
  };
}

/**
 * Order people by several keys in turn — "Office, then Title, then name" —
 * each with its own direction. Keys that are blank or repeat an earlier one
 * are skipped; the name always breaks the final tie, in the first key's
 * direction, so an export is stable run to run.
 */
export function compareByKeys(fields: FieldLike[], keys: SortKey[]) {
  const seen = new Set<string>();
  const chain = keys
    .filter((k) => k.key && !seen.has(k.key) && seen.add(k.key))
    .map((k) => compareOnKey(fields, k.key, k.dir));
  const nameDir = keys[0]?.dir ?? 1;
  return (a: PersonLike, b: PersonLike): number => {
    for (const cmp of chain) {
      const c = cmp(a, b);
      if (c !== 0) return c;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) * nameDir;
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

// --- Names ---------------------------------------------------------------------

/** After a comma these are a suffix ("Smith, Jr."), not a first name. */
const NAME_SUFFIX_AFTER_COMMA = /^\s*(esq|jr|sr|ii|iii|iv|phd|md|cpa)\.?\s*$/i;
/** Honorifics and generational suffixes, dropped wherever a name is split into words. */
const NAME_NOISE = /^(mr|mrs|ms|dr|prof|esq|jr|sr|ii|iii|iv)\.?$/i;
/** Credentials that trail a name as a word ("Jane Smith PhD"); never a surname. */
const NAME_CREDENTIAL = /^(phd|md|cpa|esq|jd|rn|dds|cfa|cfp|mba)\.?,?$/i;
/** Surname particles that ride with the last word: "van Beethoven", "De La Hoya". */
const NAME_PARTICLE =
  /^(van|von|vander|vanden|der|den|de|da|di|del|della|dela|do|dos|das|du|la|le|les|lo|los|al|el|bin|ibn|ter|ten|op|af|av|zu|zum|zur|st\.?|san|santa)$/i;

/**
 * A name as words in Western order, without honorifics or suffixes:
 * "Smith, Jane A." reads ["Jane", "A.", "Smith"]; "Dr. Jane Smith Jr." reads
 * ["Jane", "Smith"]. Shared by initialsOf and nameParts so both agree on what
 * a name's words are.
 */
function nameWords(name: string): string[] {
  let n = String(name ?? "").trim();
  if (!n) return [];
  if (n.includes(",")) {
    const [last, rest] = n.split(",", 2);
    if (rest && !NAME_SUFFIX_AFTER_COMMA.test(rest)) n = `${rest.trim()} ${last.trim()}`;
    else n = last.trim();
  }
  return n.split(/\s+/).filter((w) => w && !NAME_NOISE.test(w));
}

/**
 * Avatar/initials fallback. "Smith, Jane" reads JS; honorifics and suffixes
 * are dropped; up to three letters so timekeeper-style initials fit.
 */
export function initialsOf(name: string): string {
  return nameWords(name)
    .slice(0, 2)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, "")[0] ?? "")
    .join("")
    .toUpperCase();
}

/**
 * First and last name, for sorting. "Smith, Jane A." is Jane / Smith; "Dr.
 * Jane A. Smith Jr." is Jane / Smith; "Ludwig van Beethoven" is Ludwig / van
 * Beethoven (a particle surname keeps its particles); a single word is both.
 * Honorifics and suffixes are dropped as initialsOf drops them; credentials
 * come off the end only, so a given name that spells one keeps it ("JD
 * Vance" is JD / Vance, "Jane Smith MD PhD" is Jane / Smith).
 */
export function nameParts(name: string): { first: string; last: string } {
  const words = nameCore(name);
  if (words.length === 0) return { first: "", last: "" };
  if (words.length === 1) return { first: words[0], last: words[0] };
  // The last name starts at the final word and takes the particles before it,
  // but never the first word: "Van Morrison" is Van / Morrison.
  let from = words.length - 1;
  while (from > 1 && NAME_PARTICLE.test(words[from - 1])) from--;
  return { first: words[0], last: words.slice(from).join(" ") };
}

/** The name's words with trailing credentials taken off: what nameParts and formatName both split. */
function nameCore(name: string): string[] {
  const words = nameWords(name);
  while (words.length > 1 && NAME_CREDENTIAL.test(words[words.length - 1])) words.pop();
  return words;
}

/** The ways an export may write a name; "as_written" is the name as stored. */
export const NAME_FORMATS = [
  { key: "as_written", label: "As written" },
  { key: "first_last", label: "First name Last name" },
  { key: "last_first", label: "Last name, First name" },
  { key: "first_last_initial", label: "First name Last initial" },
  { key: "last_first_initial", label: "Last name, First initial" },
  { key: "first_initial_last", label: "First initial Last name" },
] as const;

export type NameFormat = (typeof NAME_FORMATS)[number]["key"];

export const NAME_FORMAT_KEYS = NAME_FORMATS.map((f) => f.key) as readonly NameFormat[];

export function isNameFormat(key: string): key is NameFormat {
  return (NAME_FORMAT_KEYS as readonly string[]).includes(key);
}

/** "J." for "Jane"; a word with no letter or digit in it is kept as it is. */
function initialOf(word: string): string {
  const c = word.replace(/^[^\p{L}\p{N}]+/u, "")[0];
  return c ? `${c.toUpperCase()}.` : word;
}

/**
 * A name written one of the NAME_FORMATS ways, built on nameParts: "Smith,
 * Jane A." is "Jane Smith", "Smith, Jane", "Jane S.", "Smith, J." or "J.
 * Smith"; a particle surname rides whole ("van Beethoven, Ludwig"), and its
 * initial is the surname proper's ("Ludwig B.", "Maria C." for "de la Cruz,
 * Maria"), since "Ludwig V." names no one. A single-word name prints as it
 * is in every format, and "as_written" returns the name untouched (trimmed).
 * Sorting never reads this: the sort keys parse the stored name.
 */
export function formatName(name: string, format: NameFormat): string {
  const n = String(name ?? "").trim();
  if (format === "as_written" || !n) return n;
  if (nameCore(n).length <= 1) return n;
  const { first, last } = nameParts(n);
  switch (format) {
    case "first_last":
      return `${first} ${last}`;
    case "last_first":
      return `${last}, ${first}`;
    case "first_last_initial":
      return `${first} ${initialOf(last.split(" ").pop() ?? last)}`;
    case "last_first_initial":
      return `${last}, ${initialOf(first)}`;
    case "first_initial_last":
      return `${initialOf(first)} ${last}`;
  }
}

/** Virtual sort keys: accepted wherever a sort key is, never as a column. */
export const NAME_SORT_KEYS = [
  { key: "name:first", label: "First name" },
  { key: "name:last", label: "Last name" },
] as const;

export type NameSortKey = (typeof NAME_SORT_KEYS)[number]["key"];

export function isNameSortKey(key: string): key is NameSortKey {
  return NAME_SORT_KEYS.some((k) => k.key === key);
}

/** The Directory page's "Sort names by" choices; the admin default is the setting directory_name_sort. */
export const NAME_SORT_MODES = ["full", "first", "last"] as const;

export type NameSortMode = (typeof NAME_SORT_MODES)[number];

/** The sort key a list sorted by name uses under a name-sort mode. */
export function nameSortKey(mode: NameSortMode): "name" | NameSortKey {
  return mode === "first" ? "name:first" : mode === "last" ? "name:last" : "name";
}

/** A field's column id in the list view / export: built-ins are bare keys. */
export function columnLabel(key: string, fields: FieldLike[]): string {
  const nameSort = NAME_SORT_KEYS.find((k) => k.key === key);
  if (nameSort) return nameSort.label;
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

/** Every key a sort may use: the columns, with the first-/last-name keys right after "Name". */
export function sortableKeys(fields: FieldLike[]): { key: string; label: string }[] {
  const [name, ...rest] = availableColumns(fields);
  return [name, ...NAME_SORT_KEYS, ...rest];
}

/** What an export may show after an assistant's name: any column but the name and the link columns. */
export function assistantDetailKeys(fields: FieldLike[]): { key: string; label: string }[] {
  const people = new Set(fields.filter((f) => f.kind === "people").map((f) => f.key));
  return availableColumns(fields).filter(
    (c) => c.key !== "name" && c.key !== "assists" && !c.key.endsWith(":in") && !people.has(c.key)
  );
}

export interface AssistantTextOptions {
  /** How each assistant's name is written; "as_written" when absent. */
  nameFormat?: NameFormat;
  /** The symbols printed before an assistant's name (the export's markers),
   *  read from the assistant's own row; "" for none. An assistant off the
   *  lookup has no row to read, so carries none. */
  prefix?: (assistant: PersonLike) => string;
}

/**
 * An assistant column's cell with the chosen details, "Jane Smith · 555-0100
 * · x204", assistants joined with "; ". Details come from the assistant's own
 * row in `byId`; an assistant not in it (not in the export's list) shows the
 * name alone. The CSV and the PDF both read this, so they agree. With
 * options, each name is written in the preset's format and carries the
 * assistant's own marker symbols: "* Lee, Pat · x204".
 */
export function assistantText(
  p: PersonLike,
  fields: FieldLike[],
  byId: ReadonlyMap<number, PersonLike>,
  assistantFields: string[],
  options?: AssistantTextOptions
): string {
  const refs = p.links?.assistant ?? [];
  return refs
    .map((ref) => {
      const a = byId.get(ref.id);
      const details = a ? assistantFields.map((k) => cellValue(a, k, fields).trim()).filter(Boolean) : [];
      let name = options?.nameFormat ? formatName(ref.name, options.nameFormat) : ref.name;
      const prefix = a && options?.prefix ? options.prefix(a) : "";
      if (prefix) name = `${prefix} ${name}`;
      return [name, ...details].join(" · ");
    })
    .join("; ");
}

// --- Dates -------------------------------------------------------------------

export interface DateParts {
  y: number;
  m: number;
  d: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date as a provider or an admin writes it: ISO ("2020-05-01",
 * "2020-05-01T00:00:00Z" — Graph's employeeHireDate), US "5/1/2020", or
 * "May 1, 2020". Null when it is none of those. Year-less "05-01" counts as
 * a birthday with year 0.
 */
export function parseDateValue(raw: string): DateParts | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return check(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return check(Number(m[3]), Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return check(0, Number(m[1]), Number(m[2]));
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.findIndex((x) => m![1].toLowerCase().startsWith(x.toLowerCase()));
    if (mi >= 0) return check(Number(m[3]), mi + 1, Number(m[2]));
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const dt = new Date(t);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  return null;
}

function check(y: number, m: number, d: number): DateParts | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** "May 1, 2020"; a year-less date reads "May 1"; unparseable text is shown as is. */
export function formatDateValue(raw: string): string {
  const p = parseDateValue(raw);
  if (!p) return String(raw ?? "").trim();
  return p.y ? `${MONTHS[p.m - 1]} ${p.d}, ${p.y}` : `${MONTHS[p.m - 1]} ${p.d}`;
}

export interface Milestone<P extends PersonLike> {
  person: P;
  /** Years completed this month (0 for "started this month"; birthdays carry no years). */
  years: number;
  /** Day of month, for ordering. */
  day: number;
}

export interface Milestones<P extends PersonLike> {
  started: Milestone<P>[];
  anniversaries: Milestone<P>[];
  birthdays: Milestone<P>[];
}

/**
 * Who started, marks an anniversary, or has a birthday this month, from the
 * fields an admin flagged as a start date or birthday. Start dates in the
 * future are ignored (a hire not yet here is not "new"). Ordered by day.
 */
export function milestonesFor<P extends PersonLike>(people: P[], fields: FieldLike[], now: Date): Milestones<P> {
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const starts = fields.filter((f) => f.kind === "date" && f.date_role === "start");
  const bdays = fields.filter((f) => f.kind === "date" && f.date_role === "birthday");
  const out: Milestones<P> = { started: [], anniversaries: [], birthdays: [] };
  for (const p of people) {
    for (const f of starts) {
      const d = parseDateValue(p.custom?.[f.key] ?? "");
      if (!d || d.m !== mo || !d.y) continue;
      if (d.y === y) out.started.push({ person: p, years: 0, day: d.d });
      else if (d.y < y) out.anniversaries.push({ person: p, years: y - d.y, day: d.d });
    }
    for (const f of bdays) {
      const d = parseDateValue(p.custom?.[f.key] ?? "");
      if (!d || d.m !== mo) continue;
      out.birthdays.push({ person: p, years: 0, day: d.d });
    }
  }
  const byDay = (a: Milestone<P>, b: Milestone<P>) => a.day - b.day || a.person.name.localeCompare(b.person.name);
  out.started.sort(byDay);
  out.anniversaries.sort(byDay);
  out.birthdays.sort(byDay);
  return out;
}
