// Helpdesk 1.19.0: articles from the workspace's own documents, suggested
// before a request is sent (Get help's search, the request form) and beside
// a ticket in the desk. The existing search (keyword + semantic when
// embeddings are configured) under the CALLER's space scope and handbook
// find scope, so a suggestion never shows a document the person could not
// open, nor a handbook-only policy outside its handbooks. Published
// documents only. Server-only.

import "server-only";
import { spaceScopeFor } from "../access";
import { findScopeFor } from "../handbook-visibility";
import { hybridSearchDocuments } from "../embeddings";
import { hq } from "./db-core";
import type { Role } from "../types";
import type { HdSuggestedArticle } from "./types";

export const SUGGEST_LIMITS = { q: 200, max: 8 } as const;

/** Reading minutes at ~200 words a minute, at least 1. */
export function readMinutes(words: number): number {
  return Math.max(1, Math.round(words / 200));
}

/** Clean a free-text query: strip search operators (space:, tag:, …) a requester did not mean, clamp. */
export function suggestQuery(raw: string): string {
  return raw
    .replace(/\b(space|type|tag|author|status):\S*/gi, " ")
    .replace(/["“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUGGEST_LIMITS.q);
}

/**
 * Up to `limit` published documents for `q`, as this person may read them.
 * Empty for an empty query.
 */
export async function suggestArticles(
  user: { id: number; role: Role },
  q: string,
  limit = 5
): Promise<HdSuggestedArticle[]> {
  const text = suggestQuery(q);
  if (text.length < 2) return [];
  const n = Math.min(Math.max(1, limit), SUGGEST_LIMITS.max);
  const [scope, find] = await Promise.all([spaceScopeFor(user), findScopeFor(user)]);
  const hits = (await hybridSearchDocuments(text, n * 2, false, scope, undefined, find)).filter((h) => h.status === "published");
  const top = hits.slice(0, n);
  if (!top.length) return [];
  const words = new Map(
    (
      await hq<{ id: number; words: number }>(
        `SELECT id, coalesce(array_length(regexp_split_to_array(trim(content), '\\s+'), 1), 0) AS words
           FROM documents WHERE id = ANY($1::int[])`,
        [top.map((h) => h.id)]
      )
    ).map((r) => [r.id, Number(r.words)])
  );
  return top.map((h) => ({
    doc_id: h.id,
    title: h.title,
    space_name: h.space_name,
    read_minutes: readMinutes(words.get(h.id) ?? 0),
    url: `/doc/${h.id}`,
  }));
}
