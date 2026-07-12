import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { SEED_SPACES, SEED_DOCS } from "./seed-data";
import { hashPassword } from "./password";
import type {
  Document,
  DocumentWithSpace,
  DocVersion,
  Space,
  SearchHit,
  DocType,
  DocStatus,
  Role,
  User,
  ApprovalMode,
  Suggestion,
  ChangeRequest,
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

    -- Users, sessions, and workspace settings for auth & roles.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT,
      password_salt TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      status TEXT NOT NULL DEFAULT 'active',
      auth_provider TEXT NOT NULL DEFAULT 'local',
      external_id TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Logged-in users can suggest changes; approvers/admins resolve them.
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
      proposed_title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_by INTEGER REFERENCES users(id),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);

    -- Proposed edits to live docs, pending approver/admin review (strict mode).
    CREATE TABLE IF NOT EXISTS change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'edit',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'knowledge',
      target_status TEXT NOT NULL DEFAULT 'published',
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      review_note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_cr_status ON change_requests(status);
  `);

  seedIfEmpty(db);
  bootstrapAuth(db);
  return db;
}

/**
 * Idempotently ensure default settings and a first admin account exist. Runs on
 * every init so it also upgrades a database that predates the auth feature.
 */
function bootstrapAuth(db: Database.Database) {
  const setDefault = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING"
  );
  setDefault.run("approval_mode", "strict");

  const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (userCount.n === 0) {
    const username = process.env.COMPASSDOCS_ADMIN_USER || "admin";
    const password = process.env.COMPASSDOCS_ADMIN_PASSWORD || "admin";
    const { hash, salt } = hashPassword(password);
    // Force a password change on first login unless the admin explicitly set one.
    const mustChange = process.env.COMPASSDOCS_ADMIN_PASSWORD ? 0 : 1;
    db.prepare(
      `INSERT INTO users (username, email, name, password_hash, password_salt, role, must_change_password)
       VALUES (?, ?, ?, ?, ?, 'admin', ?)`
    ).run(username, `${username}@compassdocs.local`, "Administrator", hash, salt, mustChange);
  }
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

export function listDocumentsBySpace(spaceId: number, includeDrafts = false): DocumentWithSpace[] {
  const filter = includeDrafts ? "" : " AND d.status = 'published'";
  const rows = getDb()
    .prepare(`${DOC_SELECT} WHERE d.space_id = ?${filter} ORDER BY d.updated_at DESC`)
    .all(spaceId);
  return (rows as any[]).map(mapDoc);
}

export function listRecentDocuments(limit = 8, includeDrafts = false): DocumentWithSpace[] {
  const filter = includeDrafts ? "" : " WHERE d.status = 'published'";
  const rows = getDb()
    .prepare(`${DOC_SELECT}${filter} ORDER BY d.updated_at DESC LIMIT ?`)
    .all(limit);
  return (rows as any[]).map(mapDoc);
}

export function countDocuments(includeDrafts = false): number {
  const filter = includeDrafts ? "" : " WHERE status = 'published'";
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM documents${filter}`).get() as { n: number }).n;
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

export function searchDocuments(raw: string, limit = 25, includeDrafts = false): SearchHit[] {
  const match = toMatchQuery(raw);
  if (!match) return [];
  const filter = includeDrafts ? "" : " AND d.status = 'published'";
  const rows = getDb()
    .prepare(
      `SELECT d.id, d.title, d.slug, d.type, d.status, d.tags, d.updated_at,
              s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon, s.color AS space_color,
              snippet(documents_fts, 1, '<mark>', '</mark>', '…', 18) AS snippet,
              bm25(documents_fts) AS rank
       FROM documents_fts
       JOIN documents d ON d.id = documents_fts.rowid
       JOIN spaces s ON s.id = d.space_id
       WHERE documents_fts MATCH ?${filter}
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
export function retrieveForAnswer(raw: string, limit = 6, includeDrafts = false): Document[] {
  const match = toMatchQuery(raw);
  if (!match) return [];
  const filter = includeDrafts ? "" : " AND d.status = 'published'";
  const rows = getDb()
    .prepare(
      `SELECT d.* FROM documents_fts
       JOIN documents d ON d.id = documents_fts.rowid
       WHERE documents_fts MATCH ?${filter}
       ORDER BY bm25(documents_fts)
       LIMIT ?`
    )
    .all(match, limit) as any[];
  return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }));
}

// --- Settings ----------------------------------------------------------------

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function getApprovalMode(): ApprovalMode {
  return getSetting("approval_mode") === "open" ? "open" : "strict";
}

// --- Users -------------------------------------------------------------------

const USER_COLUMNS = `id, username, email, name, role, status, auth_provider, external_id,
  must_change_password, created_at, last_login_at`;

export function getUserById(id: number): User | undefined {
  return getDb().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as
    | User
    | undefined;
}

export function getUserByUsername(username: string):
  | (User & { password_hash: string | null; password_salt: string | null })
  | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
    .get(username) as any;
}

export function listUsers(): User[] {
  return getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY role DESC, username`)
    .all() as User[];
}

export function createUser(input: {
  username: string;
  name: string;
  email: string;
  role: Role;
  passwordHash: string;
  passwordSalt: string;
  mustChange?: boolean;
}): User {
  const info = getDb()
    .prepare(
      `INSERT INTO users (username, email, name, password_hash, password_salt, role, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.username,
      input.email,
      input.name,
      input.passwordHash,
      input.passwordSalt,
      input.role,
      input.mustChange ? 1 : 0
    );
  return getUserById(Number(info.lastInsertRowid))!;
}

export function updateUser(
  id: number,
  fields: { role?: Role; status?: "active" | "disabled" }
): User | undefined {
  const existing = getUserById(id);
  if (!existing) return undefined;
  getDb()
    .prepare("UPDATE users SET role = ?, status = ? WHERE id = ?")
    .run(fields.role ?? existing.role, fields.status ?? existing.status, id);
  return getUserById(id);
}

export function setUserPassword(id: number, hash: string, salt: string, mustChange = false): void {
  getDb()
    .prepare(
      "UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = ? WHERE id = ?"
    )
    .run(hash, salt, mustChange ? 1 : 0, id);
}

export function markLogin(id: number): void {
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
}

export function deleteUser(id: number): boolean {
  return getDb().prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
}

export function countAdmins(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get() as {
      n: number;
    }
  ).n;
}

// --- Sessions ----------------------------------------------------------------

export function createSession(token: string, userId: number, expiresAt: string): void {
  getDb()
    .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .run(token, userId, expiresAt);
}

export function getSessionUser(token: string): User | undefined {
  const row = getDb()
    .prepare(
      `SELECT ${USER_COLUMNS.split(",")
        .map((c) => "u." + c.trim())
        .join(", ")}
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now') AND u.status = 'active'`
    )
    .get(token) as User | undefined;
  return row;
}

export function deleteSession(token: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function deleteUserSessions(userId: number): void {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

// --- Suggestions -------------------------------------------------------------

export function createSuggestion(input: {
  document_id: number | null;
  proposed_title: string;
  body: string;
  created_by: number;
}): number {
  const info = getDb()
    .prepare(
      "INSERT INTO suggestions (document_id, proposed_title, body, created_by) VALUES (?, ?, ?, ?)"
    )
    .run(input.document_id, input.proposed_title, input.body, input.created_by);
  return Number(info.lastInsertRowid);
}

const SUGGESTION_SELECT = `
  SELECT sg.*, u.name AS author_name, d.title AS document_title
  FROM suggestions sg
  JOIN users u ON u.id = sg.created_by
  LEFT JOIN documents d ON d.id = sg.document_id`;

export function listSuggestions(status?: "open"): Suggestion[] {
  const where = status ? " WHERE sg.status = 'open'" : "";
  return getDb()
    .prepare(`${SUGGESTION_SELECT}${where} ORDER BY sg.created_at DESC`)
    .all() as Suggestion[];
}

export function listSuggestionsForDocument(documentId: number): Suggestion[] {
  return getDb()
    .prepare(`${SUGGESTION_SELECT} WHERE sg.document_id = ? ORDER BY sg.created_at DESC`)
    .all(documentId) as Suggestion[];
}

export function resolveSuggestion(id: number, resolverId: number, status: "accepted" | "dismissed") {
  getDb()
    .prepare(
      "UPDATE suggestions SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'open'"
    )
    .run(status, resolverId, id);
}

export function countOpenSuggestions(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'open'").get() as {
    n: number;
  }).n;
}

// --- Change requests ---------------------------------------------------------

export function createChangeRequest(input: {
  document_id: number;
  kind: "edit" | "publish";
  title: string;
  content: string;
  summary: string;
  tags: string[];
  type: DocType;
  target_status: DocStatus;
  note: string;
  created_by: number;
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO change_requests (document_id, kind, title, content, summary, tags, type, target_status, note, created_by)
       VALUES (@document_id, @kind, @title, @content, @summary, @tags, @type, @target_status, @note, @created_by)`
    )
    .run({ ...input, tags: input.tags.join(",") });
  return Number(info.lastInsertRowid);
}

const CR_SELECT = `
  SELECT cr.*, u.name AS author_name, d.title AS document_title
  FROM change_requests cr
  JOIN users u ON u.id = cr.created_by
  LEFT JOIN documents d ON d.id = cr.document_id`;

export function getChangeRequest(id: number): ChangeRequest | undefined {
  return getDb().prepare(`${CR_SELECT} WHERE cr.id = ?`).get(id) as ChangeRequest | undefined;
}

export function listChangeRequests(status?: "pending"): ChangeRequest[] {
  const where = status ? " WHERE cr.status = 'pending'" : "";
  return getDb()
    .prepare(`${CR_SELECT}${where} ORDER BY cr.created_at DESC`)
    .all() as ChangeRequest[];
}

export function listPendingForDocument(documentId: number): ChangeRequest[] {
  return getDb()
    .prepare(`${CR_SELECT} WHERE cr.document_id = ? AND cr.status = 'pending' ORDER BY cr.created_at DESC`)
    .all(documentId) as ChangeRequest[];
}

export function countPendingChangeRequests(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS n FROM change_requests WHERE status = 'pending'").get() as {
      n: number;
    }
  ).n;
}

/** Approve a change request: apply its proposed state to the document. */
export function approveChangeRequest(
  id: number,
  reviewerId: number,
  reviewerName: string,
  note = ""
): boolean {
  const db = getDb();
  const cr = getChangeRequest(id);
  if (!cr || cr.status !== "pending") return false;
  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE documents SET title=@title, slug=@slug, type=@type, status=@target_status,
         content=@content, summary=@summary, tags=@tags, updated_at=datetime('now')
       WHERE id=@document_id`
    ).run({
      title: cr.title,
      slug: slugify(cr.title) || "untitled",
      type: cr.type,
      target_status: cr.target_status,
      content: cr.content,
      summary: cr.summary,
      tags: cr.tags,
      document_id: cr.document_id,
    });
    db.prepare(
      `INSERT INTO doc_versions (document_id, title, content, author, note) VALUES (?, ?, ?, ?, ?)`
    ).run(cr.document_id, cr.title, cr.content, cr.author_name, `Approved by ${reviewerName}`);
    db.prepare(
      "UPDATE change_requests SET status='approved', reviewed_by=?, reviewed_at=datetime('now'), review_note=? WHERE id=?"
    ).run(reviewerId, note, id);
  });
  apply();
  return true;
}

export function rejectChangeRequest(id: number, reviewerId: number, note = ""): boolean {
  const info = getDb()
    .prepare(
      "UPDATE change_requests SET status='rejected', reviewed_by=?, reviewed_at=datetime('now'), review_note=? WHERE id=? AND status='pending'"
    )
    .run(reviewerId, note, id);
  return info.changes > 0;
}
