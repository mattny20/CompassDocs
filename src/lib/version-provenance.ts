// Who published and approved each version a record cites (C6, 1.10.1).
//
// Both compliance CSVs append version_published_by and version_approved_by:
// the name stamped on the version at publish time (the byline for versions
// that predate the stamp; the one-shot backfill in db.ts fills it) and the
// approver's name when the version came through a change request. One query
// per document, keyed by version id, so a 500-row roster costs one round
// trip rather than one per row.

import { pool } from "@/lib/db";

export interface VersionProvenance {
  published_by_name: string;
  approved_by_name: string;
}

export async function versionProvenance(docId: number): Promise<Map<number, VersionProvenance>> {
  const r = await pool().query<{ id: number; published_by_name: string; approved_by_name: string }>(
    `SELECT id,
            COALESCE(NULLIF(published_by_name, ''), author, '') AS published_by_name,
            COALESCE(approved_by_name, '') AS approved_by_name
       FROM doc_versions WHERE document_id = $1`,
    [docId]
  );
  return new Map(r.rows.map((v) => [v.id, { published_by_name: v.published_by_name, approved_by_name: v.approved_by_name }]));
}

/** The two CSV cells for a row's version id ('' when the version is unknown or inferred). */
export function provenanceCells(map: Map<number, VersionProvenance>, versionId: number | null | undefined): [string, string] {
  const p = versionId != null ? map.get(versionId) : undefined;
  return [p?.published_by_name ?? "", p?.approved_by_name ?? ""];
}
