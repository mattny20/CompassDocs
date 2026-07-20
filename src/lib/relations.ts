// Typed relationships between documents. A link is stored once
// (doc_id → target_id, kind) and shown on BOTH documents with
// direction-appropriate labels: a procedure linked to its policy via
// "procedure_for" appears as "Procedure for" on the procedure and under
// "Procedures" on the policy. Visibility is enforced at query time — a
// related document the viewer can't open is simply not listed. Server-only.

import "server-only";
import { pool } from "./db";
import type { SpaceScope } from "./access";
import type { DocStatus, DocType } from "./types";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

export type RelationKind = "related" | "procedure_for" | "supersedes";

export const RELATION_KINDS: {
  kind: RelationKind;
  /** Label on the source doc (doc_id side). */
  forward: string;
  /** Label on the target doc (target_id side). */
  reverse: string;
  /** How the picker phrases it: "This document <phrase> …" */
  phrase: string;
}[] = [
  { kind: "related", forward: "Related", reverse: "Related", phrase: "is related to" },
  { kind: "procedure_for", forward: "Procedure for", reverse: "Procedures", phrase: "is a procedure for" },
  { kind: "supersedes", forward: "Supersedes", reverse: "Superseded by", phrase: "supersedes" },
];

export interface RelatedDoc {
  relation_id: number;
  kind: RelationKind;
  /** Group heading this entry renders under on the current doc. */
  label: string;
  id: number;
  title: string;
  type: DocType;
  status: DocStatus;
  space_name: string;
  space_icon: string;
}

/**
 * Every relation touching this doc, resolved to the "other" document, with
 * the label as seen FROM this doc. Filtered to documents the viewer can see
 * (space scope, drafts only for editors, never branches or trashed docs).
 */
export async function relationsFor(
  docId: number,
  scope: SpaceScope,
  includeDrafts: boolean
): Promise<RelatedDoc[]> {
  const filter =
    (includeDrafts ? "" : " AND d.status = 'published'") +
    (Array.isArray(scope) ? " AND d.space_id = ANY($2)" : "");
  const params: any[] = Array.isArray(scope) ? [docId, scope] : [docId];
  const rows = await q(
    `SELECT r.id AS relation_id, r.kind,
            (r.doc_id = $1) AS outgoing,
            d.id, d.title, d.type, d.status,
            s.name AS space_name, s.icon AS space_icon
     FROM doc_relations r
     JOIN documents d ON d.id = CASE WHEN r.doc_id = $1 THEN r.target_id ELSE r.doc_id END
     JOIN spaces s ON s.id = d.space_id
     WHERE (r.doc_id = $1 OR r.target_id = $1)
       AND d.deleted_at IS NULL AND d.branch_of IS NULL${filter}
     ORDER BY r.created_at`,
    params
  );
  return rows.map((r) => {
    const def = RELATION_KINDS.find((k) => k.kind === r.kind) ?? RELATION_KINDS[0];
    return {
      relation_id: r.relation_id,
      kind: r.kind,
      label: r.outgoing ? def.forward : def.reverse,
      id: r.id,
      title: r.title,
      type: r.type,
      status: r.status,
      space_name: r.space_name,
      space_icon: r.space_icon,
    };
  });
}

/** Create a link; returns false when it already exists. */
export async function addRelation(
  docId: number,
  targetId: number,
  kind: RelationKind,
  createdBy: number
): Promise<boolean> {
  const res = await pool().query(
    `INSERT INTO doc_relations (doc_id, target_id, kind, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (doc_id, target_id, kind) DO NOTHING`,
    [docId, targetId, kind, createdBy]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Remove a link by id, but only if it touches the given doc (route guard). */
export async function removeRelation(relationId: number, docId: number): Promise<boolean> {
  const res = await pool().query(
    "DELETE FROM doc_relations WHERE id = $1 AND (doc_id = $2 OR target_id = $2)",
    [relationId, docId]
  );
  return (res.rowCount ?? 0) > 0;
}
