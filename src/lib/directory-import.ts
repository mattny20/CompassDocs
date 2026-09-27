import "server-only";

// CSV import for the directory: the same file the export produces, or a
// spreadsheet someone kept, read back into people. Two steps — a plan that
// says what each row would do (create, update, skip, error) and an apply
// that does exactly that — so an admin sees the effect before it happens.
//
// Rows match existing people by email first, then by exact name. A row that
// matches a synced person updates only the manual layer and links (the
// provider owns the columns); one that matches nobody becomes a manual row.

import { parseCsv } from "./csv";
import { createPerson, listFields, listPeople, updatePerson, type DirectoryField, type DirectoryPerson } from "./directory";
import { buildPeopleIndex } from "./directory-people-resolve";
import { BUILTIN_COLUMN_KEYS } from "./directory-display";

export type ImportTarget = (typeof BUILTIN_COLUMN_KEYS)[number] | string; // field key, or "" to ignore

export interface ImportColumn {
  index: number;
  header: string;
  /** The suggested target: a built-in key, a field key, a people-field key, or "". */
  target: string;
  sample: string;
}

export interface ImportRowPlan {
  row: number;
  action: "create" | "update" | "skip" | "error";
  name: string;
  email: string;
  /** For updates: the id matched, and what changes. */
  id?: number;
  changes?: string[];
  reason?: string;
}

export interface ImportPlan {
  columns: ImportColumn[];
  rows: ImportRowPlan[];
  counts: { create: number; update: number; skip: number; error: number };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Which field a header most plausibly names. */
export function suggestTarget(header: string, fields: DirectoryField[]): string {
  const h = norm(header);
  if (!h) return "";
  const builtin: Record<string, string> = {
    name: "name", "full name": "name", "display name": "name",
    title: "title", "job title": "title", position: "title",
    department: "department", dept: "department",
    email: "email", "e mail": "email", mail: "email", "email address": "email",
    phone: "phone", "work phone": "phone", "business phone": "phone", telephone: "phone", extension: "phone",
    mobile: "mobile", cell: "mobile", "mobile phone": "mobile", "cell phone": "mobile",
    office: "office", location: "office", "office location": "office",
    assistant: "assistant", assistants: "assistant",
  };
  if (builtin[h]) return builtin[h];
  for (const f of fields) {
    if (norm(f.label) === h || norm(f.key) === h) return f.key;
  }
  return "";
}

export function analyzeCsv(text: string, fields: DirectoryField[]): { columns: ImportColumn[]; rowCount: number } {
  const parsed = parseCsv(text);
  return {
    columns: parsed.header.map((header, index) => ({
      index,
      header,
      target: suggestTarget(header, fields),
      sample: parsed.rows.find((r) => (r[index] ?? "").trim())?.[index]?.trim().slice(0, 40) ?? "",
    })),
    rowCount: parsed.rows.length,
  };
}

/**
 * Plan (and optionally apply) an import. `mapping` maps column index →
 * target key; columns absent from it are ignored.
 */
export async function importCsv(
  text: string,
  mapping: Record<string, string>,
  opts: { apply: boolean; limit?: number }
): Promise<ImportPlan> {
  const parsed = parseCsv(text);
  const fields = await listFields();
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const people = await listPeople({ includeHidden: true });
  const index = buildPeopleIndex(people.map((p) => ({ id: p.id, external_id: p.external_id, email: p.email, name: p.name, record: null })));
  const byId = new Map(people.map((p) => [p.id, p]));
  const targets = new Map<number, string>();
  for (const [col, key] of Object.entries(mapping)) {
    const i = Number(col);
    if (!Number.isInteger(i) || !key) continue;
    if ((BUILTIN_COLUMN_KEYS as readonly string[]).includes(key) || byKey.has(key)) targets.set(i, key);
  }
  const columns = analyzeCsv(text, fields).columns.map((c) => ({ ...c, target: targets.get(c.index) ?? "" }));
  const plan: ImportPlan = { columns, rows: [], counts: { create: 0, update: 0, skip: 0, error: 0 } };
  const limit = opts.limit ?? 5000;
  const seenEmails = new Set<string>();

  for (let r = 0; r < Math.min(parsed.rows.length, limit); r++) {
    const row = parsed.rows[r];
    const values: Record<string, string> = {};
    for (const [i, key] of targets) values[key] = (row[i] ?? "").trim();
    const name = values.name ?? "";
    const email = (values.email ?? "").toLowerCase();
    const entry: ImportRowPlan = { row: r + 2, action: "skip", name, email };
    if (!name && !email) {
      entry.action = "error";
      entry.reason = "No name and no email.";
    } else if (email && seenEmails.has(email)) {
      entry.action = "error";
      entry.reason = "Duplicate email in the file.";
    } else {
      if (email) seenEmails.add(email);
      const hit = (email && index.resolve(email)) || (name && index.resolve(name)) || undefined;
      const existing = hit && "id" in hit ? byId.get(hit.id) : undefined;
      if (hit && "ambiguous" in hit && !email) {
        entry.action = "error";
        entry.reason = `${hit.ambiguous} people share this name — add an email column to tell them apart.`;
      } else if (existing) {
        const synced = existing.source !== "manual";
        const changes: string[] = [];
        const core: Record<string, string> = {};
        for (const k of ["name", "title", "department", "email", "phone", "mobile", "office"] as const) {
          if (values[k] === undefined) continue;
          if (synced) continue; // the provider owns these
          if ((existing[k] ?? "") !== values[k]) {
            changes.push(k);
            core[k] = values[k];
          }
        }
        const custom: Record<string, string | null> = {};
        const links: Record<string, number[]> = {};
        for (const [key, v] of Object.entries(values)) {
          const f = byKey.get(key);
          if (!f || f.builtin) continue;
          if (f.kind === "people") {
            const ids = resolveNames(index, v);
            const cur = (existing.links[key] ?? []).map((l) => l.id).sort((a, b) => a - b);
            if (ids.join(",") !== cur.join(",")) {
              changes.push(key);
              links[key] = ids;
            }
            continue;
          }
          if ((existing.manual[key] ?? existing.custom[key] ?? "") !== v) {
            changes.push(key);
            custom[key] = v === "" ? null : v;
          }
        }
        if (changes.length) {
          entry.action = "update";
          entry.id = existing.id;
          entry.changes = changes;
          if (opts.apply) {
            await updatePerson(existing.id, { ...(synced ? {} : core), custom, ...(Object.keys(links).length ? { links: { ...Object.fromEntries((fields.filter((f) => f.kind === "people")).map((f) => [f.key, (existing.links[f.key] ?? []).map((l) => l.id)])), ...links } } : {}) });
          }
        } else {
          entry.action = "skip";
          entry.reason = "Nothing to change.";
        }
      } else if (!name) {
        entry.action = "error";
        entry.reason = "A new person needs a name.";
      } else {
        entry.action = "create";
        if (opts.apply) {
          const custom: Record<string, string> = {};
          const links: Record<string, number[]> = {};
          for (const [key, v] of Object.entries(values)) {
            const f = byKey.get(key);
            if (!f || f.builtin || !v) continue;
            if (f.kind === "people") links[key] = resolveNames(index, v);
            else custom[key] = v;
          }
          const created = await createPerson({
            name,
            title: values.title,
            department: values.department,
            email: values.email,
            phone: values.phone,
            mobile: values.mobile,
            office: values.office,
            custom,
            links,
          });
          entry.id = created.id;
        }
      }
    }
    plan.rows.push(entry);
    plan.counts[entry.action]++;
  }
  return plan;
}

function resolveNames(index: ReturnType<typeof buildPeopleIndex>, value: string): number[] {
  const ids = new Set<number>();
  for (const { hit } of index.resolveList(value)) if (hit && "id" in hit) ids.add(hit.id);
  return [...ids].sort((a, b) => a - b);
}

export type { DirectoryPerson };
