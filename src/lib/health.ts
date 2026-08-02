// Knowledge-health report: composes signals the app already tracks — backlinks,
// review schedules, view analytics, and (when pgvector + a provider are
// configured) chunk embeddings — into one admin view of content rot: broken
// links, orphaned pages, overdue/stale documents, unread documents, likely
// duplicates, and documents whose author is no longer an active user.
//
// Server-only: everything is computed on demand with plain SQL; the embedding
// similarity pass degrades to an empty list when vectors aren't available.

import "server-only";
import { pool } from "./db";
import { extractDocLinkIds } from "./backlinks";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

export interface HealthDoc {
  id: number;
  title: string;
  space_name: string;
  status: string;
  author: string;
  updated_at: string;
}

export interface BrokenLink {
  from: HealthDoc;
  missing_ids: number[];
}

export interface DuplicatePair {
  a: HealthDoc;
  b: HealthDoc;
  /** Cosine similarity of their most-similar chunks, 0..1. */
  similarity: number;
}

export interface RatedDoc extends HealthDoc {
  up: number;
  down: number;
  /** Most recent non-empty "what's missing" notes from down-voters. */
  notes: string[];
}

export interface HealthReport {
  generated_at: string;
  totals: { documents: number; published: number };
  broken_links: BrokenLink[];
  orphans: HealthDoc[];
  overdue_reviews: HealthDoc[];
  stale: HealthDoc[];
  unread: HealthDoc[];
  duplicates: DuplicatePair[];
  ownerless: HealthDoc[];
  low_rated: RatedDoc[];
  /** True when the duplicates pass actually ran (pgvector + embeddings). */
  duplicates_checked: boolean;
}

const STALE_DAYS = 180; // published, unedited this long, and on no review cycle
const UNREAD_DAYS = 90; // no views in this window …
const UNREAD_MIN_AGE_DAYS = 30; // … for docs at least this old
const DUP_SIMILARITY = 0.92; // cosine similarity considered "likely duplicate"
const LIST_CAP = 50; // rows per section, keeps the page and payload sane

// Raw ISO timestamps, never `to_char` — formatting a date inside SQL renders
// it in the *database server's* zone, so a document touched near midnight shows
// the wrong day to anyone in another zone. The page formats these through
// lib/format with the workspace/user zone.
const DOC_COLS = `d.id, d.title, s.name AS space_name, d.status, d.author,
  d.updated_at`;

export async function knowledgeHealthReport(): Promise<HealthReport> {
  const [totalsRow] = await q<{ documents: number; published: number }>(
    `SELECT count(*)::int AS documents,
            count(*) FILTER (WHERE status = 'published')::int AS published
     FROM documents WHERE deleted_at IS NULL AND branch_of IS NULL`
  );

  // --- Broken internal links: /doc/N references to missing or deleted docs.
  // doc_links only stores resolvable targets, so re-scan content here.
  const withLinks = await q<HealthDoc & { content: string }>(
    `SELECT ${DOC_COLS}, d.content
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.deleted_at IS NULL AND d.branch_of IS NULL AND d.content LIKE '%/doc/%'`
  );
  const liveIds = new Set(
    (
      await q<{ id: number }>(
        "SELECT id FROM documents WHERE deleted_at IS NULL AND branch_of IS NULL"
      )
    ).map((r) => r.id)
  );
  const broken_links: BrokenLink[] = [];
  for (const d of withLinks) {
    const missing = extractDocLinkIds(d.content).filter((id) => !liveIds.has(id));
    if (missing.length > 0) {
      const { content: _c, ...doc } = d;
      broken_links.push({ from: doc, missing_ids: missing.slice(0, 10) });
      if (broken_links.length >= LIST_CAP) break;
    }
  }

  // --- Orphans: published, reachable only by browsing — nothing links to
  // them, no typed relations, and they sit outside any page tree.
  const orphans = await q<HealthDoc>(
    `SELECT ${DOC_COLS}
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.deleted_at IS NULL AND d.branch_of IS NULL AND d.status = 'published'
       AND d.parent_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM documents c WHERE c.parent_id = d.id AND c.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM doc_links l WHERE l.to_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM doc_relations r WHERE r.doc_id = d.id OR r.target_id = d.id)
     ORDER BY d.updated_at ASC
     LIMIT ${LIST_CAP}`
  );

  // --- Overdue reviews: the review cycle says "look at me" and nobody has.
  const overdue_reviews = await q<HealthDoc>(
    `SELECT ${DOC_COLS}
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.deleted_at IS NULL AND d.branch_of IS NULL
       AND d.review_due_at IS NOT NULL AND d.review_due_at < now()
     ORDER BY d.review_due_at ASC
     LIMIT ${LIST_CAP}`
  );

  // --- Stale: published, unedited for a long time, and on no review cycle —
  // nobody is even scheduled to notice if it's wrong.
  const stale = await q<HealthDoc>(
    `SELECT ${DOC_COLS}
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.deleted_at IS NULL AND d.branch_of IS NULL AND d.status = 'published'
       AND d.review_interval_days IS NULL
       AND d.updated_at < now() - interval '${STALE_DAYS} days'
     ORDER BY d.updated_at ASC
     LIMIT ${LIST_CAP}`
  );

  // --- Unread: published and old enough to have found an audience, but no
  // views in the window. (Empty when analytics has no data yet.)
  const unread = await q<HealthDoc>(
    `SELECT ${DOC_COLS}
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.deleted_at IS NULL AND d.branch_of IS NULL AND d.status = 'published'
       AND d.created_at < now() - interval '${UNREAD_MIN_AGE_DAYS} days'
       AND NOT EXISTS (
         SELECT 1 FROM doc_views v
         WHERE v.document_id = d.id AND v.viewed_at > now() - interval '${UNREAD_DAYS} days'
       )
     ORDER BY d.updated_at ASC
     LIMIT ${LIST_CAP}`
  );

  // --- Likely duplicates: closest chunk pair across two documents is nearly
  // identical. Only meaningful when embeddings exist; degrade to none.
  let duplicates: DuplicatePair[] = [];
  let duplicates_checked = false;
  try {
    const pairs = await q<{
      a_id: number; a_title: string; a_space: string; a_status: string; a_author: string; a_updated: string;
      b_id: number; b_title: string; b_space: string; b_status: string; b_author: string; b_updated: string;
      similarity: number;
    }>(
      `WITH best AS (
         SELECT ca.document_id AS a_id, cb.document_id AS b_id,
                max(1 - (ca.embedding <=> cb.embedding)) AS similarity
         FROM doc_chunks ca
         JOIN doc_chunks cb
           ON ca.document_id < cb.document_id
          AND ca.chunk_index = 0 AND cb.chunk_index = 0
         GROUP BY ca.document_id, cb.document_id
       )
       SELECT b.a_id, da.title AS a_title, sa.name AS a_space, da.status AS a_status, da.author AS a_author,
              da.updated_at AS a_updated,
              b.b_id, db.title AS b_title, sb.name AS b_space, db.status AS b_status, db.author AS b_author,
              db.updated_at AS b_updated,
              round(b.similarity::numeric, 3)::float AS similarity
       FROM best b
       JOIN documents da ON da.id = b.a_id AND da.deleted_at IS NULL AND da.branch_of IS NULL
       JOIN documents db ON db.id = b.b_id AND db.deleted_at IS NULL AND db.branch_of IS NULL
       JOIN spaces sa ON sa.id = da.space_id
       JOIN spaces sb ON sb.id = db.space_id
       WHERE b.similarity > ${DUP_SIMILARITY}
       ORDER BY b.similarity DESC
       LIMIT 20`
    );
    duplicates_checked = true;
    duplicates = pairs.map((p) => ({
      a: { id: p.a_id, title: p.a_title, space_name: p.a_space, status: p.a_status, author: p.a_author, updated_at: p.a_updated },
      b: { id: p.b_id, title: p.b_title, space_name: p.b_space, status: p.b_status, author: p.b_author, updated_at: p.b_updated },
      similarity: p.similarity,
    }));
  } catch {
    // pgvector missing or doc_chunks empty/absent — skip the section.
  }

  // --- Poorly rated: enough votes to mean something, and mostly "not
  // helpful" — the readers themselves are flagging these.
  const low_rated = await q<RatedDoc>(
    `SELECT ${DOC_COLS},
            count(*) FILTER (WHERE f.helpful = 1)::int AS up,
            count(*) FILTER (WHERE f.helpful = 0)::int AS down,
            COALESCE((SELECT array_agg(n.note) FROM (
              SELECT f2.note FROM doc_feedback f2
              WHERE f2.document_id = d.id AND f2.note <> ''
              ORDER BY f2.created_at DESC LIMIT 3
            ) n), '{}') AS notes
     FROM doc_feedback f
     JOIN documents d ON d.id = f.document_id AND d.deleted_at IS NULL AND d.branch_of IS NULL
       AND d.status = 'published'
     JOIN spaces s ON s.id = d.space_id
     GROUP BY d.id, d.title, s.name, d.status, d.author, d.updated_at
     HAVING count(*) >= 3 AND count(*) FILTER (WHERE f.helpful = 1) * 2 < count(*)
     ORDER BY count(*) FILTER (WHERE f.helpful = 0) DESC
     LIMIT ${LIST_CAP}`
  );

  // --- Owner-less: the author string no longer matches any active user, so
  // there's no obvious person to ask when the content needs an update.
  const ownerless = await q<HealthDoc>(
    `SELECT ${DOC_COLS}
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.deleted_at IS NULL AND d.branch_of IS NULL AND d.status = 'published'
       AND NOT EXISTS (
         SELECT 1 FROM users u
         WHERE u.status = 'active' AND (u.name = d.author OR u.username = d.author)
       )
     ORDER BY d.updated_at ASC
     LIMIT ${LIST_CAP}`
  );

  return {
    generated_at: new Date().toISOString(),
    totals: totalsRow,
    broken_links,
    orphans,
    overdue_reviews,
    stale,
    unread,
    duplicates,
    ownerless,
    low_rated,
    duplicates_checked,
  };
}
