// People directory — data access. Rows come from two sources:
//   'manual' — entered by an admin in Settings → Directory (community & enterprise)
//   'graph'  — synced from Microsoft Entra ID by the enterprise overlay, keyed
//              by external_id (the Graph user id)
// The viewer-facing directory only ever sees rows with hidden = 0.
//
// v2 additions: an assistant link (person → person), and admin-defined custom
// fields stored per-person in a jsonb column, with optional Microsoft Graph
// property mappings (directory_fields.graph_path) used by the enterprise sync.
//
// Server-only: uses the Postgres pool.

import { pool } from "./db";

/**
 * Where a directory row came from. "manual" rows are typed in by an admin;
 * the rest are owned by a sync, which is what makes them deletable by that
 * sync — and only by that sync (0.96).
 */
export type PersonSource = "manual" | "graph" | "google";

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
  assistant_id: number | null;
  assistant_name: string | null; // joined for display
  custom: Record<string, string>;
  updated_at: string;
}

export interface DirectoryField {
  id: number;
  key: string;
  label: string;
  graph_path: string; // Microsoft attribute path; "" = not mapped from Graph
  /** Google attribute path; "" = not mapped from Workspace (0.97). */
  google_path: string;
  show_in_card: number; // 0 | 1
  sort: number;
  /** field = label + text value; tag = comma-separated values as badges. */
  display: "field" | "tag";
}

const COLS =
  "p.id, p.source, p.external_id, p.name, p.title, p.department, p.email, p.phone, p.mobile, p.office, p.photo, p.hidden, p.assistant_id, a.name AS assistant_name, p.custom, p.updated_at";
const FROM = "FROM directory_people p LEFT JOIN directory_people a ON a.id = p.assistant_id";

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
      `(p.name ILIKE ${p} OR p.title ILIKE ${p} OR p.department ILIKE ${p} OR p.email ILIKE ${p} OR p.custom::text ILIKE ${p})`
    );
  }
  if (opts?.department) {
    params.push(opts.department);
    where.push(`p.department = $${params.length}`);
  }
  const sql = `SELECT ${COLS} ${FROM}${
    where.length ? " WHERE " + where.join(" AND ") : ""
  } ORDER BY p.name`;
  return (await pool().query<DirectoryPerson>(sql, params)).rows;
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
  const rows = await pool().query<DirectoryPerson & { hits: number }>(
    `SELECT ${COLS}, (${per.join(" + ")}) AS hits
     ${FROM}
     WHERE p.hidden = 0 AND (${per.join(" + ")}) > 0
     ORDER BY hits DESC, p.name
     LIMIT ${Math.max(1, Math.min(10, limit))}`,
    params
  );
  return rows.rows;
}

/**
 * One row of the command-palette people typeahead. Deliberately narrow: no
 * photo blob, no custom fields, no `hidden`, no assistant, no source /
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

// --- Custom field definitions -------------------------------------------------

const FIELD_COLS = "id, key, label, graph_path, google_path, show_in_card, sort, display";
const KEY_RE = /^[a-z0-9_]{1,40}$/;

export function slugifyFieldKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export async function listFields(): Promise<DirectoryField[]> {
  return (
    await pool().query<DirectoryField>(
      `SELECT ${FIELD_COLS} FROM directory_fields ORDER BY sort, id`
    )
  ).rows;
}

export async function createField(input: {
  key?: string;
  label: string;
  graph_path?: string;
  google_path?: string;
  show_in_card?: boolean;
  display?: "field" | "tag";
}): Promise<DirectoryField> {
  const key = (input.key?.trim() || slugifyFieldKey(input.label)).toLowerCase();
  if (!KEY_RE.test(key)) throw new Error("Field key must be 1–40 chars of a–z, 0–9, _");
  const res = await pool().query<DirectoryField>(
    `INSERT INTO directory_fields (key, label, graph_path, google_path, show_in_card, sort, display)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort)+1 FROM directory_fields), 0), $5)
     RETURNING ${FIELD_COLS}`,
    [
      key,
      input.label.trim(),
      (input.graph_path ?? "").trim(),
      (input.google_path ?? "").trim(),
      input.show_in_card ? 1 : 0,
      input.display === "tag" ? "tag" : "field",
    ]
  );
  return res.rows[0];
}

export async function updateField(
  id: number,
  fields: {
    label?: string;
    graph_path?: string;
    google_path?: string;
    show_in_card?: boolean;
    sort?: number;
    display?: "field" | "tag";
  }
): Promise<DirectoryField | undefined> {
  const existing = (
    await pool().query<DirectoryField>(
      `SELECT ${FIELD_COLS} FROM directory_fields WHERE id = $1`,
      [id]
    )
  ).rows[0];
  if (!existing) return undefined;
  const res = await pool().query<DirectoryField>(
    `UPDATE directory_fields SET label = $1, graph_path = $2, google_path = $7, show_in_card = $3, sort = $4,
       display = $5
     WHERE id = $6 RETURNING ${FIELD_COLS}`,
    [
      (fields.label ?? existing.label).trim(),
      (fields.graph_path ?? existing.graph_path).trim(),
      fields.show_in_card === undefined ? existing.show_in_card : fields.show_in_card ? 1 : 0,
      fields.sort ?? existing.sort,
      fields.display === undefined ? existing.display : fields.display === "tag" ? "tag" : "field",
      id,
      (fields.google_path ?? existing.google_path ?? "").trim(),
    ]
  );
  return res.rows[0];
}

export async function deleteField(id: number): Promise<boolean> {
  // Remove the definition AND scrub the key from every person's custom blob.
  const f = (
    await pool().query<DirectoryField>(
      `SELECT ${FIELD_COLS} FROM directory_fields WHERE id = $1`,
      [id]
    )
  ).rows[0];
  if (!f) return false;
  await pool().query("UPDATE directory_people SET custom = custom - $1 WHERE custom ? $1", [f.key]);
  await pool().query("DELETE FROM directory_fields WHERE id = $1", [id]);
  return true;
}

/** Keep only known field keys, coerce values to trimmed strings. */
async function sanitizeCustom(
  raw: unknown
): Promise<Record<string, string>> {
  if (!raw || typeof raw !== "object") return {};
  const keys = new Set((await listFields()).map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (keys.has(k)) out[k] = String(v ?? "").slice(0, 500).trim();
  }
  return out;
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
  assistant_id?: number | null;
  custom?: Record<string, string>;
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
  const linked = (
    await pool().query<DirectoryPerson>(
      `SELECT ${COLS} FROM users u
       JOIN directory_people p ON p.id = u.directory_person_id
       LEFT JOIN directory_people a ON a.id = p.assistant_id
       WHERE lower(u.name) = lower($1) AND p.hidden = 0
       LIMIT 1`,
      [name.trim()]
    )
  ).rows[0];
  return linked ?? getPersonByName(name);
}

/** Case-insensitive exact-name lookup (linking doc bylines to profiles). */
export async function getPersonByName(name: string): Promise<DirectoryPerson | undefined> {
  if (!name.trim()) return undefined;
  return (
    await pool().query<DirectoryPerson>(
      `SELECT ${COLS} ${FROM} WHERE p.hidden = 0 AND lower(p.name) = lower($1) LIMIT 1`,
      [name.trim()]
    )
  ).rows[0];
}

async function getPerson(id: number): Promise<DirectoryPerson | undefined> {
  return (
    await pool().query<DirectoryPerson>(`SELECT ${COLS} ${FROM} WHERE p.id = $1`, [id])
  ).rows[0];
}

export async function createPerson(input: PersonInput): Promise<DirectoryPerson> {
  const custom = await sanitizeCustom(input.custom);
  const res = await pool().query<{ id: number }>(
    `INSERT INTO directory_people
       (source, name, title, department, email, phone, mobile, office, photo, assistant_id, custom)
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
      input.assistant_id ?? null,
      JSON.stringify(custom),
    ]
  );
  return (await getPerson(res.rows[0].id))!;
}

export async function updatePerson(
  id: number,
  fields: Partial<PersonInput> & { hidden?: boolean }
): Promise<DirectoryPerson | undefined> {
  const existing = await getPerson(id);
  if (!existing) return undefined;
  // No self-assistants; a dangling id is rejected by the FK.
  const assistant =
    fields.assistant_id === undefined
      ? existing.assistant_id
      : fields.assistant_id === id
        ? null
        : fields.assistant_id;
  const custom =
    fields.custom === undefined
      ? existing.custom
      : { ...existing.custom, ...(await sanitizeCustom(fields.custom)) };
  await pool().query(
    `UPDATE directory_people SET
       name = $1, title = $2, department = $3, email = $4, phone = $5,
       mobile = $6, office = $7, photo = $8, hidden = $9, assistant_id = $10,
       custom = $11, updated_at = now()
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
      assistant,
      JSON.stringify(custom),
      id,
    ]
  );
  return getPerson(id);
}

export async function deletePerson(id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM directory_people WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

// --- Graph sync ----------------------------------------------------------------

export interface ProviderPersonInput extends PersonInput {
  external_id: string;
}

/** Kept as the Microsoft-shaped alias so the EE overlay needs no coordinated release. */
export type GraphPersonInput = ProviderPersonInput;

/**
 * Replace the Graph-sourced portion of the directory with `people` (upsert by
 * external_id, delete Graph rows that disappeared from the tenant). Manual rows,
 * per-row `hidden` flags, assistant links, and custom values for keys the sync
 * doesn't map are all preserved (jsonb merge — synced keys win). Returns the
 * synced row count.
 */
export async function replaceGraphPeople(people: GraphPersonInput[]): Promise<number> {
  const { upserted } = await replaceProviderPeople("graph", people);
  return upserted;
}

/**
 * Replace one provider's portion of the directory: upsert by external_id, then
 * delete that provider's rows which have disappeared upstream. Manual rows,
 * per-row `hidden` flags, assistant links, and custom values for keys the sync
 * doesn't map are all preserved (jsonb merge — synced keys win).
 *
 * The `source` parameter is the whole point (0.96). Both the INSERT and the
 * DELETE used to hardcode 'graph'; with a second provider writing to the same
 * table that becomes "whichever directory synced last deletes the other one's
 * people". Scoping the delete to the source doing the syncing is what makes two
 * directories able to coexist.
 *
 * `maxDeleteFraction` is a safety valve on the delete. A misconfigured
 * credential or a filter that suddenly matches nothing arrives here as an empty
 * `people` array, which without a brake means "delete every synced person".
 * When the proportion to remove exceeds the limit the delete is skipped, the
 * upserts still commit, and the caller is told why — an operator can then look
 * at it, rather than restoring a directory from a backup.
 */
export async function replaceProviderPeople(
  source: Exclude<PersonSource, "manual">,
  people: ProviderPersonInput[],
  opts?: { maxDeleteFraction?: number }
): Promise<{ upserted: number; deleted: number; abortedDelete?: string }> {
  const maxFraction = opts?.maxDeleteFraction ?? 0.5;
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    for (const p of people) {
      await client.query(
        `INSERT INTO directory_people
           (source, external_id, name, title, department, email, phone, mobile, office, photo, custom)
         VALUES ($11, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           name = EXCLUDED.name, title = EXCLUDED.title, department = EXCLUDED.department,
           email = EXCLUDED.email, phone = EXCLUDED.phone, mobile = EXCLUDED.mobile,
           office = EXCLUDED.office,
           photo = CASE WHEN EXCLUDED.photo <> '' THEN EXCLUDED.photo ELSE directory_people.photo END,
           custom = directory_people.custom || EXCLUDED.custom,
           updated_at = now()`,
        [
          p.external_id,
          p.name.trim(),
          (p.title ?? "").trim(),
          (p.department ?? "").trim(),
          (p.email ?? "").trim(),
          (p.phone ?? "").trim(),
          (p.mobile ?? "").trim(),
          (p.office ?? "").trim(),
          p.photo ?? "",
          JSON.stringify(p.custom ?? {}),
          source,
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
    let abortedDelete: string | undefined;
    if (doomed > 0 && total > 0 && doomed / total > maxFraction) {
      abortedDelete =
        `Skipped removing ${doomed} of ${total} synced people — that is more than ` +
        `${Math.round(maxFraction * 100)}% of this directory. Check the connection and ` +
        `filters, then sync again; the people that did arrive have been updated.`;
    } else if (doomed > 0) {
      const res = await client.query(
        `DELETE FROM directory_people
          WHERE source = $1 AND NOT (external_id = ANY($2::text[]))`,
        [source, ids]
      );
      deleted = res.rowCount ?? 0;
    }

    await client.query("COMMIT");
    if (abortedDelete) console.warn(`[directory:${source}] ${abortedDelete}`);
    return { upserted: people.length, deleted, abortedDelete };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// --- Quick print directory ----------------------------------------------------
//
// Admins pick which columns (built-ins and custom fields) the printable
// directory shows, and in what order. Stored as a JSON array of keys in the
// settings table; unknown keys are dropped on read so a deleted custom field
// degrades silently.

export const PRINT_BUILTINS: { key: string; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "title", label: "Title" },
  { key: "department", label: "Department" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "mobile", label: "Mobile" },
  { key: "office", label: "Office" },
  { key: "assistant", label: "Assistant" },
];

export const PRINT_COLUMNS_DEFAULT = ["name", "title", "department", "phone", "email"];

/** The configured print columns, valid keys only, always at least Name. */
export async function getPrintColumns(): Promise<string[]> {
  const { getSetting } = await import("./db");
  const raw = await getSetting("directory_print_columns");
  let keys: string[] = PRINT_COLUMNS_DEFAULT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) keys = parsed.map(String);
    } catch {}
  }
  const valid = new Set([
    ...PRINT_BUILTINS.map((b) => b.key),
    ...(await listFields()).map((f) => f.key),
  ]);
  const out = keys.filter((k, i) => valid.has(k) && keys.indexOf(k) === i);
  return out.length ? out : ["name"];
}

/** The value a person shows for a print column key. */
export function printValue(p: DirectoryPerson, key: string): string {
  switch (key) {
    case "name": return p.name;
    case "title": return p.title;
    case "department": return p.department;
    case "email": return p.email;
    case "phone": return p.phone;
    case "mobile": return p.mobile;
    case "office": return p.office;
    case "assistant": return p.assistant_name ?? "";
    default: return p.custom?.[key] ?? "";
  }
}
