// Automatic backlinks: every save re-extracts the internal /doc/N links from
// a document's markdown into doc_links, so any document can show who links to
// it without anyone maintaining anything. Extraction always runs (it's a
// cheap regex + upsert); the admin toggle only gates display and the editor's
// [[ autocomplete, so flipping it on later has fresh data waiting.

import "server-only";
import { pool } from "./db";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

/** Doc ids referenced by markdown links like [text](/doc/123) — host-relative or absolute. */
export function extractDocLinkIds(markdown: string): number[] {
  const ids = new Set<number>();
  const re = /\]\((?:https?:\/\/[^/)\s]+)?\/doc\/(\d+)(?:[?#][^)\s]*)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) ids.add(Number(m[1]));
  return [...ids];
}

/** Refresh the doc_links rows for one document from its current content. */
export async function syncDocLinks(docId: number): Promise<void> {
  try {
    const doc = (await q<{ content: string }>("SELECT content FROM documents WHERE id = $1", [docId]))[0];
    if (!doc) return;
    const ids = extractDocLinkIds(doc.content).filter((id) => id !== docId);
    await q("DELETE FROM doc_links WHERE from_id = $1", [docId]);
    for (const to of ids) {
      // Targets that don't exist (stale links) are simply skipped.
      await q(
        `INSERT INTO doc_links (from_id, to_id)
         SELECT $1, id FROM documents WHERE id = $2
         ON CONFLICT DO NOTHING`,
        [docId, to]
      );
    }
  } catch (err) {
    console.error("backlinks: sync failed for doc", docId, err);
  }
}

export interface Backlink {
  id: number;
  title: string;
  slug: string;
  status: string;
  space_id: number;
  space_name: string;
  space_icon: string;
}

/**
 * Documents whose content links to this one. Scope-filtered like everything
 * else: trashed docs and branches never appear, drafts only for staff, and
 * docs in spaces the viewer can't see are omitted.
 */
export async function backlinksFor(
  docId: number,
  scope: number[] | "all",
  includeDrafts: boolean
): Promise<Backlink[]> {
  const scopeFilter = scope === "all" ? "" : "AND d.space_id = ANY($2)";
  return q<Backlink>(
    `SELECT d.id, d.title, d.slug, d.status, d.space_id, s.name AS space_name, s.icon AS space_icon
     FROM doc_links l
     JOIN documents d ON d.id = l.from_id
     JOIN spaces s ON s.id = d.space_id
     WHERE l.to_id = $1 AND d.deleted_at IS NULL AND d.branch_of IS NULL
       ${includeDrafts ? "" : "AND d.status = 'published'"}
       ${scopeFilter}
     ORDER BY LOWER(d.title)`,
    scope === "all" ? [docId] : [docId, scope]
  );
}

/** Re-extract links for every live document (used when the toggle turns on). */
export async function reindexAllDocLinks(): Promise<number> {
  const rows = await q<{ id: number }>(
    "SELECT id FROM documents WHERE deleted_at IS NULL AND branch_of IS NULL ORDER BY id"
  );
  for (const r of rows) await syncDocLinks(r.id);
  return rows.length;
}
