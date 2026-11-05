// "Where people find it" (Handbooks 1.18.0): the listing filter for
// handbook-only documents.
//
// A document whose find_mode is 'handbook_only' is read through the handbooks
// it is in. Ordinary readers do not come across it in its space page, search
// (keyword, semantic and Ask), the dashboard, the command palette, the
// weekly digest, the public site or the API/MCP listings. The people who
// look after the space — anyone who may author in it, which includes space
// admins and workspace admins — still see it everywhere, marked
// "Handbook only".
//
// No orphans: a handbook_only document that is in no PUBLISHED handbook is
// treated as 'space' everywhere, so unpublishing the last handbook (or
// removing the document from it) can never make a policy undiscoverable.
//
// This is findability, not access. A reader who can open the space can still
// open the document by its link; nothing here is a permission check, and
// nothing here may be used as one. The filter is one SQL fragment, applied in
// a clearly marked block at every listing that needs it.
//
// No imports from lib/db or lib/access at module level: db.ts imports the
// fragments below, and access.ts imports db.ts.

import { cache } from "react";
import type { Role } from "./types";

// --- The scope a listing filters by --------------------------------------------

declare const FIND_SCOPE: unique symbol;

/**
 * The spaces whose handbook-only documents this viewer still sees in
 * listings: "all" (nothing is hidden) or a list of space ids (the spaces they
 * may author in). Opaque, like SpaceScope, so a read scope cannot be passed
 * where a find scope is meant: the only ways to get one are the resolvers
 * below.
 */
export type FindScope = ("all" | number[]) & { readonly [FIND_SCOPE]: true };

const asFindScope = (s: "all" | number[]): FindScope => s as FindScope;

/** Nothing is hidden: staff-only surfaces (review queue, exports, the admin console). */
export const FIND_EVERYTHING: FindScope = asFindScope("all");

/** Everything effectively handbook-only is hidden: an anonymous reader (the public site). */
export const FIND_ANONYMOUS: FindScope = asFindScope([]);

/**
 * The viewer's find scope: the spaces they may author in (editableScopeFor),
 * because the people who look after a space are the ones who still see its
 * handbook-only documents. Once per request per person.
 */
const findScopeById = cache(async (id: number, role: Role): Promise<FindScope> => {
  const { editableScopeFor } = await import("./access");
  const editable: "all" | number[] = await editableScopeFor({ id, role });
  return asFindScope(editable === "all" ? "all" : [...editable]);
});

export function findScopeFor(user: { id: number; role: Role }): Promise<FindScope> {
  return findScopeById(user.id, user.role);
}

/** True when this viewer still sees handbook-only documents of this space. */
export function findScopeAllows(f: FindScope, spaceId: number): boolean {
  return f === "all" || f.includes(spaceId);
}

// --- The SQL ------------------------------------------------------------------

/**
 * True for a document row (`alias`) that is EFFECTIVELY handbook-only: stored
 * 'handbook_only' AND in at least one published handbook (the no-orphans
 * rule). The cheap column test runs first, so the EXISTS only probes the
 * handful of documents marked handbook-only.
 */
export function effectiveHandbookOnlySql(alias: string): string {
  return `(${alias}.find_mode = 'handbook_only' AND EXISTS (
    SELECT 1 FROM handbook_items hbi JOIN handbooks hb ON hb.id = hbi.handbook_id
     WHERE hbi.document_id = ${alias}.id AND hb.status = 'published'))`;
}

/**
 * True for a document row (`alias`) this viewer should not come across in a
 * listing: effectively handbook-only, in a space outside `listedParam` (a
 * bound int[] of the spaces whose handbook-only documents the viewer still
 * sees). Listings write `AND NOT (${hiddenByHandbookSql(…)})`; most use
 * handbookFilterSql below, which binds the parameter and skips the clause
 * when nothing can be hidden.
 */
export function hiddenByHandbookSql(alias: string, listedParam: string): string {
  return `(NOT (${alias}.space_id = ANY(${listedParam}::int[])) AND ${effectiveHandbookOnlySql(alias)})`;
}

/**
 * The listing clause: "" when nothing is hidden (no find scope given, or a
 * viewer who authors everywhere), else " AND NOT (…)" with the viewer's
 * spaces pushed onto `params`. Append it to a WHERE that already filters
 * deleted/branch/status/space scope.
 */
export function handbookFilterSql(alias: string, find: FindScope | undefined, params: unknown[]): string {
  if (find === undefined || find === "all") return "";
  params.push([...find]);
  return ` AND NOT ${hiddenByHandbookSql(alias, `$${params.length}`)}`;
}

/** Is this document effectively handbook-only right now (the no-orphans rule applied)? */
export async function isEffectivelyHandbookOnly(docId: number): Promise<boolean> {
  const { pool } = await import("./db");
  const r = await pool().query(`SELECT 1 FROM documents d WHERE d.id = $1 AND ${effectiveHandbookOnlySql("d")}`, [docId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Of these people, the ones who should hear that a document in `spaceId`
 * changed: everyone, unless the document is effectively handbook-only, in
 * which case only those who still see it in the space (they look after it).
 * Space subscribers are told about what the space lists, and a handbook-only
 * policy is not listed for its ordinary readers.
 */
export async function keepWhoFind<T extends { id: number }>(docId: number, spaceId: number, people: T[]): Promise<T[]> {
  if (people.length === 0 || !(await isEffectivelyHandbookOnly(docId))) return people;
  const { pool } = await import("./db");
  const roles = new Map(
    (
      await pool().query<{ id: number; role: Role }>("SELECT id, role FROM users WHERE id = ANY($1::int[])", [
        people.map((p) => p.id),
      ])
    ).rows.map((r) => [r.id, r.role])
  );
  const out: T[] = [];
  for (const p of people) {
    const role = roles.get(p.id);
    if (role && findScopeAllows(await findScopeFor({ id: p.id, role }), spaceId)) out.push(p);
  }
  return out;
}

// --- Marking documents in a space (editors' view) -------------------------------

/** One effectively handbook-only document, and the published handbooks readers find it in. */
export interface HandbookOnlyMark {
  docId: number;
  handbooks: { id: number; title: string }[];
}

/**
 * The effectively handbook-only documents among `docIds`, each with the
 * published handbooks it is in (title order). The space page marks these
 * rows for the people who still see them.
 */
export async function handbookOnlyMarks(docIds: number[]): Promise<Map<number, HandbookOnlyMark>> {
  const out = new Map<number, HandbookOnlyMark>();
  if (docIds.length === 0) return out;
  const { pool } = await import("./db");
  const rows = (
    await pool().query<{ doc_id: number; handbook_id: number; title: string }>(
      `SELECT d.id AS doc_id, hb.id AS handbook_id, hb.title
         FROM documents d
         JOIN handbook_items hbi ON hbi.document_id = d.id
         JOIN handbooks hb ON hb.id = hbi.handbook_id AND hb.status = 'published'
        WHERE d.id = ANY($1::int[]) AND d.find_mode = 'handbook_only'
        GROUP BY d.id, hb.id, hb.title
        ORDER BY lower(hb.title), hb.id`,
      [docIds]
    )
  ).rows;
  for (const r of rows) {
    const mark = out.get(r.doc_id) ?? { docId: r.doc_id, handbooks: [] };
    mark.handbooks.push({ id: r.handbook_id, title: r.title });
    out.set(r.doc_id, mark);
  }
  return out;
}
