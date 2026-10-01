// Per-request memoised readers for the entities a page both titles and
// renders. `generateMetadata` and the page body run separately, so without
// this each document view would hit the database twice. React's cache() is
// scoped to one request, so writes are never served stale.

import "server-only";
import { cache } from "react";
import { getDocument, getNewsletter, getSpaceBySlug } from "./db";
import { getPersonById } from "./directory";

export const cachedDocument = cache((id: number) => getDocument(id));
export const cachedSpace = cache((slug: string) => getSpaceBySlug(slug));
export const cachedPerson = cache((id: number) => getPersonById(id));
export const cachedNewsletter = cache((id: number) => getNewsletter(id));
