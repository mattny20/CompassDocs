import "server-only";
import { pool } from "@/lib/db";
import type { SpaceScope } from "@/lib/space-scope";

// The "Replaced by" picker's options (G3, 1.12.0): every published, live,
// non-branch document the caller may see, other than the policy itself,
// most recently updated first (the order EntityPicker wants). Titles and
// spaces only: the picker searches names, so it never needs the text. The
// same rule setSupersededBy enforces on the PATCH, so nothing the picker
// offers is refused on save.

export interface ReplacementOption {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
}

/** A ceiling, not a page: the picker caps what it shows and asks to keep typing. */
const MAX_OPTIONS = 5000;

export async function listReplacementCandidates(docId: number, scope: SpaceScope): Promise<ReplacementOption[]> {
  const scoped = Array.isArray(scope);
  const r = await pool().query<ReplacementOption>(
    `SELECT d.id, d.title, s.name AS space_name, s.icon AS space_icon
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.status = 'published' AND d.deleted_at IS NULL AND d.branch_of IS NULL AND d.id <> $1
       ${scoped ? "AND d.space_id = ANY($3)" : ""}
     ORDER BY d.updated_at DESC, d.id DESC
     LIMIT $2`,
    scoped ? [docId, MAX_OPTIONS, scope] : [docId, MAX_OPTIONS]
  );
  return r.rows;
}
