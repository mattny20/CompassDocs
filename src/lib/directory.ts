// People directory — data access. Rows come from two sources:
//   'manual' — entered by an admin in Settings → Directory (community & enterprise)
//   'graph'  — synced from Microsoft Entra ID by the enterprise overlay, keyed
//              by external_id (the Graph user id)
// The viewer-facing directory only ever sees rows with hidden = 0.
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
  updated_at: string;
}

const COLS =
  "id, source, external_id, name, title, department, email, phone, mobile, office, photo, hidden, updated_at";

/** Visible people for the directory page, optionally filtered. */
export async function listPeople(opts?: {
  q?: string;
  department?: string;
  includeHidden?: boolean;
}): Promise<DirectoryPerson[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts?.includeHidden) where.push("hidden = 0");
  if (opts?.q) {
    params.push(`%${opts.q}%`);
    const p = `$${params.length}`;
    where.push(
      `(name ILIKE ${p} OR title ILIKE ${p} OR department ILIKE ${p} OR email ILIKE ${p})`
    );
  }
  if (opts?.department) {
    params.push(opts.department);
    where.push(`department = $${params.length}`);
  }
  const sql = `SELECT ${COLS} FROM directory_people${
    where.length ? " WHERE " + where.join(" AND ") : ""
  } ORDER BY name`;
  return (await pool().query<DirectoryPerson>(sql, params)).rows;
}

/** Distinct non-empty departments among visible people (for the filter menu). */
export async function listDepartments(): Promise<string[]> {
  const res = await pool().query<{ department: string }>(
    "SELECT DISTINCT department FROM directory_people WHERE hidden = 0 AND department <> '' ORDER BY department"
  );
  return res.rows.map((r) => r.department);
}

export interface PersonInput {
  name: string;
  title?: string;
  department?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  office?: string;
  photo?: string;
}

export async function createPerson(input: PersonInput): Promise<DirectoryPerson> {
  const res = await pool().query<DirectoryPerson>(
    `INSERT INTO directory_people (source, name, title, department, email, phone, mobile, office, photo)
     VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
    [
      input.name.trim(),
      (input.title ?? "").trim(),
      (input.department ?? "").trim(),
      (input.email ?? "").trim(),
      (input.phone ?? "").trim(),
      (input.mobile ?? "").trim(),
      (input.office ?? "").trim(),
      input.photo ?? "",
    ]
  );
  return res.rows[0];
}

export async function updatePerson(
  id: number,
  fields: Partial<PersonInput> & { hidden?: boolean }
): Promise<DirectoryPerson | undefined> {
  const existing = (
    await pool().query<DirectoryPerson>(
      `SELECT ${COLS} FROM directory_people WHERE id = $1`,
      [id]
    )
  ).rows[0];
  if (!existing) return undefined;
  const res = await pool().query<DirectoryPerson>(
    `UPDATE directory_people SET
       name = $1, title = $2, department = $3, email = $4, phone = $5,
       mobile = $6, office = $7, photo = $8, hidden = $9, updated_at = now()
     WHERE id = $10 RETURNING ${COLS}`,
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
      id,
    ]
  );
  return res.rows[0];
}

export async function deletePerson(id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM directory_people WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

export interface GraphPersonInput extends PersonInput {
  external_id: string;
}

/**
 * Replace the Graph-sourced portion of the directory with `people` (upsert by
 * external_id, delete Graph rows that disappeared from the tenant). Manual rows
 * and per-row `hidden` flags are preserved. Returns the synced row count.
 */
export async function replaceGraphPeople(people: GraphPersonInput[]): Promise<number> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    for (const p of people) {
      await client.query(
        `INSERT INTO directory_people
           (source, external_id, name, title, department, email, phone, mobile, office, photo)
         VALUES ('graph', $1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           name = EXCLUDED.name, title = EXCLUDED.title, department = EXCLUDED.department,
           email = EXCLUDED.email, phone = EXCLUDED.phone, mobile = EXCLUDED.mobile,
           office = EXCLUDED.office,
           photo = CASE WHEN EXCLUDED.photo <> '' THEN EXCLUDED.photo ELSE directory_people.photo END,
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
