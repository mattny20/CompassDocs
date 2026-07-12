import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { SEED_SPACES, SEED_DOCS } from "./seed-data";
import type {
  Document,
  DocumentWithSpace,
  DocVersion,
  Space,
  SearchHit,
  DocType,
  DocStatus,
} from "./types";

// --- Connection (singleton across hot reloads) -------------------------------

const DB_PATH =
  process.env.COMPASSDOCS_DB_PATH || path.join(process.cwd(), "data", "compassdocs.db");

declare global {
  // eslint-disable-next-line no-var
  var __compassDb: Database.Database | undefined;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function init(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '📁',
      color TEXT NOT NULL DEFAULT '#3366f2',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'knowledge',
      status TEXT NOT NULL DEFAULT 'draft',
      content TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT 'Unknown',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS doc_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'Unknown',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_documents_space ON documents(space_id);
    CREATE INDEX IF NOT EXISTS idx_versions_doc ON doc_versions(document_id);

    -- Full-text search index kept in sync via triggers.
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title, content, summary, tags,
      content='documents', content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, content, summary, tags)
      VALUES (new.id, new.title, new.content, new.summary, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, summary, tags)
      VALUES('delete', old.id, old.title, old.content, old.summary, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, summary, tags)
      VALUES('delete', old.id, old.title, old.content, old.summary, old.tags);
      INSERT INTO documents_fts(rowid, title, content, summary, tags)
      VALUES (new.id, new.title, new.content, new.summary, new.tags);
    END;
  `);

  seedIfEmpty(db);
  return db;
}

function seedIfEmpty(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM spaces").get() as { n: number };
  if (count.n > 0) return;

  const insertSpace = db.prepare(
    `INSERT INTO spaces (slug, name, description, icon, color) VALUES (?, ?, ?, ?, ?)`
  );
  const insertDoc = db.prepare(
    `INSERT INTO documents (space_id, title, slug, type, status, content, summary, tags, author, created_at, updated_at)
     VALUES (@space_id, @title, @slug, @type, @status, @content, @summary, @tags, @author, @created_at, @updated_at)`
  );
  const insertVersion = db.prepare(
    `INSERT INTO doc_versions (document_id, title, content, author, note) VALUES (?, ?, ?, ?, ?)`
  );

  const run = db.transaction(() => {
    const spaceIds: Record<string, number> = {};
    for (const s of SEED_SPACES) {
      const info = insertSpace.run(s.slug, s.name, s.description, s.icon, s.color);
      spaceIds[s.slug] = Number(info.lastInsertRowid);
    }
    // Spread creation timestamps over the past few weeks for a realistic feed.
    let daysAgo = 24;
    for (const d of SEED_DOCS) {
      const ts = `datetime('now', '-${daysAgo} days')`;
      const created = db.prepare(`SELECT ${ts} AS t`).get() as { t: string };
      const info = insertDoc.run({
        space_id: spaceIds[d.space],
        title: d.title,
        slug: slugify(d.title),
        type: d.type,
        status: d.status,
        content: d.content,
        summary: d.summary,
        tags: d.tags.join(","),
        author: d.author,
        created_at: created.t,
        updated_at: created.t,
      });
      insertVersion.run(Number(info.lastInsertRowid), d.title, d.content, d.author, "Initial version");
      daysAgo = Math.max(0, daysAgo - 3);
    }
  });
  run();
}

export function getDb(): Database.Database {
  if (!global.__compassDb) {
    global.__compassDb = init();
  }
  return global.__compassDb;
}

// --- Row mapping -------------------------------------------------------------

function parseTags(tags: string): string[] {
  return tags
    ? tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
}

function mapDoc(row: any): DocumentWithSpace {
  return { ...row, tags: parseTags(row.tags) };
}

// --- Spaces ------------------------------------------------------------------

export function listSpaces(): (Space & { doc_count: number })[] {
  return getDb()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM documents d WHERE d.space_id = s.id) AS doc_count
       FROM spaces s ORDER BY s.name`
    )
    .all() as (Space & { doc_count: number })[];
}

export function getSpaceBySlug(slug: string): Space | undefined {
  return getDb().prepare("SELECT * FROM spaces WHERE slug = ?").get(slug) as Space | undefined;
}

// --- Documents ---------------------------------------------------------------

const DOC_SELECT = `
  SELECT d.*, s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon, s.color AS space_color
  FROM documents d JOIN spaces s ON s.id = d.space_id`;

export function getDocument(id: number): DocumentWithSpace | undefined {
  const row = getDb().prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
  return row ? mapDoc(row) : undefined;
}

export function listDocumentsBySpace(spaceId: number): DocumentWithSpace[] {
  const rows = getDb()
    .prepare(`${DOC_SELECT} WHERE d.space_id = ? ORDER BY d.updated_at DESC`)
    .all(spaceId);
  return (rows as any[]).map(mapDoc);
}

export function listRecentDocuments(limit = 8): DocumentWithSpace[] {
  const rows = getDb().prepare(`${DOC_SELECT} ORDER BY d.updated_at DESC LIMIT ?`).all(limit);
  return (rows as any[]).map(mapDoc);
}

export function countDocuments(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
}

export function allTags(): { tag: string; count: number }[] {
  const rows = getDb().prepare("SELECT tags FROM documents WHERE tags <> ''").all() as {
    tags: string;
  }[];
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of parseTags(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

export interface DocInput {
  space_id: number;
  title: string;
  type: DocType;
  status: DocStatus;
  content: string;
  summary: string;
  tags: string[];
  author: string;
}

export function createDocument(input: DocInput): DocumentWithSpace {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO documents (space_id, title, slug, type, status, content, summary, tags, author)
       VALUES (@space_id, @title, @slug, @type, @status, @content, @summary, @tags, @author)`
    )
    .run({
      ...input,
      slug: slugify(input.title) || "untitled",
      tags: input.tags.join(","),
    });
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO doc_versions (document_id, title, content, author, note) VALUES (?, ?, ?, ?, ?)`
  ).run(id, input.title, input.content, input.author, "Created");
  return getDocument(id)!;
}

export function updateDocument(
  id: number,
  input: Partial<DocInput> & { versionNote?: string }
): DocumentWithSpace | undefined {
  const db = getDb();
  const existing = getDocument(id);
  if (!existing) return undefined;

  const next = {
    title: input.title ?? existing.title,
    type: input.type ?? existing.type,
    status: input.status ?? existing.status,
    content: input.content ?? existing.content,
    summary: input.summary ?? existing.summary,
    tags: input.tags ? input.tags.join(",") : existing.tags.join(","),
    author: input.author ?? existing.author,
  };

  db.prepare(
    `UPDATE documents SET title=@title, slug=@slug, type=@type, status=@status,
       content=@content, summary=@summary, tags=@tags, author=@author,
       updated_at=datetime('now') WHERE id=@id`
  ).run({ ...next, slug: slugify(next.title) || "untitled", id });

  // Snapshot a version only when the content or title actually changed.
  if (next.content !== existing.content || next.title !== existing.title) {
    db.prepare(
      `INSERT INTO doc_versions (document_id, title, content, author, note) VALUES (?, ?, ?, ?, ?)`
    ).run(id, next.title, next.content, next.author, input.versionNote || "Edited");
  }
  return getDocument(id);
}

export function deleteDocument(id: number): boolean {
  const info = getDb().prepare("DELETE FROM documents WHERE id = ?").run(id);
  return info.changes > 0;
}

export function listVersions(documentId: number): DocVersion[] {
  return getDb()
    .prepare("SELECT * FROM doc_versions WHERE document_id = ? ORDER BY created_at DESC, id DESC")
    .all(documentId) as DocVersion[];
}

// --- Search ------------------------------------------------------------------

/**
 * Turn a raw user query into a safe FTS5 MATCH expression. Each token becomes a
 * prefix term so partial words match; quotes and operators are stripped so the
 * user can't trigger FTS5 syntax errors.
 */
function toMatchQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

export function searchDocuments(raw: string, limit = 25): SearchHit[] {
  const match = toMatchQuery(raw);
  if (!match) return [];
  const rows = getDb()
    .prepare(
      `SELECT d.id, d.title, d.slug, d.type, d.status, d.tags, d.updated_at,
              s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon, s.color AS space_color,
              snippet(documents_fts, 1, '<mark>', '</mark>', '…', 18) AS snippet,
              bm25(documents_fts) AS rank
       FROM documents_fts
       JOIN documents d ON d.id = documents_fts.rowid
       JOIN spaces s ON s.id = d.space_id
       WHERE documents_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(match, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    slug: r.slug,
    type: r.type,
    status: r.status,
    space_name: r.space_name,
    space_slug: r.space_slug,
    space_icon: r.space_icon,
    space_color: r.space_color,
    tags: parseTags(r.tags),
    snippet: r.snippet,
    updated_at: r.updated_at,
  }));
}

/** Plain (non-highlighted) top matches used to build AI answer context. */
export function retrieveForAnswer(raw: string, limit = 6): Document[] {
  const match = toMatchQuery(raw);
  if (!match) return [];
  const rows = getDb()
    .prepare(
      `SELECT d.* FROM documents_fts
       JOIN documents d ON d.id = documents_fts.rowid
       WHERE documents_fts MATCH ?
       ORDER BY bm25(documents_fts)
       LIMIT ?`
    )
    .all(match, limit) as any[];
  return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }));
}
