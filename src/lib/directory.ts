// People directory — data access. Rows come from three sources:
//   'manual' — entered by an admin in Settings → Directory (community & enterprise)
//   'graph'  — synced from Microsoft Entra ID by the enterprise overlay
//   'google' — synced from Google Workspace by the enterprise overlay
// Synced rows are keyed by external_id (the provider's immutable id). The
// viewer-facing directory only ever sees rows with hidden = 0.
//
// 1.2: the registry. directory_fields is the directory's schema — built-in
// columns are rows too (builtin = 1) — and every field can carry options with
// an admin-defined order, a per-provider mapping (directory-mapping.ts), and a
// kind: text, choice, or people. People-kind values live in
// directory_person_links, a relation queried from both ends.
//
// Two layers per person: `synced` is what the provider's mappings produced on
// the last run and is replaced wholesale each sync; `custom` is what an admin
// typed and is never written by a sync. The effective value is custom over
// synced, per key — so a manual override survives every sync, and deleting the
// override is "use the synced value" again.
//
// Server-only: uses the Postgres pool.

import { pool, getSetting, setSetting } from "./db";
import type { ProviderKey } from "./identity-provider";
import {
  applyMapping,
  legacyPathMapping,
  mappingGroupIds,
  mappingProperties,
  parseFieldMappings,
  type FieldMappings,
  type Mapping,
  type ProviderRecord,
} from "./directory-mapping";
import {
  splitMulti,
  type FieldDisplay,
  type FieldKind,
  type FieldLike,
  type FieldOption,
  type LinkRef,
  type ValueFormat,
} from "./directory-display";

/**
 * Where a directory row came from. "manual" rows are typed in by an admin;
 * the rest are owned by a sync, which is what makes them deletable by that
 * sync — and only by that sync (0.96).
 */
export type PersonSource = "manual" | "graph" | "google";

/** The provider behind a synced source, and back. */
export const PROVIDER_OF_SOURCE: Record<Exclude<PersonSource, "manual">, ProviderKey> = {
  graph: "microsoft",
  google: "google",
};
export const SOURCE_OF_PROVIDER: Record<ProviderKey, Exclude<PersonSource, "manual">> = {
  microsoft: "graph",
  google: "google",
};

export interface DirectoryPerson {
  id: number;
  source: PersonSource;
  external_id: string | null;
  name: string;
  title: string;
  department: string;
  email: string;
  phone: string;
  mobile: string;
  office: string;
  photo: string; // data: URL or ""
  hidden: number; // 0 | 1
  /** Admin pin: NULL = not pinned, otherwise the order among pinned people. */
  pin_order: number | null;
  /** Effective custom values: the admin's `manual` layer over the `synced` one. */
  custom: Record<string, string>;
  /** What the last sync produced. Empty on manual rows. */
  synced: Record<string, string>;
  /** What an admin typed. A key here overrides the synced value. */
  manual: Record<string, string>;
  /** Outgoing people-field links by field key (hidden targets excluded). */
  links: Record<string, LinkRef[]>;
  /** Incoming links: who lists this person, by field key. */
  linked_by: Record<string, LinkRef[]>;
  /** The provider record is stored — mappings can be previewed / re-applied. */
  has_record: boolean;
  /** Names of this person's assistants, joined. Kept for the print/list column
   *  and every caller that predates the links table. */
  assistant_name: string | null;
  updated_at: string;
}

export interface DirectoryField extends FieldLike {
  id: number;
  key: string;
  label: string;
  /** Legacy single-property mapping columns; `mappings` supersedes them. */
  graph_path: string;
  google_path: string;
  show_in_card: number; // 0 | 1
  sort: number;
  display: FieldDisplay;
  kind: FieldKind;
  multi: number;
  group_by: number;
  builtin: number;
  options: FieldOption[];
  value_format: ValueFormat;
  show_with: string;
  highlight: number;
  inverse_label: string;
  /** For people fields: does a synced value on X name X's targets ("out") or
   *  the people whose target X is ("in")? */
  link_direction: "out" | "in";
  mappings: FieldMappings;
}

// Link aggregates are correlated subqueries rather than joins so a person with
// three assistants is still one row. Hidden people are excluded on both ends:
// a link to someone the directory doesn't show must not surface their name.
const LINKS_OUT = `COALESCE((
  SELECT jsonb_object_agg(x.field_key, x.refs) FROM (
    SELECT l.field_key,
           jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY l.sort, t.name) AS refs
      FROM directory_person_links l JOIN directory_people t ON t.id = l.target_id
     WHERE l.person_id = p.id AND t.hidden = 0
     GROUP BY l.field_key) x), '{}'::jsonb)`;
const LINKS_IN = `COALESCE((
  SELECT jsonb_object_agg(x.field_key, x.refs) FROM (
    SELECT l.field_key,
           jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name) AS refs
      FROM directory_person_links l JOIN directory_people s ON s.id = l.person_id
     WHERE l.target_id = p.id AND s.hidden = 0
     GROUP BY l.field_key) x), '{}'::jsonb)`;

const COLS = `p.id, p.source, p.external_id, p.name, p.title, p.department, p.email, p.phone, p.mobile,
  p.office, p.photo, p.hidden, p.pin_order, p.updated_at,
  (p.synced || p.custom) AS custom, p.synced, p.custom AS manual,
  (p.provider_record IS NOT NULL) AS has_record,
  ${LINKS_OUT} AS links, ${LINKS_IN} AS linked_by`;
const FROM = "FROM directory_people p";

type Row = Omit<DirectoryPerson, "assistant_name">;

function hydrate(rows: Row[]): DirectoryPerson[] {
  return rows.map((r) => ({
    ...r,
    custom: r.custom ?? {},
    synced: r.synced ?? {},
    manual: r.manual ?? {},
    links: r.links ?? {},
    linked_by: r.linked_by ?? {},
    assistant_name: (r.links?.assistant ?? []).map((l) => l.name).join(", ") || null,
  }));
}

/** Visible people for the directory page, optionally filtered. */
export async function listPeople(opts?: {
  q?: string;
  department?: string;
  includeHidden?: boolean;
}): Promise<DirectoryPerson[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts?.includeHidden) where.push("p.hidden = 0");
  if (opts?.q) {
    params.push(`%${opts.q}%`);
    const p = `$${params.length}`;
    where.push(
      `(p.name ILIKE ${p} OR p.title ILIKE ${p} OR p.department ILIKE ${p} OR p.email ILIKE ${p} OR (p.synced || p.custom)::text ILIKE ${p})`
    );
  }
  if (opts?.department) {
    params.push(opts.department);
    where.push(`p.department = $${params.length}`);
  }
  const sql = `SELECT ${COLS} ${FROM}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY p.name`;
  return hydrate((await pool().query<Row>(sql, params)).rows);
}

/**
 * People relevant to a natural-language question ("who runs payroll?",
 * "who's the head of IT?") for the Ask feature: token-match against name,
 * title, and department, ranked by how many tokens hit.
 */
export async function searchPeopleForAnswer(
  question: string,
  limit = 5
): Promise<DirectoryPerson[]> {
  const STOP = new Set([
    "the","who","whos","what","whats","where","when","how","why","is","are","was","for","and",
    "our","does","do","can","could","should","of","in","on","at","a","an","to","i","we","you",
    "with","about","contact","person","people","someone","anyone","reach","find","get","need",
    "help","please","company","org","organization",
  ]);
  // Short all-caps words (IT, HR, QA…) are usually departments — keep them
  // even though they'd fail the 3-character minimum.
  const acronyms = (question.match(/\b[A-Z]{2,4}\b/g) ?? []).map((t) => t.toLowerCase());
  const tokens = [
    ...new Set([
      ...acronyms,
      ...question
        .toLowerCase()
        .replace(/[^a-z0-9\s@.'-]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !STOP.has(t)),
    ]),
  ].slice(0, 8);
  if (tokens.length === 0) return [];

  const params: unknown[] = tokens.map((t) => `%${t}%`);
  const per = tokens.map(
    (_, i) =>
      `(CASE WHEN p.name ILIKE $${i + 1} OR p.title ILIKE $${i + 1} OR p.department ILIKE $${i + 1} THEN 1 ELSE 0 END)`
  );
  const rows = await pool().query<Row & { hits: number }>(
    `SELECT ${COLS}, (${per.join(" + ")}) AS hits
     ${FROM}
     WHERE p.hidden = 0 AND (${per.join(" + ")}) > 0
     ORDER BY hits DESC, p.name
     LIMIT ${Math.max(1, Math.min(10, limit))}`,
    params
  );
  return hydrate(rows.rows);
}

/**
 * One row of the command-palette people typeahead. Deliberately narrow: no
 * photo blob, no custom fields, no `hidden`, no links, no source /
 * external_id. `has_photo` lets the caller decide between an <img> pointed at
 * /api/directory/{id}/photo and an initials bubble without shipping ~270 KB of
 * inflated base64 per person.
 */
export interface PersonTypeaheadRow {
  id: number;
  name: string;
  title: string;
  department: string;
  email: string;
  has_photo: boolean;
}

/** Beyond this, extra words cost query time without sharpening the result. */
const TYPEAHEAD_MAX_TOKENS = 4;

/**
 * People typeahead for the command palette: every token must hit something
 * (AND, not a summed OR), so "chen technology" can't match everyone in
 * Technology. Prefix hits on name and email outrank substring hits, so typing
 * "ma" puts Maya above Osman.
 *
 * Hidden people are excluded in SQL with no escape hatch — unlike `listPeople`,
 * this path has no `includeHidden` option to get wrong. `custom` is
 * deliberately not searched (the jsonb cast matches field *keys*, and it can
 * hold admin-only data).
 */
export async function searchPeopleTypeahead(
  query: string,
  limit = 8
): Promise<PersonTypeaheadRow[]> {
  // The allowlist doubles as LIKE-wildcard scrubbing: % and _ are not in it,
  // so a token can never smuggle a pattern in (values are parameterized too).
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s@.'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.slice(0, 40))
    .slice(0, TYPEAHEAD_MAX_TOKENS);
  if (tokens.length === 0) return [];

  const params: unknown[] = [];
  const perToken = tokens.map((t) => {
    params.push(t);
    const p = `$${params.length}`;
    return `(CASE WHEN lower(p.name)       LIKE ${p} || '%'         THEN 100 ELSE 0 END
           + CASE WHEN lower(p.name)       LIKE '% ' || ${p} || '%' THEN  60 ELSE 0 END
           + CASE WHEN lower(p.email)      LIKE ${p} || '%'         THEN  40 ELSE 0 END
           + CASE WHEN lower(p.name)       LIKE '%' || ${p} || '%'  THEN  25 ELSE 0 END
           + CASE WHEN lower(p.title)      LIKE '%' || ${p} || '%'  THEN  15 ELSE 0 END
           + CASE WHEN lower(p.department) LIKE '%' || ${p} || '%'  THEN  10 ELSE 0 END)`;
  });
  params.push(Math.max(1, Math.min(20, Math.trunc(limit) || 8)));

  const res = await pool().query<PersonTypeaheadRow & { score: number }>(
    `SELECT p.id, p.name, p.title, p.department, p.email,
            (p.photo <> '') AS has_photo,
            (${perToken.join(" + ")}) AS score
     FROM directory_people p
     WHERE p.hidden = 0
       AND ${perToken.map((x) => `${x} > 0`).join(" AND ")}
     ORDER BY score DESC, p.name
     LIMIT $${params.length}`,
    params
  );
  // `score` is a ranking detail, not part of the endpoint's contract.
  return res.rows.map(({ score: _score, ...row }) => row);
}

/**
 * A *visible* person's stored photo (a data: URL) for /api/directory/{id}/photo.
 *
 * `hidden = 0` is enforced here in SQL on purpose: `getPerson` does not filter
 * it, and the profile page re-checks in its body — a habit that is easy for a
 * new consumer to forget, and forgetting it leaks a deliberately hidden person.
 * Rows with no photo are treated as absent so the caller 404s uniformly.
 */
export async function visiblePersonPhoto(
  id: number
): Promise<{ photo: string; updated_at: string } | undefined> {
  if (!Number.isInteger(id)) return undefined;
  return (
    await pool().query<{ photo: string; updated_at: string }>(
      `SELECT p.photo, p.updated_at FROM directory_people p
       WHERE p.id = $1 AND p.hidden = 0 AND p.photo <> '' LIMIT 1`,
      [id]
    )
  ).rows[0];
}

/** Distinct non-empty departments among visible people (for the filter menu). */
export async function listDepartments(): Promise<string[]> {
  const res = await pool().query<{ department: string }>(
    "SELECT DISTINCT department FROM directory_people WHERE hidden = 0 AND department <> '' ORDER BY department"
  );
  return res.rows.map((r) => r.department);
}

// --- Field definitions (the registry) -----------------------------------------------

const FIELD_COLS =
  "id, key, label, graph_path, google_path, show_in_card, sort, display, kind, multi, group_by, builtin, options, value_format, show_with, highlight, inverse_label, link_direction, mappings";
const KEY_RE = /^[a-z0-9_]{1,40}$/;
export const FIELD_KINDS: FieldKind[] = ["text", "choice", "people"];
export const FIELD_DISPLAYS: FieldDisplay[] = ["field", "tag", "phone"];
export const VALUE_FORMATS: ValueFormat[] = ["raw", "label", "code_label"];
/** Keys a custom field can never take — they are columns, or derived. */
export const RESERVED_FIELD_KEYS = new Set([
  "name", "title", "department", "email", "phone", "mobile", "office",
  "assistant", "assists", "photo", "hidden", "source", "id",
]);
/** Built-in rows the registry seeds; their key and kind are fixed. */
export const BUILTIN_FIELD_KEYS = new Set(["title", "department", "office", "assistant"]);

type FieldRow = Omit<DirectoryField, "options" | "mappings" | "link_direction"> & {
  options: unknown;
  mappings: unknown;
  link_direction: string;
};

export function slugifyFieldKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

const MAX_OPTIONS = 500;

/** Turn untrusted JSON into an options list: ordered, trimmed, deduplicated. */
export function sanitizeOptions(raw: unknown): FieldOption[] {
  if (!Array.isArray(raw)) return [];
  const out: FieldOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const value = String(o.value ?? "").trim().slice(0, 120);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    const label = String(o.label ?? "").trim().slice(0, 120);
    const matches = Array.isArray(o.matches)
      ? [...new Set(o.matches.map((m) => String(m ?? "").trim().slice(0, 120)).filter(Boolean))].slice(0, 50)
      : [];
    const color = String(o.color ?? "").trim().toLowerCase();
    out.push({
      value,
      ...(label && label !== value ? { label } : {}),
      ...(matches.length ? { matches } : {}),
      ...(/^[a-z]{1,12}$/.test(color) ? { color } : {}),
      ...(o.hidden ? { hidden: true } : {}),
    });
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

function parseField(r: FieldRow): DirectoryField {
  // A field mapped before 1.2 has only the legacy path column. Fold it into
  // the blob here so every reader — the admin page, the editor, the sync —
  // sees one mapping per provider, and clearing it clears both (the legacy
  // columns are derived from the blob on write).
  const mappings = parseFieldMappings(r.mappings);
  if (!mappings.microsoft) {
    const legacy = legacyPathMapping(r.graph_path);
    if (legacy) mappings.microsoft = legacy;
  }
  if (!mappings.google) {
    const legacy = legacyPathMapping(r.google_path);
    if (legacy) mappings.google = legacy;
  }
  return {
    ...r,
    kind: (FIELD_KINDS as string[]).includes(r.kind) ? r.kind : "text",
    display: (FIELD_DISPLAYS as string[]).includes(r.display) ? r.display : "field",
    value_format: (VALUE_FORMATS as string[]).includes(r.value_format) ? r.value_format : "raw",
    options: sanitizeOptions(r.options),
    mappings,
    link_direction: r.link_direction === "in" ? "in" : "out",
  };
}

export async function listFields(): Promise<DirectoryField[]> {
  const rows = await pool().query<FieldRow>(`SELECT ${FIELD_COLS} FROM directory_fields ORDER BY sort, id`);
  return rows.rows.map(parseField);
}

/** Fields whose values live in the custom/synced jsonb — i.e. not columns, not links. */
export function jsonbFields(fields: DirectoryField[]): DirectoryField[] {
  return fields.filter((f) => !BUILTIN_FIELD_KEYS.has(f.key) && f.kind !== "people");
}

/** The mapping in force for a field and provider (parseField already folded the legacy path in). */
export function effectiveMapping(field: DirectoryField, provider: ProviderKey): Mapping | null {
  return field.mappings[provider] ?? null;
}

export interface FieldInput {
  key?: string;
  label?: string;
  graph_path?: string;
  google_path?: string;
  show_in_card?: boolean;
  display?: FieldDisplay;
  sort?: number;
  kind?: FieldKind;
  multi?: boolean;
  group_by?: boolean;
  options?: unknown;
  value_format?: ValueFormat;
  show_with?: string;
  highlight?: boolean;
  inverse_label?: string;
  link_direction?: "out" | "in";
  mappings?: unknown;
}

/**
 * The legacy path columns are derived from the mappings blob on every write,
 * so the older enterprise overlay (which reads graph_path/google_path only)
 * keeps working for the mappings it can express and does nothing for the ones
 * it can't. A provider missing from the blob clears its column: parseField
 * folds a legacy-only mapping into the blob on read, so "missing" here always
 * means the admin removed it (1.2.2 — it used to keep the old column, and
 * "Not mapped" quietly came back as the property it had been).
 */
function legacyColumnsFor(mappings: FieldMappings) {
  const derive = (provider: ProviderKey) => {
    const m = mappings[provider];
    return m?.kind === "path" ? m.path : "";
  };
  return { graph_path: derive("microsoft"), google_path: derive("google") };
}

export async function createField(input: FieldInput & { label: string }): Promise<DirectoryField> {
  const key = (input.key?.trim() || slugifyFieldKey(input.label)).toLowerCase();
  if (!KEY_RE.test(key)) throw new Error("Field key must be 1–40 chars of a–z, 0–9, _");
  if (RESERVED_FIELD_KEYS.has(key)) throw new Error(`"${key}" is a built-in column — pick another key.`);
  const kind: FieldKind = input.kind && FIELD_KINDS.includes(input.kind) ? input.kind : "text";
  const mappings = input.mappings === undefined ? {} : parseFieldMappings(input.mappings);
  // A legacy caller sends graph_path alone; fold it into the mappings blob so
  // there is one source of truth to read back.
  if (!mappings.microsoft && input.graph_path?.trim()) mappings.microsoft = { kind: "path", path: input.graph_path.trim() };
  if (!mappings.google && input.google_path?.trim()) mappings.google = { kind: "path", path: input.google_path.trim() };
  const legacy = legacyColumnsFor(mappings);
  const res = await pool().query<FieldRow>(
    `INSERT INTO directory_fields
       (key, label, graph_path, google_path, show_in_card, sort, display, kind, multi, group_by, builtin,
        options, value_format, show_with, highlight, inverse_label, link_direction, mappings)
     VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT MAX(sort)+1 FROM directory_fields WHERE builtin = 0), 0),
             $6, $7, $8, $9, 0, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${FIELD_COLS}`,
    [
      key,
      input.label.trim().slice(0, 80),
      legacy.graph_path,
      legacy.google_path,
      input.show_in_card ? 1 : 0,
      input.display && FIELD_DISPLAYS.includes(input.display) ? input.display : "field",
      kind,
      input.multi ? 1 : 0,
      input.group_by ? 1 : 0,
      JSON.stringify(sanitizeOptions(input.options)),
      input.value_format && VALUE_FORMATS.includes(input.value_format) ? input.value_format : "raw",
      String(input.show_with ?? "").trim().slice(0, 40),
      input.highlight ? 1 : 0,
      String(input.inverse_label ?? "").trim().slice(0, 80),
      input.link_direction === "in" ? "in" : "out",
      JSON.stringify(mappings),
    ]
  );
  return parseField(res.rows[0]);
}

export async function updateField(id: number, fields: FieldInput): Promise<DirectoryField | undefined> {
  const existing = (
    await pool().query<FieldRow>(`SELECT ${FIELD_COLS} FROM directory_fields WHERE id = $1`, [id])
  ).rows[0];
  if (!existing) return undefined;
  const cur = parseField(existing);
  // Built-in rows keep their key and kind; everything else is the admin's.
  const kind: FieldKind = cur.builtin ? cur.kind : fields.kind && FIELD_KINDS.includes(fields.kind) ? fields.kind : cur.kind;
  const mappings = fields.mappings === undefined ? cur.mappings : parseFieldMappings(fields.mappings);
  if (fields.mappings === undefined) {
    if (fields.graph_path !== undefined) {
      if (fields.graph_path.trim()) mappings.microsoft = { kind: "path", path: fields.graph_path.trim() };
      else delete mappings.microsoft;
    }
    if (fields.google_path !== undefined) {
      if (fields.google_path.trim()) mappings.google = { kind: "path", path: fields.google_path.trim() };
      else delete mappings.google;
    }
  }
  const legacy = legacyColumnsFor(mappings);
  const res = await pool().query<FieldRow>(
    `UPDATE directory_fields SET
       label = $1, graph_path = $2, google_path = $3, show_in_card = $4, sort = $5, display = $6,
       kind = $7, multi = $8, group_by = $9, options = $10, value_format = $11, show_with = $12,
       highlight = $13, inverse_label = $14, link_direction = $15, mappings = $16
     WHERE id = $17 RETURNING ${FIELD_COLS}`,
    [
      (fields.label ?? cur.label).trim().slice(0, 80) || cur.label,
      legacy.graph_path,
      legacy.google_path,
      fields.show_in_card === undefined ? cur.show_in_card : fields.show_in_card ? 1 : 0,
      fields.sort ?? cur.sort,
      fields.display && FIELD_DISPLAYS.includes(fields.display) ? fields.display : cur.display,
      kind,
      fields.multi === undefined ? cur.multi : fields.multi ? 1 : 0,
      fields.group_by === undefined ? cur.group_by : fields.group_by ? 1 : 0,
      JSON.stringify(fields.options === undefined ? cur.options : sanitizeOptions(fields.options)),
      fields.value_format && VALUE_FORMATS.includes(fields.value_format) ? fields.value_format : cur.value_format,
      fields.show_with === undefined ? cur.show_with : String(fields.show_with).trim().slice(0, 40),
      fields.highlight === undefined ? cur.highlight : fields.highlight ? 1 : 0,
      fields.inverse_label === undefined ? cur.inverse_label : String(fields.inverse_label).trim().slice(0, 80),
      fields.link_direction === undefined ? cur.link_direction : fields.link_direction === "in" ? "in" : "out",
      JSON.stringify(mappings),
      id,
    ]
  );
  return parseField(res.rows[0]);
}

export async function deleteField(id: number): Promise<boolean> {
  // Remove the definition AND scrub the key from every person's layers and
  // links. Built-in rows are the schema; they cannot be deleted.
  const f = (
    await pool().query<FieldRow>(`SELECT ${FIELD_COLS} FROM directory_fields WHERE id = $1`, [id])
  ).rows[0];
  if (!f) return false;
  if (f.builtin) throw new Error("Built-in fields can't be deleted.");
  await pool().query(
    "UPDATE directory_people SET custom = custom - $1, synced = synced - $1 WHERE custom ? $1 OR synced ? $1",
    [f.key]
  );
  await pool().query("DELETE FROM directory_person_links WHERE field_key = $1", [f.key]);
  await pool().query("DELETE FROM directory_fields WHERE id = $1", [id]);
  return true;
}

/**
 * Keep only known jsonb field keys, coerce values to trimmed strings. A null
 * value means "remove this key" — on a synced row that is "use the synced
 * value again", which is why the distinction between null and "" matters.
 */
async function sanitizeCustom(
  raw: unknown
): Promise<{ set: Record<string, string>; unset: string[] }> {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  if (!raw || typeof raw !== "object") return { set, unset };
  const keys = new Set(jsonbFields(await listFields()).map((f) => f.key));
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!keys.has(k)) continue;
    if (v === null) unset.push(k);
    else set[k] = String(v ?? "").slice(0, 500).trim();
  }
  return { set, unset };
}

// --- People CRUD ---------------------------------------------------------------

export interface PersonInput {
  name: string;
  title?: string;
  department?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  office?: string;
  photo?: string;
  /** Manual custom values; null removes a key (reverts to the synced value). */
  custom?: Record<string, string | null>;
  /** Manual outgoing links per people field: the complete list of target ids. */
  links?: Record<string, number[]>;
  /** Manual incoming links per people field: who this person is a target for. */
  linked_by?: Record<string, number[]>;
  /** NULL unpins; a number pins at that position. */
  pin_order?: number | null;
}

export async function getPersonById(id: number): Promise<DirectoryPerson | undefined> {
  return getPerson(id);
}

/**
 * Resolve a document byline to a directory person: prefer an account with
 * that display name that's LINKED to a directory entry (immune to the
 * directory name drifting), then fall back to an exact name match.
 */
export async function resolveAuthorPerson(name: string): Promise<DirectoryPerson | undefined> {
  if (!name.trim()) return undefined;
  const linked = hydrate(
    (
      await pool().query<Row>(
        `SELECT ${COLS} FROM users u
         JOIN directory_people p ON p.id = u.directory_person_id
         WHERE lower(u.name) = lower($1) AND p.hidden = 0
         LIMIT 1`,
        [name.trim()]
      )
    ).rows
  )[0];
  return linked ?? getPersonByName(name);
}

/** Case-insensitive exact-name lookup (linking doc bylines to profiles). */
export async function getPersonByName(name: string): Promise<DirectoryPerson | undefined> {
  if (!name.trim()) return undefined;
  return hydrate(
    (
      await pool().query<Row>(`SELECT ${COLS} ${FROM} WHERE p.hidden = 0 AND lower(p.name) = lower($1) LIMIT 1`, [
        name.trim(),
      ])
    ).rows
  )[0];
}

async function getPerson(id: number): Promise<DirectoryPerson | undefined> {
  return hydrate((await pool().query<Row>(`SELECT ${COLS} ${FROM} WHERE p.id = $1`, [id])).rows)[0];
}

export async function createPerson(input: PersonInput): Promise<DirectoryPerson> {
  const { set } = await sanitizeCustom(input.custom);
  const res = await pool().query<{ id: number }>(
    `INSERT INTO directory_people
       (source, name, title, department, email, phone, mobile, office, photo, custom, pin_order)
     VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      input.name.trim(),
      (input.title ?? "").trim(),
      (input.department ?? "").trim(),
      (input.email ?? "").trim(),
      (input.phone ?? "").trim(),
      (input.mobile ?? "").trim(),
      (input.office ?? "").trim(),
      input.photo ?? "",
      JSON.stringify(set),
      input.pin_order ?? null,
    ]
  );
  const id = res.rows[0].id;
  await writeManualLinks(id, input.links, input.linked_by);
  return (await getPerson(id))!;
}

export async function updatePerson(
  id: number,
  fields: Partial<PersonInput> & { hidden?: boolean }
): Promise<DirectoryPerson | undefined> {
  const existing = await getPerson(id);
  if (!existing) return undefined;
  const { set, unset } = await sanitizeCustom(fields.custom);
  const manual = { ...existing.manual };
  for (const k of unset) delete manual[k];
  Object.assign(manual, set);
  await pool().query(
    `UPDATE directory_people SET
       name = $1, title = $2, department = $3, email = $4, phone = $5,
       mobile = $6, office = $7, photo = $8, hidden = $9, custom = $10, pin_order = $11,
       updated_at = now()
     WHERE id = $12`,
    [
      (fields.name ?? existing.name).trim(),
      (fields.title ?? existing.title).trim(),
      (fields.department ?? existing.department).trim(),
      (fields.email ?? existing.email).trim(),
      (fields.phone ?? existing.phone).trim(),
      (fields.mobile ?? existing.mobile).trim(),
      (fields.office ?? existing.office).trim(),
      fields.photo ?? existing.photo,
      fields.hidden === undefined ? existing.hidden : fields.hidden ? 1 : 0,
      JSON.stringify(manual),
      fields.pin_order === undefined ? existing.pin_order : fields.pin_order,
      id,
    ]
  );
  await writeManualLinks(id, fields.links, fields.linked_by);
  return getPerson(id);
}

export async function deletePerson(id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM directory_people WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Set the admin pins in one go: the given ids in order, everyone else unpinned. */
export async function setPinnedPeople(ids: number[]): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE directory_people SET pin_order = NULL WHERE pin_order IS NOT NULL");
    for (let i = 0; i < ids.length; i++) {
      await client.query("UPDATE directory_people SET pin_order = $1 WHERE id = $2", [i, ids[i]]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// --- Links (people-kind fields) -------------------------------------------------

export interface LinkRow {
  person_id: number;
  field_key: string;
  target_id: number;
  source: PersonSource;
  sort: number;
}

/** Every link row touching these people (both directions), for the admin editor. */
export async function listLinkRows(personIds?: number[]): Promise<LinkRow[]> {
  if (personIds && personIds.length === 0) return [];
  const res = await pool().query<LinkRow>(
    personIds
      ? `SELECT person_id, field_key, target_id, source, sort FROM directory_person_links
         WHERE person_id = ANY($1::int[]) OR target_id = ANY($1::int[]) ORDER BY sort`
      : "SELECT person_id, field_key, target_id, source, sort FROM directory_person_links ORDER BY sort",
    personIds ? [personIds] : []
  );
  return res.rows;
}

/**
 * Replace the MANUAL links of one person for the given people fields. Rows a
 * sync owns are never touched here — an admin removing a synced pair would only
 * see it return at the next run, so the editor shows those without a remove
 * control instead.
 */
async function writeManualLinks(
  personId: number,
  links?: Record<string, number[]>,
  linkedBy?: Record<string, number[]>
): Promise<void> {
  if (!links && !linkedBy) return;
  const peopleKeys = new Set((await listFields()).filter((f) => f.kind === "people").map((f) => f.key));
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    for (const [key, ids] of Object.entries(links ?? {})) {
      if (!peopleKeys.has(key)) continue;
      const targets = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n !== personId))];
      await client.query(
        "DELETE FROM directory_person_links WHERE source = 'manual' AND field_key = $1 AND person_id = $2",
        [key, personId]
      );
      for (let i = 0; i < targets.length; i++) {
        await client.query(
          `INSERT INTO directory_person_links (person_id, field_key, target_id, source, sort)
           VALUES ($1, $2, $3, 'manual', $4) ON CONFLICT DO NOTHING`,
          [personId, key, targets[i], i]
        );
      }
    }
    for (const [key, ids] of Object.entries(linkedBy ?? {})) {
      if (!peopleKeys.has(key)) continue;
      const sources = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n !== personId))];
      await client.query(
        "DELETE FROM directory_person_links WHERE source = 'manual' AND field_key = $1 AND target_id = $2",
        [key, personId]
      );
      for (const s of sources) {
        await client.query(
          `INSERT INTO directory_person_links (person_id, field_key, target_id, source, sort)
           VALUES ($1, $2, $3, 'manual', 0) ON CONFLICT DO NOTHING`,
          [s, key, personId]
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// --- Provider sync ---------------------------------------------------------------

export interface ProviderPersonInput extends Omit<PersonInput, "custom" | "links" | "linked_by" | "pin_order"> {
  external_id: string;
  /** Legacy: values the overlay mapped itself (graph_path). Ignored when a record is given. */
  custom?: Record<string, string>;
  /** The provider's raw user object; core applies the field mappings to it. */
  record?: ProviderRecord;
}

/** Kept as the Microsoft-shaped alias so the EE overlay needs no coordinated release. */
export type GraphPersonInput = ProviderPersonInput;

/**
 * What the removal brake stopped, when it stopped something. Carried out to the
 * caller and stored on the provider's last-sync status, because the operator
 * needs it twice: once as an explanation, and again later as the thing that
 * decides whether to offer the override.
 */
export interface RemovalBlocked {
  doomed: number;
  total: number;
  message: string;
}

export interface UnresolvedReport {
  field: string;
  count: number;
  samples: string[];
}

export interface ReplaceOutcome {
  upserted: number;
  deleted: number;
  /** Manual rows converted to synced rows because their email matched. */
  adopted: number;
  blocked?: RemovalBlocked;
  /** People-field tokens that matched nobody, per field. */
  unresolved: UnresolvedReport[];
}

/**
 * The last-sync record every provider stores. Defined here, beside the function
 * that produces the interesting half of it, so Microsoft and Google can't drift
 * into reporting the same outcome in two different shapes — the panels read it
 * through one type and decide whether to offer the removals override.
 */
export interface ProviderSyncStatus {
  at: string;
  ok: boolean;
  count?: number;
  error?: string;
  /**
   * Set when the sync succeeded but the removal brake stopped its delete.
   * Distinct from `error` because it is not a failure, and it has to outlive
   * the response that reported it: a brake that trips once trips every time
   * until an operator explicitly allows the removals, so the panel needs to
   * know about it on a fresh page load. A clean sync clears it.
   */
  blocked?: { doomed: number; total: number };
}

/**
 * Core's own record of what the last replace did for a source — kept beside,
 * not inside, the overlay's status so it is there whichever overlay version
 * wrote the status. The admin panel reads both.
 */
export interface SyncReport {
  at: string;
  adopted: number;
  unresolved: UnresolvedReport[];
  records: number;
}

export async function getSyncReport(source: Exclude<PersonSource, "manual">): Promise<SyncReport | null> {
  const raw = await getSetting(`directory_sync_report_${source}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncReport;
  } catch {
    return null;
  }
}

/** The result of running every mapping for one provider over one record. */
export interface AppliedRecord {
  /** Custom (jsonb) values, multi joined with ", ". People tokens included under their key. */
  synced: Record<string, string>;
  /** Built-in columns a mapping overrides (office composed from two properties, …). */
  columns: Partial<Record<"title" | "department" | "office", string>>;
}

export function applyFieldMappings(fields: DirectoryField[], provider: ProviderKey, record: ProviderRecord): AppliedRecord {
  const synced: Record<string, string> = {};
  const columns: AppliedRecord["columns"] = {};
  for (const f of fields) {
    const m = effectiveMapping(f, provider);
    if (!m) continue;
    const values = applyMapping(m, record);
    if (values.length === 0) continue;
    const joined = (f.multi || f.kind === "people" ? values : [values[0]]).join(", ").slice(0, 500);
    if (f.builtin && (f.key === "title" || f.key === "department" || f.key === "office")) {
      columns[f.key] = joined;
    } else {
      synced[f.key] = joined;
    }
  }
  return { synced, columns };
}

/** Top-level properties the fetch layer must request for this provider. */
export async function providerSelectProperties(provider: ProviderKey): Promise<string[]> {
  const out = new Set<string>();
  for (const f of await listFields()) {
    for (const p of mappingProperties(effectiveMapping(f, provider))) out.add(p);
  }
  return [...out];
}

/** Provider group ids any mapping depends on (membership is resolved by the fetch layer). */
export async function providerGroupIds(provider: ProviderKey): Promise<string[]> {
  const out = new Set<string>();
  for (const f of await listFields()) {
    for (const g of mappingGroupIds(effectiveMapping(f, provider))) out.add(g);
  }
  return [...out];
}

function stripRecord(record: ProviderRecord | undefined): string | null {
  if (!record) return null;
  const { photo: _photo, thumbnailPhotoUrl: _thumb, ...rest } = record as Record<string, unknown>;
  const json = JSON.stringify(rest);
  // A record is a few KB. Anything wildly bigger is a provider misbehaving,
  // not a person, and it would bloat every listPeople read that ever joined it.
  return json.length > 64_000 ? null : json;
}

/**
 * Replace one provider's portion of the directory: upsert by external_id, then
 * delete that provider's rows which have disappeared upstream. Manual rows,
 * per-row `hidden` flags and pins, the manual layer, and manual links are all
 * preserved. The synced layer is replaced wholesale, so a value cleared at the
 * provider clears here too.
 *
 * The `source` parameter is the whole point (0.96). Both the INSERT and the
 * DELETE used to hardcode 'graph'; with a second provider writing to the same
 * table that becomes "whichever directory synced last deletes the other one's
 * people". Scoping the delete to the source doing the syncing is what makes two
 * directories able to coexist.
 *
 * A manual row whose email matches an incoming person is ADOPTED — converted
 * into the synced row — rather than duplicated. That is what lets a new hire
 * typed in by hand before the next sync, or a community workspace that later
 * licenses the sync, keep its links, pins and manual values.
 *
 * `maxDeleteFraction` is a safety valve on the delete. A misconfigured
 * credential or a filter that suddenly matches nothing arrives here as an empty
 * `people` array, which without a brake means "delete every synced person".
 * When the proportion to remove exceeds the limit the delete is skipped, the
 * upserts still commit, and the caller is told why — an operator can then look
 * at it, rather than restoring a directory from a backup.
 *
 * The brake measures what is *currently* stored against what just arrived, so
 * it cannot tell a broken sync from a deliberately smaller one: a team that
 * really did halve keeps tripping it on every subsequent run, and no amount of
 * re-syncing clears it. `allowRemovals` is the operator saying "I looked, the
 * removals are correct" — it turns the brake off for one run only. Nothing sets
 * it implicitly; a caller has to be told to, which is the point.
 */
export async function replaceProviderPeople(
  source: Exclude<PersonSource, "manual">,
  people: ProviderPersonInput[],
  opts?: { maxDeleteFraction?: number; allowRemovals?: boolean }
): Promise<ReplaceOutcome> {
  const maxFraction = opts?.allowRemovals ? 1 : opts?.maxDeleteFraction ?? 0.5;
  const provider = PROVIDER_OF_SOURCE[source];
  const fields = await listFields();
  const client = await pool().connect();
  let adopted = 0;
  try {
    await client.query("BEGIN");
    for (const p of people) {
      const applied = p.record ? applyFieldMappings(fields, provider, p.record) : { synced: p.custom ?? {}, columns: {} };
      const email = (p.email ?? "").trim();
      if (email) {
        const adoption = await client.query(
          `UPDATE directory_people SET source = $1, external_id = $2
            WHERE id = (SELECT id FROM directory_people
                         WHERE source = 'manual' AND external_id IS NULL AND lower(email) = lower($3)
                         ORDER BY id LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM directory_people WHERE external_id = $2)`,
          [source, p.external_id, email]
        );
        adopted += adoption.rowCount ?? 0;
      }
      await client.query(
        `INSERT INTO directory_people
           (source, external_id, name, title, department, email, phone, mobile, office, photo, synced, provider_record)
         VALUES ($11, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $12)
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           source = EXCLUDED.source,
           name = EXCLUDED.name, title = EXCLUDED.title, department = EXCLUDED.department,
           email = EXCLUDED.email, phone = EXCLUDED.phone, mobile = EXCLUDED.mobile,
           office = EXCLUDED.office,
           photo = CASE WHEN EXCLUDED.photo <> '' THEN EXCLUDED.photo ELSE directory_people.photo END,
           synced = EXCLUDED.synced,
           provider_record = EXCLUDED.provider_record,
           updated_at = now()`,
        [
          p.external_id,
          p.name.trim(),
          (applied.columns.title ?? p.title ?? "").trim(),
          (applied.columns.department ?? p.department ?? "").trim(),
          email,
          (p.phone ?? "").trim(),
          (p.mobile ?? "").trim(),
          (applied.columns.office ?? p.office ?? "").trim(),
          p.photo ?? "",
          JSON.stringify(applied.synced),
          source,
          stripRecord(p.record),
        ]
      );
    }

    const ids = people.map((p) => p.external_id);
    const { rows: counts } = await client.query<{ total: string; doomed: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE NOT (external_id = ANY($2::text[])))::text AS doomed
         FROM directory_people WHERE source = $1`,
      [source, ids]
    );
    const total = Number(counts[0]?.total ?? 0);
    const doomed = Number(counts[0]?.doomed ?? 0);

    let deleted = 0;
    let blocked: RemovalBlocked | undefined;
    if (doomed > 0 && total > 0 && doomed / total > maxFraction) {
      blocked = {
        doomed,
        total,
        message:
          `Skipped removing ${doomed} of ${total} synced people — that is more than ` +
          `${Math.round(maxFraction * 100)}% of this directory. The people that did arrive ` +
          `have been updated. Check the connection and filters; if the removals are correct, ` +
          `sync again with removals allowed.`,
      };
    } else if (doomed > 0) {
      const res = await client.query(
        `DELETE FROM directory_people
          WHERE source = $1 AND NOT (external_id = ANY($2::text[]))`,
        [source, ids]
      );
      deleted = res.rowCount ?? 0;
    }

    const unresolved = await resolvePeopleFields(client, source, fields);
    await client.query("COMMIT");
    if (blocked) console.warn(`[directory:${source}] ${blocked.message}`);
    const report: SyncReport = {
      at: new Date().toISOString(),
      adopted,
      unresolved,
      records: people.filter((p) => p.record).length,
    };
    await setSetting(`directory_sync_report_${source}`, JSON.stringify(report));
    return { upserted: people.length, deleted, adopted, blocked, unresolved };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Turn the token lists a sync left in the synced layer of people-kind fields
 * into link rows this source owns. Tokens resolve by the provider's id first
 * (immune to renames), then by email. Unresolved tokens are reported, not
 * dropped: they stay in the synced layer and resolve on a later run once the
 * person they name has arrived.
 */
async function resolvePeopleFields(
  client: import("pg").PoolClient,
  source: Exclude<PersonSource, "manual">,
  fields: DirectoryField[]
): Promise<UnresolvedReport[]> {
  const provider = PROVIDER_OF_SOURCE[source];
  const peopleFields = fields.filter((f) => f.kind === "people" && effectiveMapping(f, provider));
  const out: UnresolvedReport[] = [];
  if (peopleFields.length === 0) return out;

  const rows = await client.query<{ id: number; synced: Record<string, string> }>(
    "SELECT id, synced FROM directory_people WHERE source = $1",
    [source]
  );
  const index = await client.query<{ id: number; external_id: string | null; email: string }>(
    "SELECT id, external_id, email FROM directory_people"
  );
  const byExternal = new Map<string, number>();
  const byEmail = new Map<string, number>();
  for (const r of index.rows) {
    if (r.external_id) byExternal.set(r.external_id.toLowerCase(), r.id);
    if (r.email) byEmail.set(r.email.toLowerCase(), r.id);
  }
  const resolve = (token: string): number | undefined => {
    const t = token.trim().toLowerCase();
    return byExternal.get(t) ?? byEmail.get(t);
  };

  const syncedIds = rows.rows.map((r) => r.id);
  for (const f of peopleFields) {
    const unresolvedSamples: string[] = [];
    let unresolvedCount = 0;
    const pairs: [number, number][] = [];
    for (const r of rows.rows) {
      for (const token of splitMulti(r.synced?.[f.key] ?? "")) {
        const other = resolve(token);
        if (other === undefined) {
          unresolvedCount++;
          if (unresolvedSamples.length < 5) unresolvedSamples.push(token);
          continue;
        }
        if (other === r.id) continue;
        pairs.push(f.link_direction === "in" ? [other, r.id] : [r.id, other]);
      }
    }
    if (f.link_direction === "in") {
      await client.query(
        "DELETE FROM directory_person_links WHERE source = $1 AND field_key = $2 AND target_id = ANY($3::int[])",
        [source, f.key, syncedIds]
      );
    } else {
      await client.query(
        "DELETE FROM directory_person_links WHERE source = $1 AND field_key = $2 AND person_id = ANY($3::int[])",
        [source, f.key, syncedIds]
      );
    }
    let sort = 0;
    for (const [person, target] of pairs) {
      await client.query(
        `INSERT INTO directory_person_links (person_id, field_key, target_id, source, sort)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [person, f.key, target, source, sort++]
      );
    }
    if (unresolvedCount) out.push({ field: f.key, count: unresolvedCount, samples: unresolvedSamples });
  }
  return out;
}

/**
 * Re-run every mapping over the stored provider records — after a field's
 * mapping or options changed — without another sync. Rows without a record
 * (older overlay, or manual) are untouched.
 */
export async function reapplyMappings(): Promise<{ updated: number; unresolved: UnresolvedReport[] }> {
  const fields = await listFields();
  const client = await pool().connect();
  let updated = 0;
  const unresolved: UnresolvedReport[] = [];
  try {
    await client.query("BEGIN");
    for (const source of ["graph", "google"] as const) {
      const provider = PROVIDER_OF_SOURCE[source];
      const rows = await client.query<{ id: number; provider_record: ProviderRecord | null }>(
        "SELECT id, provider_record FROM directory_people WHERE source = $1 AND provider_record IS NOT NULL",
        [source]
      );
      for (const r of rows.rows) {
        if (!r.provider_record) continue;
        const applied = applyFieldMappings(fields, provider, r.provider_record);
        await client.query(
          `UPDATE directory_people SET synced = $2,
             title = COALESCE($3, title), department = COALESCE($4, department), office = COALESCE($5, office),
             updated_at = now()
           WHERE id = $1`,
          [r.id, JSON.stringify(applied.synced), applied.columns.title ?? null, applied.columns.department ?? null, applied.columns.office ?? null]
        );
        updated++;
      }
      if (rows.rows.length) unresolved.push(...(await resolvePeopleFields(client, source, fields)));
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { updated, unresolved };
}

export interface MappingPreview {
  /** People with a stored record for this provider. */
  total: number;
  /** How many of them the mapping produced a value for. */
  filled: number;
  samples: { name: string; values: string[] }[];
  /** Distinct raw values with counts — feeds the options editor. */
  values: { value: string; count: number }[];
}

/** Run a candidate mapping over the stored records without writing anything. */
export async function previewMapping(provider: ProviderKey, mapping: Mapping, sampleLimit = 8): Promise<MappingPreview> {
  const source = SOURCE_OF_PROVIDER[provider];
  const rows = await pool().query<{ name: string; provider_record: ProviderRecord }>(
    "SELECT name, provider_record FROM directory_people WHERE source = $1 AND provider_record IS NOT NULL ORDER BY name",
    [source]
  );
  const counts = new Map<string, number>();
  const samples: MappingPreview["samples"] = [];
  let filled = 0;
  for (const r of rows.rows) {
    const values = applyMapping(mapping, r.provider_record);
    if (values.length) {
      filled++;
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      if (samples.length < sampleLimit) samples.push({ name: r.name, values });
    }
  }
  return {
    total: rows.rows.length,
    filled,
    samples,
    values: [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, 200),
  };
}

/** Distinct raw values a field holds today, with counts — "values seen in data". */
export async function harvestValues(fieldKey: string): Promise<{ value: string; count: number }[]> {
  const fields = await listFields();
  const field = fields.find((f) => f.key === fieldKey);
  if (!field || field.kind === "people") return [];
  const column = field.builtin && ["title", "department", "office"].includes(field.key);
  const rows = await pool().query<{ v: string }>(
    column
      ? `SELECT ${field.key} AS v FROM directory_people WHERE hidden = 0`
      : "SELECT (synced || custom)->>$1 AS v FROM directory_people WHERE hidden = 0",
    column ? [] : [field.key]
  );
  const counts = new Map<string, number>();
  for (const r of rows.rows) {
    const tokens = field.multi ? splitMulti(r.v ?? "") : (r.v ?? "").trim() ? [(r.v ?? "").trim()] : [];
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 500);
}

// --- Directory presentation settings -----------------------------------------------------

export const LIST_COLUMNS_DEFAULT = ["name", "department", "phone", "email", "office"];

/** Admin-chosen default list columns; users may still override per browser. */
export async function getListColumns(fields?: DirectoryField[]): Promise<string[]> {
  const raw = await getSetting("directory_list_columns");
  let keys: string[] = LIST_COLUMNS_DEFAULT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) keys = parsed.map(String);
    } catch {}
  }
  const valid = validColumnKeys(fields ?? (await listFields()));
  const out = keys.filter((k, i) => valid.has(k) && keys.indexOf(k) === i);
  return out.length ? out : ["name"];
}

export async function setListColumns(columns: string[]): Promise<string[]> {
  const valid = validColumnKeys(await listFields());
  const out = columns.map(String).filter((k, i, a) => valid.has(k) && a.indexOf(k) === i);
  if (!out.length) throw new Error("Pick at least one column.");
  await setSetting("directory_list_columns", JSON.stringify(out));
  return out;
}

/** Every key a list column or export column may use. */
export function validColumnKeys(fields: DirectoryField[]): Set<string> {
  const keys = new Set<string>(["name", "title", "department", "email", "phone", "mobile", "office", "assists"]);
  for (const f of fields) {
    keys.add(f.key);
    if (f.kind === "people") keys.add(`${f.key}:in`);
  }
  return keys;
}

/** The field the grouped views open on (a group_by field key, default department). */
export async function getGroupByDefault(fields?: DirectoryField[]): Promise<string> {
  const raw = (await getSetting("directory_group_by_default"))?.trim();
  const all = fields ?? (await listFields());
  if (raw && all.some((f) => f.key === raw && f.group_by)) return raw;
  return "department";
}

export async function setGroupByDefault(key: string): Promise<void> {
  await setSetting("directory_group_by_default", key.trim());
}

// --- Print / export compatibility --------------------------------------------------------

/** Kept for callers that predate export presets; the default preset's columns. */
export async function getPrintColumns(): Promise<string[]> {
  const { defaultExportPreset } = await import("./directory-export-config");
  return (await defaultExportPreset()).columns;
}
