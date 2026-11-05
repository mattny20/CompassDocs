// The policy page's own metadata (Handbooks 1.18.0): "In short" (up to five
// short points, documents.summary_points) and "Applies to" (short text,
// documents.applies_to). Written from the document editor's Properties
// through PUT /api/documents/[id]; read wherever a policy is shown as a
// policy page (the handbook reader and the printed handbook). Server-only.

import "server-only";
import { pool } from "./db";

export interface PolicyFacts {
  summary_points: string[];
  applies_to: string;
}

export interface PolicyFactsPatch {
  summary_points?: string[];
  applies_to?: string;
}

/** Same points in the same order. */
export function samePoints(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** The fields of `patch` that differ from `current`, as a {field: new value} record (empty = no change). */
export function policyFactsChanges(current: PolicyFacts, patch: PolicyFactsPatch): PolicyFactsPatch {
  const out: PolicyFactsPatch = {};
  if (patch.summary_points !== undefined && !samePoints(current.summary_points, patch.summary_points)) {
    out.summary_points = patch.summary_points;
  }
  if (patch.applies_to !== undefined && patch.applies_to !== current.applies_to) {
    out.applies_to = patch.applies_to;
  }
  return out;
}

/** The stored facts of a document (empty for an unknown one). */
export async function getPolicyFacts(docId: number): Promise<PolicyFacts> {
  const r = await pool().query<PolicyFacts>(
    "SELECT summary_points, applies_to FROM documents WHERE id = $1",
    [docId]
  );
  return { summary_points: r.rows[0]?.summary_points ?? [], applies_to: r.rows[0]?.applies_to ?? "" };
}

/** Write the given fields (already parsed and bounded by the caller). */
export async function setPolicyFacts(docId: number, patch: PolicyFactsPatch): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [docId];
  if (patch.summary_points !== undefined) {
    vals.push(patch.summary_points);
    sets.push(`summary_points = $${vals.length}::text[]`);
  }
  if (patch.applies_to !== undefined) {
    vals.push(patch.applies_to);
    sets.push(`applies_to = $${vals.length}`);
  }
  if (!sets.length) return;
  await pool().query(`UPDATE documents SET ${sets.join(", ")} WHERE id = $1`, vals);
}
