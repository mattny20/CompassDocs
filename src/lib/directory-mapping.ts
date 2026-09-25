// The directory mapping engine — pure functions, no database, no network.
//
// Everything the sync used to decide in the enterprise overlay ("this Graph
// property becomes that column") is expressed here as data: a Mapping is a
// small JSON tree that turns one provider record (the raw user object a
// provider returned) into the values of one directory field. Keeping it pure
// and in core is what makes three things possible at once — a live preview
// against stored records before a mapping is saved, re-applying an edited
// mapping without another sync, and the community edition running the exact
// same code with records that simply never arrive.
//
// Client-safe on purpose (no server-only marker): the admin UI describes and
// validates mappings with the same functions the sync runs.

import type { ProviderKey } from "./identity-provider";

/** A provider's raw record for one person. `_groups` is added by the fetch
 *  layer: the ids of the configured groups this person is a (transitive)
 *  member of, so a `groups` mapping needs no further calls. */
export type ProviderRecord = Record<string, unknown> & { _groups?: string[] };

export type Mapping =
  /** One property, dotted; arrays index numerically (`businessPhones.1`), by
   *  `[primary]` (Google's `organizations[primary].title`), or by type
   *  (`relations[assistant].value`, `phones[work].value`). */
  | { kind: "path"; path: string }
  /** A template with `{path}` placeholders. Separators next to an empty
   *  placeholder are dropped, so `{officeLocation} – {city}` with no city is
   *  just the office. */
  | { kind: "compose"; template: string }
  /** A regular expression over a property's values; the first match wins. */
  | { kind: "extract"; path: string; pattern: string; group?: number }
  /** The first mapping in the list that yields anything. */
  | { kind: "first"; of: Mapping[] }
  /** Membership of the listed provider groups, each contributing a value. */
  | { kind: "groups"; groups: { id: string; value: string; name?: string }[] }
  /** Something computed from the record rather than read from it. */
  | { kind: "derive"; rule: "initials" | "email_localpart" };

export const MAPPING_KINDS: Mapping["kind"][] = ["path", "compose", "extract", "first", "groups", "derive"];
export const DERIVE_RULES = ["initials", "email_localpart"] as const;

/** Per-provider mappings stored on a field. Absent = not mapped from that provider. */
export type FieldMappings = Partial<Record<ProviderKey, Mapping>>;

const MAX_DEPTH = 4;
const MAX_PATTERN = 200;
const MAX_VALUES = 50;

// --- Reading a record ----------------------------------------------------------

/**
 * Every value at a dotted path, as strings.
 *
 * Returns an array because provider records are full of arrays (business
 * phones, group ids, proxy addresses) and a mapping should be able to see all
 * of them. A scalar is a one-element array; a missing property is empty.
 */
export function valuesAtPath(record: unknown, path: string): string[] {
  const segs = String(path ?? "").trim().split(".").filter(Boolean);
  if (segs.length === 0) return [];
  let cur: unknown[] = [record];
  for (const rawSeg of segs) {
    // `phones[primary]` picks the element flagged primary (or the first);
    // `relations[assistant]` keeps the elements whose `type` is "assistant" —
    // Google's shape for relations, phones, emails and addresses.
    const sel = /^([^[\]]+)\[([^[\]]+)\]$/.exec(rawSeg);
    const seg = sel ? sel[1] : rawSeg;
    const primary = sel?.[2] === "primary";
    const typed = sel && !primary ? sel[2].toLowerCase() : null;
    const next: unknown[] = [];
    for (const c of cur) {
      if (c == null) continue;
      if (Array.isArray(c)) {
        // A numeric segment indexes the array; any other segment reads the
        // property off every element (so `phones.type` sees all of them).
        if (/^\d+$/.test(seg)) {
          const v = c[Number(seg)];
          if (v != null) next.push(v);
          continue;
        }
        for (const el of c) {
          if (el && typeof el === "object" && !Array.isArray(el)) {
            const v = (el as Record<string, unknown>)[seg];
            if (v != null) next.push(v);
          }
        }
        continue;
      }
      if (typeof c !== "object") continue;
      let v: unknown = (c as Record<string, unknown>)[seg];
      if (primary) {
        if (!Array.isArray(v) || v.length === 0) continue;
        v = v.find((e) => e && typeof e === "object" && (e as { primary?: boolean }).primary) ?? v[0];
      } else if (typed) {
        if (!Array.isArray(v)) continue;
        v = v.filter((e) => e && typeof e === "object" && String((e as { type?: unknown }).type ?? "").toLowerCase() === typed);
        if ((v as unknown[]).length === 0) continue;
      }
      if (v != null) next.push(v);
    }
    cur = next;
    if (cur.length === 0) return [];
  }
  const flat = cur.flatMap((v) => (Array.isArray(v) ? v : [v]));
  return dedupe(
    flat
      .filter((v) => v != null)
      .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)).trim())
      .filter(Boolean)
  );
}

function firstAtPath(record: unknown, path: string): string {
  return valuesAtPath(record, path)[0] ?? "";
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_VALUES) break;
  }
  return out;
}

// --- Applying a mapping --------------------------------------------------------

/** Run a mapping against one record. Always an array; never throws. */
export function applyMapping(m: Mapping | null | undefined, record: ProviderRecord, depth = 0): string[] {
  if (!m || depth > MAX_DEPTH) return [];
  switch (m.kind) {
    case "path":
      return valuesAtPath(record, m.path);
    case "compose":
      return composeTemplate(m.template, record);
    case "extract":
      return extract(m, record);
    case "first":
      for (const inner of m.of ?? []) {
        const v = applyMapping(inner, record, depth + 1);
        if (v.length) return v;
      }
      return [];
    case "groups": {
      const member = new Set((record._groups ?? []).map(String));
      return dedupe((m.groups ?? []).filter((g) => member.has(g.id)).map((g) => g.value.trim()).filter(Boolean));
    }
    case "derive":
      return derive(m.rule, record);
    default:
      return [];
  }
}

/**
 * `{a} – {b}` templates. A literal between two placeholders is kept only when
 * both neighbours produced something; a leading or trailing literal follows
 * the placeholder it touches. So an office with no city renders as the office,
 * not as "PHX1 – ".
 */
function composeTemplate(template: string, record: ProviderRecord): string[] {
  const parts: { literal?: string; path?: string }[] = [];
  const re = /\{([^{}]+)\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  const tpl = String(template ?? "");
  while ((match = re.exec(tpl))) {
    if (match.index > last) parts.push({ literal: tpl.slice(last, match.index) });
    parts.push({ path: match[1].trim() });
    last = match.index + match[0].length;
  }
  if (last < tpl.length) parts.push({ literal: tpl.slice(last) });
  if (!parts.some((p) => p.path)) return tpl.trim() ? [tpl.trim()] : [];

  const values = parts.map((p) => (p.path ? valuesAtPath(record, p.path).join(", ") : ""));
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.path) {
      out += values[i];
      continue;
    }
    const prev = prevPlaceholderFilled(parts, values, i);
    const next = nextPlaceholderFilled(parts, values, i);
    // Keep the literal only when the placeholders it joins are present.
    if ((prev === null || prev) && (next === null || next)) out += p.literal;
  }
  const s = out.trim();
  return s ? [s] : [];
}

function prevPlaceholderFilled(parts: { path?: string }[], values: string[], i: number): boolean | null {
  for (let j = i - 1; j >= 0; j--) if (parts[j].path) return values[j] !== "";
  return null;
}
function nextPlaceholderFilled(parts: { path?: string }[], values: string[], i: number): boolean | null {
  for (let j = i + 1; j < parts.length; j++) if (parts[j].path) return values[j] !== "";
  return null;
}

function extract(m: { path: string; pattern: string; group?: number }, record: ProviderRecord): string[] {
  const re = compilePattern(m.pattern);
  if (!re) return [];
  const group = Number.isInteger(m.group) && (m.group as number) >= 0 ? (m.group as number) : 1;
  for (const v of valuesAtPath(record, m.path)) {
    const hit = re.exec(v);
    if (hit) {
      const picked = hit[group] ?? hit[0] ?? "";
      if (picked.trim()) return [picked.trim()];
    }
  }
  return [];
}

/** A pattern that compiles, or null. Bounded in length so admin data can't
 *  smuggle in something pathological. */
export function compilePattern(pattern: string): RegExp | null {
  const p = String(pattern ?? "");
  if (!p || p.length > MAX_PATTERN) return null;
  try {
    return new RegExp(p, "i");
  } catch {
    return null;
  }
}

function derive(rule: string, record: ProviderRecord): string[] {
  if (rule === "initials") {
    const given = firstAtPath(record, "givenName") || firstAtPath(record, "name.givenName");
    const family = firstAtPath(record, "surname") || firstAtPath(record, "name.familyName");
    if (given && family) return [(given[0] + family[0]).toUpperCase()];
    const display = firstAtPath(record, "displayName") || firstAtPath(record, "name.fullName");
    const v = initialsFromName(display);
    return v ? [v] : [];
  }
  if (rule === "email_localpart") {
    const mail =
      firstAtPath(record, "mail") || firstAtPath(record, "userPrincipalName") || firstAtPath(record, "primaryEmail");
    const local = mail.split("@")[0]?.trim() ?? "";
    return local ? [local] : [];
  }
  return [];
}

/**
 * Initials from a display name. "Smith, Jane" is a last-first form common in
 * corporate directories and must read JS, not S,; honorifics and suffixes are
 * dropped so "Dr. Jane Smith, Esq." is still JS.
 */
export function initialsFromName(name: string): string {
  let n = String(name ?? "").trim();
  if (!n) return "";
  if (n.includes(",")) {
    const [last, rest] = n.split(",", 2);
    // "Smith, Jane" → "Jane Smith"; "Jane Smith, Esq." keeps the name part.
    if (rest && !/^\s*(esq|jr|sr|ii|iii|iv|phd|md|cpa)\.?\s*$/i.test(rest)) n = `${rest.trim()} ${last.trim()}`;
    else n = last.trim();
  }
  const words = n
    .split(/\s+/)
    .filter((w) => w && !/^(mr|mrs|ms|dr|prof|esq|jr|sr|ii|iii|iv)\.?$/i.test(w));
  return words
    .slice(0, 3)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, "")[0] ?? "")
    .join("")
    .toUpperCase();
}

// --- What a mapping needs from the provider ---------------------------------------

/** Top-level record properties a mapping reads — what the fetch must $select. */
export function mappingProperties(m: Mapping | null | undefined, depth = 0): string[] {
  if (!m || depth > MAX_DEPTH) return [];
  const top = (path: string) => {
    const first = String(path ?? "").split(".")[0]?.replace(/\[[^[\]]*\]$/, "").trim();
    return first && first !== "_groups" ? [first] : [];
  };
  switch (m.kind) {
    case "path":
      return top(m.path);
    case "extract":
      return top(m.path);
    case "compose":
      return dedupe([...String(m.template ?? "").matchAll(/\{([^{}]+)\}/g)].flatMap((x) => top(x[1])));
    case "first":
      return dedupe((m.of ?? []).flatMap((inner) => mappingProperties(inner, depth + 1)));
    case "derive":
      return m.rule === "initials"
        ? ["givenName", "surname", "displayName", "name"]
        : ["mail", "userPrincipalName", "primaryEmail"];
    case "groups":
      return [];
    default:
      return [];
  }
}

/** Provider group ids a mapping depends on — what the fetch must resolve members for. */
export function mappingGroupIds(m: Mapping | null | undefined, depth = 0): string[] {
  if (!m || depth > MAX_DEPTH) return [];
  if (m.kind === "groups") return dedupe((m.groups ?? []).map((g) => g.id));
  if (m.kind === "first") return dedupe((m.of ?? []).flatMap((inner) => mappingGroupIds(inner, depth + 1)));
  return [];
}

// --- Validation and description -----------------------------------------------------

/** Turn untrusted JSON into a Mapping, or null if it isn't one. */
export function parseMapping(raw: unknown, depth = 0): Mapping | null {
  if (!raw || typeof raw !== "object" || depth > MAX_DEPTH) return null;
  const o = raw as Record<string, unknown>;
  const str = (k: string) => String(o[k] ?? "").trim();
  switch (o.kind) {
    case "path":
      return str("path") ? { kind: "path", path: str("path") } : null;
    case "compose":
      return str("template") ? { kind: "compose", template: str("template") } : null;
    case "extract": {
      if (!str("path") || !str("pattern") || !compilePattern(str("pattern"))) return null;
      const g = Number(o.group);
      return { kind: "extract", path: str("path"), pattern: str("pattern"), ...(Number.isInteger(g) && g >= 0 ? { group: g } : {}) };
    }
    case "first": {
      const of = Array.isArray(o.of) ? o.of.map((x) => parseMapping(x, depth + 1)).filter((x): x is Mapping => !!x) : [];
      return of.length ? { kind: "first", of } : null;
    }
    case "groups": {
      const groups = Array.isArray(o.groups)
        ? o.groups
            .map((g) => {
              const gg = (g ?? {}) as Record<string, unknown>;
              const id = String(gg.id ?? "").trim();
              const value = String(gg.value ?? "").trim();
              const name = String(gg.name ?? "").trim();
              return id && value ? { id, value, ...(name ? { name } : {}) } : null;
            })
            .filter((g): g is { id: string; value: string; name?: string } => !!g)
        : [];
      return groups.length ? { kind: "groups", groups } : null;
    }
    case "derive":
      return (DERIVE_RULES as readonly string[]).includes(str("rule"))
        ? { kind: "derive", rule: str("rule") as "initials" | "email_localpart" }
        : null;
    default:
      return null;
  }
}

/** Parse a stored `mappings` blob: unknown providers and broken entries dropped. */
export function parseFieldMappings(raw: unknown): FieldMappings {
  const out: FieldMappings = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of ["microsoft", "google"] as ProviderKey[]) {
    const m = parseMapping((raw as Record<string, unknown>)[key]);
    if (m) out[key] = m;
  }
  return out;
}

/** The mapping a legacy `graph_path` / `google_path` column stands for. */
export function legacyPathMapping(path: string): Mapping | null {
  const p = String(path ?? "").trim();
  return p ? { kind: "path", path: p } : null;
}

/** One line for the admin table: "officeLocation – city", "x(\d+)$ over businessPhones". */
export function describeMapping(m: Mapping | null | undefined): string {
  if (!m) return "";
  switch (m.kind) {
    case "path":
      return m.path;
    case "compose":
      return m.template;
    case "extract":
      return `${m.path} ~ /${m.pattern}/`;
    case "first":
      return (m.of ?? []).map(describeMapping).filter(Boolean).join("  →  ");
    case "groups":
      return `${(m.groups ?? []).length} group${(m.groups ?? []).length === 1 ? "" : "s"}`;
    case "derive":
      return m.rule === "initials" ? "initials from name" : "email local part";
    default:
      return "";
  }
}
