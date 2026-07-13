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

export interface DirectoryPerson {
  id: number;
  source: "manual" | "graph";
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
  graph_path: string; // "" = manual-only field
  show_in_card: number; // 0 | 1
  sort: number;
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

/** Distinct non-empty departments among visible people (for the filter menu). */
export async function listDepartments(): Promise<string[]> {
  const res = await pool().query<{ department: string }>(
    "SELECT DISTINCT department FROM directory_people WHERE hidden = 0 AND department <> '' ORDER BY department"
  );
  return res.rows.map((r) => r.department);
}

// --- Custom field definitions -------------------------------------------------

const FIELD_COLS = "id, key, label, graph_path, show_in_card, sort";
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
  show_in_card?: boolean;
}): Promise<DirectoryField> {
  const key = (input.key?.trim() || slugifyFieldKey(input.label)).toLowerCase();
  if (!KEY_RE.test(key)) throw new Error("Field key must be 1–40 chars of a–z, 0–9, _");
  const res = await pool().query<DirectoryField>(
    `INSERT INTO directory_fields (key, label, graph_path, show_in_card, sort)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort)+1 FROM directory_fields), 0))
     RETURNING ${FIELD_COLS}`,
    [key, input.label.trim(), (input.graph_path ?? "").trim(), input.show_in_card ? 1 : 0]
  );
  return res.rows[0];
}

export async function updateField(
  id: number,
  fields: { label?: string; graph_path?: string; show_in_card?: boolean; sort?: number }
): Promise<DirectoryField | undefined> {
  const existing = (
    await pool().query<DirectoryField>(
      `SELECT ${FIELD_COLS} FROM directory_fields WHERE id = $1`,
      [id]
    )
  ).rows[0];
  if (!existing) return undefined;
  const res = await pool().query<DirectoryField>(
    `UPDATE directory_fields SET label = $1, graph_path = $2, show_in_card = $3, sort = $4
     WHERE id = $5 RETURNING ${FIELD_COLS}`,
    [
      (fields.label ?? existing.label).trim(),
      (fields.graph_path ?? existing.graph_path).trim(),
      fields.show_in_card === undefined ? existing.show_in_card : fields.show_in_card ? 1 : 0,
      fields.sort ?? existing.sort,
      id,
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

export interface GraphPersonInput extends PersonInput {
  external_id: string;
}

/**
 * Replace the Graph-sourced portion of the directory with `people` (upsert by
 * external_id, delete Graph rows that disappeared from the tenant). Manual rows,
 * per-row `hidden` flags, assistant links, and custom values for keys the sync
 * doesn't map are all preserved (jsonb merge — synced keys win). Returns the
 * synced row count.
 */
export async function replaceGraphPeople(people: GraphPersonInput[]): Promise<number> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    for (const p of people) {
      await client.query(
        `INSERT INTO directory_people
           (source, external_id, name, title, department, email, phone, mobile, office, photo, custom)
         VALUES ('graph', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        ]
      );
    }
    await client.query(
      `DELETE FROM directory_people
       WHERE source = 'graph' AND NOT (external_id = ANY($1::text[]))`,
      [people.map((p) => p.external_id)]
    );
    await client.query("COMMIT");
    return people.length;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
