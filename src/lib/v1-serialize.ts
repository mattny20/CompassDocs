// Wire shapes for the public REST API. Deliberately stable and slim: internal
// fields (embedding state, ack flags, review bookkeeping) stay internal so we
// can evolve them without breaking integrators.

import "server-only";
import type { DocumentWithSpace, Space } from "./types";

export function v1Doc(d: DocumentWithSpace, withContent = false) {
  return {
    id: d.id,
    title: d.title,
    slug: d.slug,
    type: d.type,
    status: d.status,
    summary: d.summary,
    tags: d.tags,
    author: d.author,
    space: { id: d.space_id, slug: d.space_slug, name: d.space_name },
    created_at: d.created_at,
    updated_at: d.updated_at,
    ...(withContent ? { content: d.content } : {}),
  };
}

export function v1Space(s: Space & { doc_count?: number }) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    icon: s.icon,
    visibility: s.visibility,
    doc_count: s.doc_count ?? undefined,
  };
}
