// Nested pages: an optional parent_id on documents turns a space's flat list
// into a shallow tree (capped at MAX_DEPTH levels — deep hierarchy is where
// documents go to die). Rules enforced here: parent must be in the same
// space, neither side may be a draft branch, no cycles, and the resulting
// depth of the moved page's deepest descendant stays within the cap.
// The whole feature is admin-gated (Settings → Workspace, off by default);
// callers check the setting — this module only cares about integrity.

import "server-only";
import { pool } from "./db";
import type { Document } from "./types";

export const MAX_DEPTH = 3; // 1 = top level, 3 = grandchild

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

export interface DocTreeNode {
  id: number;
  title: string;
  slug: string;
  status: string;
  parent_id: number | null;
  position: number;
  children: DocTreeNode[];
}

/** Live (non-deleted, non-branch) children of a document, in manual order. */
export async function childrenOf(
  docId: number,
  opts: { includeDrafts: boolean }
): Promise<Pick<Document, "id" | "title" | "slug" | "status" | "position">[]> {
  return q(
    `SELECT id, title, slug, status, position FROM documents
     WHERE parent_id = $1 AND deleted_at IS NULL AND branch_of IS NULL
       ${opts.includeDrafts ? "" : "AND status = 'published'"}
     ORDER BY position, LOWER(title)`,
    [docId]
  );
}

/** Ancestor chain, nearest parent first. Trashed ancestors cut the chain. */
export async function ancestorsOf(
  docId: number
): Promise<{ id: number; title: string; space_id: number }[]> {
  const rows = await q<{ id: number; title: string; space_id: number; deleted_at: string | null }>(
    `WITH RECURSIVE up AS (
       SELECT d.id, d.title, d.space_id, d.parent_id, d.deleted_at, 1 AS depth
       FROM documents d WHERE d.id = (SELECT parent_id FROM documents WHERE id = $1)
       UNION ALL
       SELECT d.id, d.title, d.space_id, d.parent_id, d.deleted_at, up.depth + 1
       FROM documents d JOIN up ON d.id = up.parent_id
       WHERE up.depth < 10
     )
     SELECT id, title, space_id, deleted_at FROM up ORDER BY depth`,
    [docId]
  );
  const chain: { id: number; title: string; space_id: number }[] = [];
  for (const r of rows) {
    if (r.deleted_at) break; // a trashed ancestor detaches the visible chain
    chain.push({ id: r.id, title: r.title, space_id: r.space_id });
  }
  return chain;
}

/** 1-based depth of a document (1 = top level). */
export async function depthOf(docId: number): Promise<number> {
  return (await ancestorsOf(docId)).length + 1;
}

/** Height of a document's live subtree (1 = no children). */
async function subtreeHeight(docId: number): Promise<number> {
  const rows = await q<{ h: number }>(
    `WITH RECURSIVE down AS (
       SELECT id, 1 AS h FROM documents WHERE id = $1
       UNION ALL
       SELECT d.id, down.h + 1 FROM documents d
       JOIN down ON d.parent_id = down.id
       WHERE d.deleted_at IS NULL AND d.branch_of IS NULL AND down.h < 10
     )
     SELECT MAX(h)::int AS h FROM down`,
    [docId]
  );
  return rows[0]?.h ?? 1;
}

/**
 * Set (or clear, with null) a document's parent. Returns an error string on
 * rejection, undefined on success.
 */
export async function setParent(docId: number, parentId: number | null): Promise<string | undefined> {
  const doc = (await q("SELECT id, space_id, branch_of FROM documents WHERE id = $1 AND deleted_at IS NULL", [docId]))[0];
  if (!doc) return "Document not found.";
  if (doc.branch_of !== null) return "Draft branches can't be nested.";

  if (parentId === null) {
    await q("UPDATE documents SET parent_id = NULL WHERE id = $1", [docId]);
    return undefined;
  }

  if (parentId === docId) return "A page can't be its own parent.";
  const parent = (
    await q("SELECT id, space_id, branch_of FROM documents WHERE id = $1 AND deleted_at IS NULL", [parentId])
  )[0];
  if (!parent) return "Parent page not found.";
  if (parent.branch_of !== null) return "Draft branches can't have sub-pages.";
  if (parent.space_id !== doc.space_id) return "A sub-page must be in the same space as its parent.";

  // No cycles: the parent may not be a descendant of the doc being moved.
  const parentAncestors = await ancestorsOf(parentId);
  if (parentAncestors.some((a) => a.id === docId)) {
    return "A page can't be nested under its own sub-page.";
  }

  const depth = parentAncestors.length + 1; // parent's depth
  const height = await subtreeHeight(docId);
  if (depth + height > MAX_DEPTH) {
    return `Pages can nest at most ${MAX_DEPTH} levels deep.`;
  }

  const next = await q<{ p: number }>(
    "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM documents WHERE parent_id = $1",
    [parentId]
  );
  await q("UPDATE documents SET parent_id = $2, position = $3 WHERE id = $1", [
    docId,
    parentId,
    next[0]?.p ?? 1,
  ]);
  return undefined;
}

/** Swap a page with its previous/next sibling in the manual order. */
export async function moveSibling(docId: number, dir: -1 | 1): Promise<boolean> {
  const doc = (await q("SELECT id, parent_id, position FROM documents WHERE id = $1", [docId]))[0];
  if (!doc || doc.parent_id === null) return false;
  const siblings = await q<{ id: number; position: number }>(
    `SELECT id, position FROM documents
     WHERE parent_id = $1 AND deleted_at IS NULL AND branch_of IS NULL
     ORDER BY position, LOWER(title)`,
    [doc.parent_id]
  );
  const idx = siblings.findIndex((s) => s.id === docId);
  const other = siblings[idx + dir];
  if (idx === -1 || !other) return false;
  // Renumber the whole sibling list so ties can't stick together.
  const order = [...siblings];
  [order[idx], order[idx + dir]] = [order[idx + dir], order[idx]];
  for (let i = 0; i < order.length; i++) {
    await q("UPDATE documents SET position = $2 WHERE id = $1", [order[i].id, i + 1]);
  }
  return true;
}

/**
 * The visible page tree for a space: top-level pages with children nested,
 * drafts included only for staff. Docs whose parent is trashed (or invisible
 * to the viewer) surface at the top level rather than vanishing.
 */
export async function treeForSpace(spaceId: number, includeDrafts: boolean): Promise<DocTreeNode[]> {
  const rows = await q<DocTreeNode>(
    `SELECT id, title, slug, status, parent_id, position FROM documents
     WHERE space_id = $1 AND deleted_at IS NULL AND branch_of IS NULL
       ${includeDrafts ? "" : "AND status = 'published'"}
     ORDER BY position, LOWER(title)`,
    [spaceId]
  );
  const byId = new Map<number, DocTreeNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: DocTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id !== null ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
