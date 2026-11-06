// Per-request memoised readers for the entities a page both titles and
// renders. `generateMetadata` and the page body run separately, so without
// this each document view would hit the database twice. React's cache() is
// scoped to one request, so writes are never served stale.

import "server-only";
import { cache } from "react";
import { getDocument, getNewsletter, getSpaceBySlug } from "./db";
import { getPersonById } from "./directory";
import type { Role } from "./types";

export const cachedDocument = cache((id: number) => getDocument(id));
export const cachedSpace = cache((slug: string) => getSpaceBySlug(slug));
export const cachedPerson = cache((id: number) => getPersonById(id));
export const cachedNewsletter = cache((id: number) => getNewsletter(id));

/**
 * The browser-tab title for /doc/[id] (1.19.0): the document's title only
 * when `user` may open it, by the same checks the page makes (the document
 * exists, its space is in the reader's scope, a draft only for those who see
 * drafts). Otherwise null: the tab must not name a draft or a private
 * document to someone who tries its id, and reads like an id with no
 * document behind it.
 */
export async function documentTabTitle(id: number, user: { id: number; role: Role } | null): Promise<string | null> {
  if (!user || !Number.isInteger(id) || id <= 0) return null;
  const doc = await cachedDocument(id).catch(() => undefined);
  if (!doc) return null;
  const { spaceScopeFor, scopeAllows, canSeeDrafts } = await import("./access");
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) return null;
  if (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id))) return null;
  return doc.title || null;
}
