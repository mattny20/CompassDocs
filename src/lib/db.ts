import { Pool, types } from "pg";
import { createHash, randomBytes } from "node:crypto";
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
  Attachment,
} from "./types";

// Return timestamps as normalized ISO-8601 UTC strings (the app treats them as
// strings, not Date objects). Covers timestamptz (1184) and timestamp (1114).
function toIso(raw: string | null): string | null {
  if (raw == null) return null;
  // e.g. "2026-07-12 18:29:00.123456+00" -> pad a bare "+00" offset to "+00:00"
  const normalized = raw.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  const d = new Date(/[Z+-]\d|\dZ$/.test(normalized) ? normalized : normalized + "Z");
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}
types.setTypeParser(1184, (v) => toIso(v));
types.setTypeParser(1114, (v) => toIso(v));

// --- Connection (singleton across hot reloads) -------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __compassPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __compassInit: Promise<void> | undefined;
}

function makePool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Point it at a Postgres database.");
  }
  // Enable SSL for remote hosts (managed Postgres); skip it for local dev.
  // Detect the host from the URL so it works whether or not a user is present
  // (e.g. both postgres://localhost/db and postgres://user@localhost/db).
  let host = "";
  try {
    host = new URL(connectionString).hostname;
  } catch {
    // Non-URL DSN (key=value form) — fall through treating host as unknown.
  }
  const isLocal =
    host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1";
  const sslDisabled =
    process.env.DATABASE_SSL === "disable" || /sslmode=disable/.test(connectionString);
  // DATABASE_SSL=require forces SSL even when the host looks local.
  const useSsl =
    process.env.DATABASE_SSL === "require" || (!isLocal && !sslDisabled);
  return new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX) || 5,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    // Always speak UTC so timestamp strings are unambiguous.
    options: "-c timezone=UTC",
  });
}

export function pool(): Pool {
  if (!global.__compassPool) global.__compassPool = makePool();
  return global.__compassPool;
}

async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  await ready();
  const res = await pool().query(text, params);
  return res.rows as T[];
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// --- Schema, migration, and seeding (idempotent) -----------------------------

/**
 * Ensure the schema and seed data exist. Guarded by a Postgres advisory lock so
 * that concurrent cold starts (e.g. serverless) can't race the DDL/seed. Cached
 * as a module-level promise so it runs at most once per instance.
 */
function ready(): Promise<void> {
  if (!global.__compassInit) global.__compassInit = initialize();
  return global.__compassInit;
}

async function initialize(): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(id) FROM (SELECT 728341 AS id) t");
    await client.query(SCHEMA_SQL);
    await seedIfEmpty(client);
    await bootstrapAuth(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock(728341)").catch(() => {});
    client.release();
  }
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS spaces (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug text UNIQUE NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    icon text NOT NULL DEFAULT '📁',
    color text NOT NULL DEFAULT '#3366f2',
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Space security: public (any signed-in user) or private (granted groups).
  ALTER TABLE spaces ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public';

  CREATE TABLE IF NOT EXISTS documents (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    space_id integer NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    title text NOT NULL,
    slug text NOT NULL,
    type text NOT NULL DEFAULT 'knowledge',
    status text NOT NULL DEFAULT 'draft',
    content text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    tags text NOT NULL DEFAULT '',
    author text NOT NULL DEFAULT 'Unknown',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    search tsvector GENERATED ALWAYS AS (
      to_tsvector('english',
        coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' ||
        coalesce(content,'') || ' ' || coalesce(replace(tags, ',', ' '), ''))
    ) STORED
  );
  CREATE INDEX IF NOT EXISTS idx_documents_space ON documents(space_id);
  CREATE INDEX IF NOT EXISTS idx_documents_search ON documents USING gin(search);

  -- Soft delete: non-null deleted_at means the doc is in the Trash.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
  CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted_at);

  CREATE TABLE IF NOT EXISTS doc_versions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title text NOT NULL,
    content text NOT NULL,
    author text NOT NULL DEFAULT 'Unknown',
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_versions_doc ON doc_versions(document_id);

  CREATE TABLE IF NOT EXISTS users (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username text UNIQUE NOT NULL,
    email text NOT NULL DEFAULT '',
    name text NOT NULL DEFAULT '',
    password_hash text,
    password_salt text,
    role text NOT NULL DEFAULT 'viewer',
    status text NOT NULL DEFAULT 'active',
    auth_provider text NOT NULL DEFAULT 'local',
    external_id text,
    must_change_password integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  );

  -- User groups: hand-made, or linked to a Microsoft Entra group and synced.
  -- (After users: group_members references it.)
  CREATE TABLE IF NOT EXISTS groups (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    source text NOT NULL DEFAULT 'manual',
    external_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_synced_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_external ON groups(external_id) WHERE external_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS group_members (
    group_id integer NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS space_groups (
    space_id integer NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    group_id integer NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (space_id, group_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  -- Device metadata for the "active sessions" account page.
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip text;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;

  -- TOTP two-factor auth: secret + hashed one-time recovery codes.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled integer NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery jsonb NOT NULL DEFAULT '[]'::jsonb;

  -- Personal API tokens (Claude connector / MCP, integrations). Only a SHA-256
  -- hash is stored; the raw token is shown once at creation.
  CREATE TABLE IF NOT EXISTS api_tokens (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL DEFAULT '',
    token_hash text UNIQUE NOT NULL,
    prefix text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

  -- OAuth 2.1 authorization server for the MCP connector ("Add custom
  -- connector" in Claude): dynamically registered clients, short-lived auth
  -- codes, and issued access/refresh token pairs (hashes only).
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id text PRIMARY KEY,
    name text NOT NULL DEFAULT '',
    redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash text PRIMARY KEY,
    client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    expires_at timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_hash text UNIQUE NOT NULL,
    refresh_hash text UNIQUE NOT NULL,
    access_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);

  -- Outgoing notification webhooks (Webex, Teams, Slack, generic JSON).
  CREATE TABLE IF NOT EXISTS webhooks (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL DEFAULT '',
    url text NOT NULL,
    format text NOT NULL DEFAULT 'generic',
    events jsonb NOT NULL DEFAULT '[]'::jsonb,
    enabled integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_sent_at timestamptz,
    last_status text
  );
  -- Optional space scoping: empty array = all spaces.
  ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS space_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

  CREATE TABLE IF NOT EXISTS settings (
    key text PRIMARY KEY,
    value text NOT NULL
  );

  CREATE TABLE IF NOT EXISTS suggestions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer REFERENCES documents(id) ON DELETE CASCADE,
    proposed_title text NOT NULL DEFAULT '',
    body text NOT NULL,
    status text NOT NULL DEFAULT 'open',
    created_by integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_by integer REFERENCES users(id),
    resolved_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);

  CREATE TABLE IF NOT EXISTS change_requests (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT 'edit',
    title text NOT NULL,
    content text NOT NULL,
    summary text NOT NULL DEFAULT '',
    tags text NOT NULL DEFAULT '',
    type text NOT NULL DEFAULT 'knowledge',
    target_status text NOT NULL DEFAULT 'published',
    note text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending',
    created_by integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    reviewed_by integer REFERENCES users(id),
    reviewed_at timestamptz,
    review_note text NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_cr_status ON change_requests(status);

  CREATE TABLE IF NOT EXISTS attachments (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    filename text NOT NULL,
    stored_name text UNIQUE NOT NULL,
    mime_type text NOT NULL DEFAULT 'application/octet-stream',
    size integer NOT NULL DEFAULT 0,
    created_by integer REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_doc ON attachments(document_id);

  -- Audit log: an append-only record of security- and content-significant
  -- actions (who did what, when). Reads are intentionally not logged.
  CREATE TABLE IF NOT EXISTS audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    actor_id integer,
    actor_name text NOT NULL DEFAULT 'system',
    actor_role text,
    action text NOT NULL,
    target_type text,
    target_id text,
    target_label text,
    details jsonb,
    ip text
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);

  -- People directory. Rows come from manual entry (source='manual') or the
  -- enterprise Microsoft Graph sync (source='graph', keyed by external_id).
  CREATE TABLE IF NOT EXISTS directory_people (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source text NOT NULL DEFAULT 'manual',
    external_id text,
    name text NOT NULL,
    title text NOT NULL DEFAULT '',
    department text NOT NULL DEFAULT '',
    email text NOT NULL DEFAULT '',
    phone text NOT NULL DEFAULT '',
    mobile text NOT NULL DEFAULT '',
    office text NOT NULL DEFAULT '',
    photo text NOT NULL DEFAULT '',
    hidden integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_external
    ON directory_people(external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_directory_name ON directory_people(name);

  -- Directory v2: assistant link + admin-defined custom fields.
  ALTER TABLE directory_people
    ADD COLUMN IF NOT EXISTS assistant_id integer REFERENCES directory_people(id) ON DELETE SET NULL;
  ALTER TABLE directory_people
    ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}'::jsonb;

  -- Custom field definitions. graph_path (optional) maps the field to any
  -- Microsoft Graph user property for the enterprise sync — including nested
  -- ones like onPremisesExtensionAttributes.extensionAttribute1 (the Exchange
  -- custom attributes 1–15).
  CREATE TABLE IF NOT EXISTS directory_fields (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key text UNIQUE NOT NULL,
    label text NOT NULL,
    graph_path text NOT NULL DEFAULT '',
    show_in_card integer NOT NULL DEFAULT 0,
    sort integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

async function seedIfEmpty(client: import("pg").PoolClient) {
  const { rows } = await client.query("SELECT COUNT(*)::int AS n FROM spaces");
  if (rows[0].n > 0) return;

  const spaceIds: Record<string, number> = {};
  for (const s of SEED_SPACES) {
    const r = await client.query(
      "INSERT INTO spaces (slug, name, description, icon, color) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [s.slug, s.name, s.description, s.icon, s.color]
    );
    spaceIds[s.slug] = r.rows[0].id;
  }

  let daysAgo = 24;
  for (const d of SEED_DOCS) {
    const r = await client.query(
      `INSERT INTO documents (space_id, title, slug, type, status, content, summary, tags, author, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - ($10 * interval '1 day'), now() - ($10 * interval '1 day'))
       RETURNING id`,
      [
        spaceIds[d.space],
        d.title,
        slugify(d.title),
        d.type,
        d.status,
        d.content,
        d.summary,
        d.tags.join(","),
        d.author,
        daysAgo,
      ]
    );
    await client.query(
      "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1,$2,$3,$4,$5)",
      [r.rows[0].id, d.title, d.content, d.author, "Initial version"]
    );
    daysAgo = Math.max(0, daysAgo - 3);
  }
}

async function bootstrapAuth(client: import("pg").PoolClient) {
  await client.query(
    "INSERT INTO settings (key, value) VALUES ('approval_mode', 'strict') ON CONFLICT (key) DO NOTHING"
  );
  const { rows } = await client.query("SELECT COUNT(*)::int AS n FROM users");
  if (rows[0].n > 0) return;

  // Auto-create the admin only when credentials are provided via the
  // environment (headless / automated provisioning). Otherwise leave the
  // instance with no users so the first-run web setup wizard (/setup) can
  // create the admin account interactively — no default password to leak.
  const password = process.env.COMPASSDOCS_ADMIN_PASSWORD;
  if (!password) return;
  const username = process.env.COMPASSDOCS_ADMIN_USER || "admin";
  const { hash, salt } = hashPassword(password);
  await client.query(
    `INSERT INTO users (username, email, name, password_hash, password_salt, role, must_change_password)
     VALUES ($1,$2,$3,$4,$5,'admin',0)`,
    [username, `${username}@compassdocs.local`, "Administrator", hash, salt]
  );
}

/** True when the instance has no users yet — first-run setup is required. */
export async function needsSetup(): Promise<boolean> {
  return (await q<{ n: number }>("SELECT COUNT(*)::int AS n FROM users"))[0].n === 0;
}

// --- Attachments -------------------------------------------------------------

export async function createAttachment(input: {
  document_id: number;
  filename: string;
  stored_name: string;
  mime_type: string;
  size: number;
  created_by: number | null;
}): Promise<Attachment> {
  const r = await q<Attachment>(
    `INSERT INTO attachments (document_id, filename, stored_name, mime_type, size, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      input.document_id,
      input.filename,
      input.stored_name,
      input.mime_type,
      input.size,
      input.created_by,
    ]
  );
  return r[0];
}

export async function listAttachments(documentId: number): Promise<Attachment[]> {
  return q("SELECT * FROM attachments WHERE document_id = $1 ORDER BY created_at DESC", [
    documentId,
  ]);
}

export async function getAttachment(id: number): Promise<Attachment | undefined> {
  return (await q<Attachment>("SELECT * FROM attachments WHERE id = $1", [id]))[0];
}

/** Delete an attachment row, returning it (so the caller can unlink the file). */
export async function deleteAttachmentRow(id: number): Promise<Attachment | undefined> {
  return (await q<Attachment>("DELETE FROM attachments WHERE id = $1 RETURNING *", [id]))[0];
}

export async function attachmentsUsage(): Promise<{ count: number; bytes: number }> {
  const [row] = await q<{ count: number; bytes: string }>(
    "SELECT COUNT(*)::int AS count, COALESCE(SUM(size),0)::text AS bytes FROM attachments"
  );
  return { count: row.count, bytes: Number(row.bytes) };
}

export interface DatabaseStats {
  version: string;
  sizeBytes: number;
  documents: number;
  documents_trashed: number;
  users: number;
  spaces: number;
  versions: number;
  active_sessions: number;
  pending_changes: number;
  open_suggestions: number;
}

/** Postgres version, database size, and row counts for the System page. */
export async function getDatabaseStats(): Promise<DatabaseStats> {
  const [ver] = await q<{ version: string }>("SELECT version()");
  const [sz] = await q<{ bytes: string }>(
    "SELECT pg_database_size(current_database())::text AS bytes"
  );
  const [c] = await q<any>(`SELECT
    (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL)::int AS documents,
    (SELECT COUNT(*) FROM documents WHERE deleted_at IS NOT NULL)::int AS documents_trashed,
    (SELECT COUNT(*) FROM users)::int AS users,
    (SELECT COUNT(*) FROM spaces)::int AS spaces,
    (SELECT COUNT(*) FROM doc_versions)::int AS versions,
    (SELECT COUNT(*) FROM sessions WHERE expires_at > now())::int AS active_sessions,
    (SELECT COUNT(*) FROM change_requests WHERE status='pending')::int AS pending_changes,
    (SELECT COUNT(*) FROM suggestions WHERE status='open')::int AS open_suggestions`);
  return {
    // e.g. "PostgreSQL 16.13 (Ubuntu…) on x86_64…" -> "PostgreSQL 16.13"
    version: (ver.version || "").match(/^\S+ [\d.]+/)?.[0] || ver.version,
    sizeBytes: Number(sz.bytes),
    ...c,
  };
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

export async function listSpaces(scope?: number[] | "all"): Promise<(Space & { doc_count: number })[]> {
  const filter = Array.isArray(scope) ? " WHERE s.id = ANY($1)" : "";
  return q(
    `SELECT s.*, (SELECT COUNT(*)::int FROM documents d
       WHERE d.space_id = s.id AND d.deleted_at IS NULL) AS doc_count
     FROM spaces s${filter} ORDER BY s.name`,
    Array.isArray(scope) ? [scope] : []
  );
}

export async function getSpaceBySlug(slug: string): Promise<Space | undefined> {
  return (await q<Space>("SELECT * FROM spaces WHERE slug = $1", [slug]))[0];
}

export async function getSpaceById(id: number): Promise<Space | undefined> {
  return (await q<Space>("SELECT * FROM spaces WHERE id = $1", [id]))[0];
}

/** Turn a name into a slug that isn't already taken (appending -2, -3, …). */
export async function uniqueSpaceSlug(name: string): Promise<string> {
  const base = slugify(name) || "space";
  let slug = base;
  for (let n = 2; await getSpaceBySlug(slug); n++) slug = `${base}-${n}`.slice(0, 80);
  return slug;
}

export async function updateSpace(
  id: number,
  patch: { name?: string; description?: string; icon?: string; color?: string; visibility?: string }
): Promise<Space | undefined> {
  if (patch.visibility !== undefined && !["public", "private"].includes(patch.visibility)) {
    delete patch.visibility;
  }
  const sets: string[] = [];
  const vals: any[] = [];
  for (const key of ["name", "description", "icon", "color", "visibility"] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = $${sets.length + 1}`);
      vals.push(patch[key]);
    }
  }
  if (!sets.length) return getSpaceById(id);
  vals.push(id);
  const r = await q<Space>(
    `UPDATE spaces SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  return r[0];
}

/**
 * Delete a space. Refuses if it still holds any documents (including trashed
 * ones) so a space can never silently cascade-delete content.
 */
export async function deleteSpace(id: number): Promise<{ ok: boolean; docCount: number }> {
  const docCount = (
    await q<{ n: number }>("SELECT COUNT(*)::int AS n FROM documents WHERE space_id = $1", [id])
  )[0].n;
  if (docCount > 0) return { ok: false, docCount };
  await q("DELETE FROM spaces WHERE id = $1", [id]);
  return { ok: true, docCount: 0 };
}

export async function createSpace(input: {
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  visibility?: string;
}): Promise<Space> {
  const r = await q<Space>(
    `INSERT INTO spaces (slug, name, description, icon, color, visibility)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      input.slug,
      input.name,
      input.description ?? "",
      input.icon ?? "📁",
      input.color ?? "#3366f2",
      input.visibility === "private" ? "private" : "public",
    ]
  );
  return r[0];
}

// --- Documents ---------------------------------------------------------------

const DOC_SELECT = `
  SELECT d.*, s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon, s.color AS space_color
  FROM documents d JOIN spaces s ON s.id = d.space_id`;

export async function getDocument(id: number): Promise<DocumentWithSpace | undefined> {
  const rows = await q(`${DOC_SELECT} WHERE d.id = $1 AND d.deleted_at IS NULL`, [id]);
  return rows[0] ? mapDoc(rows[0]) : undefined;
}

/** Find a live document within a space by its slug (used by import upsert). */
export async function getDocumentBySpaceAndSlug(
  spaceId: number,
  slug: string
): Promise<DocumentWithSpace | undefined> {
  const rows = await q(
    `${DOC_SELECT} WHERE d.space_id = $1 AND d.slug = $2 AND d.deleted_at IS NULL`,
    [spaceId, slug]
  );
  return rows[0] ? mapDoc(rows[0]) : undefined;
}

/** All live documents (incl. drafts) with their space, for a full export. */
export async function exportDocuments(): Promise<DocumentWithSpace[]> {
  const rows = await q(
    `${DOC_SELECT} WHERE d.deleted_at IS NULL ORDER BY s.slug, d.slug`
  );
  return rows.map(mapDoc);
}

export async function listDocumentsBySpace(
  spaceId: number,
  includeDrafts = false
): Promise<DocumentWithSpace[]> {
  const filter = includeDrafts ? "" : " AND d.status = 'published'";
  const rows = await q(
    `${DOC_SELECT} WHERE d.space_id = $1 AND d.deleted_at IS NULL${filter} ORDER BY d.updated_at DESC`,
    [spaceId]
  );
  return rows.map(mapDoc);
}

export async function listRecentDocuments(
  limit = 8,
  includeDrafts = false,
  scope?: number[] | "all"
): Promise<DocumentWithSpace[]> {
  const filter = includeDrafts ? "" : " AND d.status = 'published'";
  const scoped = Array.isArray(scope) ? " AND d.space_id = ANY($2)" : "";
  const rows = await q(
    `${DOC_SELECT} WHERE d.deleted_at IS NULL${filter}${scoped} ORDER BY d.updated_at DESC LIMIT $1`,
    Array.isArray(scope) ? [limit, scope] : [limit]
  );
  return rows.map(mapDoc);
}

export async function countDocuments(
  includeDrafts = false,
  scope?: number[] | "all"
): Promise<number> {
  const filter =
    (includeDrafts ? "" : " AND status = 'published'") +
    (Array.isArray(scope) ? " AND space_id = ANY($1)" : "");
  return (
    await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM documents WHERE deleted_at IS NULL${filter}`,
      Array.isArray(scope) ? [scope] : []
    )
  )[0].n;
}

export async function allTags(): Promise<{ tag: string; count: number }[]> {
  const rows = await q<{ tags: string }>(
    "SELECT tags FROM documents WHERE tags <> '' AND deleted_at IS NULL"
  );
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

export async function createDocument(input: DocInput): Promise<DocumentWithSpace> {
  const r = await q<{ id: number }>(
    `INSERT INTO documents (space_id, title, slug, type, status, content, summary, tags, author)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      input.space_id,
      input.title,
      slugify(input.title) || "untitled",
      input.type,
      input.status,
      input.content,
      input.summary,
      input.tags.join(","),
      input.author,
    ]
  );
  const id = r[0].id;
  await q(
    "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1,$2,$3,$4,$5)",
    [id, input.title, input.content, input.author, "Created"]
  );
  return (await getDocument(id))!;
}

export async function updateDocument(
  id: number,
  input: Partial<DocInput> & { versionNote?: string }
): Promise<DocumentWithSpace | undefined> {
  const existing = await getDocument(id);
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

  await q(
    `UPDATE documents SET title=$1, slug=$2, type=$3, status=$4, content=$5, summary=$6,
       tags=$7, author=$8, updated_at=now() WHERE id=$9`,
    [
      next.title,
      slugify(next.title) || "untitled",
      next.type,
      next.status,
      next.content,
      next.summary,
      next.tags,
      next.author,
      id,
    ]
  );

  if (next.content !== existing.content || next.title !== existing.title) {
    await q(
      "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1,$2,$3,$4,$5)",
      [id, next.title, next.content, next.author, input.versionNote || "Edited"]
    );
  }
  return getDocument(id);
}

/** Soft-delete: move a document to the Trash (recoverable). */
export async function deleteDocument(id: number): Promise<boolean> {
  await ready();
  const res = await pool().query(
    "UPDATE documents SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

/** List the documents currently in the Trash, most-recently-deleted first. */
export async function listTrashedDocuments(): Promise<DocumentWithSpace[]> {
  const rows = await q(
    `${DOC_SELECT} WHERE d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC`
  );
  return rows.map(mapDoc);
}

/** Restore a trashed document back to its space. */
export async function restoreDocument(id: number): Promise<boolean> {
  await ready();
  const res = await pool().query(
    "UPDATE documents SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Permanently delete a trashed document (irreversible). Only affects Trash. */
export async function purgeDocument(id: number): Promise<boolean> {
  await ready();
  const res = await pool().query(
    "DELETE FROM documents WHERE id = $1 AND deleted_at IS NOT NULL",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Permanently delete trashed documents older than `retentionDays`. A value of
 * 0 (or less) disables auto-purge (Trash is kept forever). Returns the count
 * removed.
 */
export async function purgeExpiredTrash(retentionDays: number): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  await ready();
  const res = await pool().query(
    `DELETE FROM documents
     WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 * interval '1 day')`,
    [retentionDays]
  );
  return res.rowCount ?? 0;
}

export async function countTrashed(): Promise<number> {
  return (
    await q<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM documents WHERE deleted_at IS NOT NULL"
    )
  )[0].n;
}

export async function listVersions(documentId: number): Promise<DocVersion[]> {
  return q(
    "SELECT * FROM doc_versions WHERE document_id = $1 ORDER BY created_at DESC, id DESC",
    [documentId]
  );
}

// --- Search (native Postgres full-text search) -------------------------------

// websearch_to_tsquery safely parses arbitrary user input but ANDs the terms,
// which is too strict for a small knowledge base (one absent word => no hits).
// Rewriting the '&' operators to '|' gives lenient, ts_rank-ordered recall while
// keeping the safe parsing. Empty input yields an empty tsquery (matches none).
const OR_TSQUERY = `replace(websearch_to_tsquery('english', $1)::text, '&', '|')::tsquery`;

export async function searchDocuments(
  raw: string,
  limit = 25,
  includeDrafts = false,
  scope?: number[] | "all"
): Promise<SearchHit[]> {
  if (!raw.trim()) return [];
  const filter =
    (includeDrafts ? "" : " AND d.status = 'published'") +
    (Array.isArray(scope) ? " AND d.space_id = ANY($3)" : "");
  const rows = await q(
    `SELECT d.id, d.title, d.slug, d.type, d.status, d.tags, d.updated_at,
            s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon, s.color AS space_color,
            ts_headline('english', d.summary || ' ' || d.content, tq.query,
              'StartSel=<mark>, StopSel=</mark>, MaxWords=22, MinWords=8, ShortWord=2, MaxFragments=1') AS snippet
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     CROSS JOIN LATERAL (SELECT ${OR_TSQUERY} AS query) tq
     WHERE d.search @@ tq.query AND d.deleted_at IS NULL${filter}
     ORDER BY ts_rank(d.search, tq.query) DESC
     LIMIT $2`,
    Array.isArray(scope) ? [raw, limit, scope] : [raw, limit]
  );
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

export async function retrieveForAnswer(
  raw: string,
  limit = 6,
  includeDrafts = false,
  scope?: number[] | "all"
): Promise<Document[]> {
  if (!raw.trim()) return [];
  const filter =
    (includeDrafts ? "" : " AND d.status = 'published'") +
    (Array.isArray(scope) ? " AND d.space_id = ANY($3)" : "");
  const rows = await q(
    `SELECT d.* FROM documents d
     CROSS JOIN LATERAL (SELECT ${OR_TSQUERY} AS query) tq
     WHERE d.search @@ tq.query AND d.deleted_at IS NULL${filter}
     ORDER BY ts_rank(d.search, tq.query) DESC
     LIMIT $2`,
    Array.isArray(scope) ? [raw, limit, scope] : [raw, limit]
  );
  return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }));
}

// --- Settings ----------------------------------------------------------------

export async function getSetting(key: string): Promise<string | undefined> {
  return (await q<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]))[0]
    ?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await q(
    "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, value]
  );
}

export async function getApprovalMode(): Promise<ApprovalMode> {
  return (await getSetting("approval_mode")) === "open" ? "open" : "strict";
}

/** All settings as a plain key→value map (missing keys simply absent). */
export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await q<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// --- Users -------------------------------------------------------------------

const USER_COLUMNS = `id, username, email, name, role, status, auth_provider, external_id,
  must_change_password, totp_enabled, created_at, last_login_at`;

export async function getUserById(id: number): Promise<User | undefined> {
  return (await q<User>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]))[0];
}

export async function getUserByUsername(
  username: string
): Promise<
  | (User & {
      password_hash: string | null;
      password_salt: string | null;
      totp_secret: string | null;
    })
  | undefined
> {
  return (await q("SELECT * FROM users WHERE lower(username) = lower($1)", [username]))[0];
}

export async function listUsers(): Promise<User[]> {
  return q(`SELECT ${USER_COLUMNS} FROM users ORDER BY role DESC, username`);
}

/** SSO identity lookup: the (provider, external_id) pair is the stable key. */
export async function getUserByExternalId(
  provider: string,
  externalId: string
): Promise<User | undefined> {
  return (
    await q<User>(
      `SELECT ${USER_COLUMNS} FROM users WHERE auth_provider = $1 AND external_id = $2`,
      [provider, externalId]
    )
  )[0];
}

/** Email match for linking an SSO identity to a pre-existing account. */
export async function getUserByEmail(email: string): Promise<User | undefined> {
  return (
    await q<User>(
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1) ORDER BY id LIMIT 1`,
      [email]
    )
  )[0];
}

/**
 * Attach an SSO identity to an existing (typically local) account. The
 * password, if any, is left in place so both sign-in paths keep working.
 */
export async function linkSsoIdentity(
  userId: number,
  provider: string,
  externalId: string
): Promise<void> {
  await q("UPDATE users SET auth_provider = $1, external_id = $2 WHERE id = $3", [
    provider,
    externalId,
    userId,
  ]);
}

/** Provision a user from an SSO assertion — no password, so no local login. */
export async function createSsoUser(input: {
  username: string;
  name: string;
  email: string;
  role: Role;
  provider: string;
  externalId: string;
}): Promise<User> {
  const r = await q<{ id: number }>(
    `INSERT INTO users (username, email, name, role, auth_provider, external_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.username, input.email, input.name, input.role, input.provider, input.externalId]
  );
  return (await getUserById(r[0].id))!;
}

export async function createUser(input: {
  username: string;
  name: string;
  email: string;
  role: Role;
  passwordHash: string;
  passwordSalt: string;
  mustChange?: boolean;
}): Promise<User> {
  const r = await q<{ id: number }>(
    `INSERT INTO users (username, email, name, password_hash, password_salt, role, must_change_password)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      input.username,
      input.email,
      input.name,
      input.passwordHash,
      input.passwordSalt,
      input.role,
      input.mustChange ? 1 : 0,
    ]
  );
  return (await getUserById(r[0].id))!;
}

export async function updateUser(
  id: number,
  fields: { role?: Role; status?: "active" | "disabled" }
): Promise<User | undefined> {
  const existing = await getUserById(id);
  if (!existing) return undefined;
  await q("UPDATE users SET role = $1, status = $2 WHERE id = $3", [
    fields.role ?? existing.role,
    fields.status ?? existing.status,
    id,
  ]);
  return getUserById(id);
}

export async function setUserPassword(
  id: number,
  hash: string,
  salt: string,
  mustChange = false
): Promise<void> {
  await q(
    "UPDATE users SET password_hash = $1, password_salt = $2, must_change_password = $3 WHERE id = $4",
    [hash, salt, mustChange ? 1 : 0, id]
  );
}

export async function markLogin(id: number): Promise<void> {
  await q("UPDATE users SET last_login_at = now() WHERE id = $1", [id]);
}

export async function deleteUser(id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM users WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

export async function countAdmins(): Promise<number> {
  return (
    await q<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'"
    )
  )[0].n;
}

// --- Personal API tokens (Claude connector / integrations) --------------------

export interface ApiToken {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

function hashApiToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Mint a token for a user. The raw value is returned ONCE and never stored. */
export async function createApiToken(
  userId: number,
  name: string
): Promise<{ token: string; record: ApiToken }> {
  const raw = "cdk_" + randomBytes(24).toString("base64url");
  const prefix = raw.slice(0, 12) + "…";
  const r = await q<{ id: number; created_at: string }>(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix)
     VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [userId, name.trim().slice(0, 60) || "token", hashApiToken(raw), prefix]
  );
  return {
    token: raw,
    record: { id: r[0].id, name, prefix, created_at: r[0].created_at, last_used_at: null },
  };
}

export async function listApiTokens(userId: number): Promise<ApiToken[]> {
  return q(
    `SELECT id, name, prefix, created_at, last_used_at FROM api_tokens
     WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
}

export async function deleteApiToken(userId: number, id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM api_tokens WHERE id = $1 AND user_id = $2", [
    id,
    userId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/** Resolve a raw bearer token to its (active) user, updating last_used_at. */
export async function getUserByApiToken(raw: string): Promise<User | undefined> {
  if (!raw.startsWith("cdk_")) return undefined;
  const rows = await q<User & { token_id: number }>(
    `SELECT ${USER_COLUMNS
      .split(",")
      .map((c) => "u." + c.trim())
      .join(", ")}, t.id AS token_id
     FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND u.status = 'active'`,
    [hashApiToken(raw)]
  );
  const hit = rows[0];
  if (!hit) return undefined;
  // Fire-and-forget freshness stamp; not worth failing the request over.
  q("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [hit.token_id]).catch(() => {});
  const { token_id: _ignored, ...user } = hit;
  return user as User;
}

// --- OAuth (MCP connector authorization server) --------------------------------

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1h — clients refresh silently
const CODE_TTL_MS = 10 * 60 * 1000;

export interface OAuthClient {
  client_id: string;
  name: string;
  redirect_uris: string[];
}

export async function registerOAuthClient(name: string, redirectUris: string[]): Promise<OAuthClient> {
  const clientId = "cdc_" + randomBytes(16).toString("base64url");
  await q("INSERT INTO oauth_clients (client_id, name, redirect_uris) VALUES ($1,$2,$3)", [
    clientId,
    name.slice(0, 100),
    JSON.stringify(redirectUris),
  ]);
  return { client_id: clientId, name, redirect_uris: redirectUris };
}

export async function getOAuthClient(clientId: string): Promise<OAuthClient | undefined> {
  const r = (
    await q<{ client_id: string; name: string; redirect_uris: string[] }>(
      "SELECT client_id, name, redirect_uris FROM oauth_clients WHERE client_id = $1",
      [clientId]
    )
  )[0];
  return r ? { ...r, redirect_uris: r.redirect_uris ?? [] } : undefined;
}

export async function createOAuthCode(input: {
  clientId: string;
  userId: number;
  redirectUri: string;
  codeChallenge: string;
}): Promise<string> {
  const code = "cda_" + randomBytes(24).toString("base64url");
  await q(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      hashApiToken(code),
      input.clientId,
      input.userId,
      input.redirectUri,
      input.codeChallenge,
      new Date(Date.now() + CODE_TTL_MS).toISOString(),
    ]
  );
  return code;
}

/** Fetch-and-delete: an auth code is single-use, expired or not. */
export async function consumeOAuthCode(code: string): Promise<
  { client_id: string; user_id: number; redirect_uri: string; code_challenge: string } | undefined
> {
  const rows = await q<any>(
    `DELETE FROM oauth_codes WHERE code_hash = $1
     RETURNING client_id, user_id, redirect_uri, code_challenge, expires_at`,
    [hashApiToken(code)]
  );
  const r = rows[0];
  if (!r || new Date(r.expires_at).getTime() < Date.now()) return undefined;
  return r;
}

export async function createOAuthTokens(
  clientId: string,
  userId: number
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const access = "cdo_" + randomBytes(24).toString("base64url");
  const refresh = "cdr_" + randomBytes(24).toString("base64url");
  await q(
    `INSERT INTO oauth_tokens (client_id, user_id, access_hash, refresh_hash, access_expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      clientId,
      userId,
      hashApiToken(access),
      hashApiToken(refresh),
      new Date(Date.now() + ACCESS_TTL_MS).toISOString(),
    ]
  );
  return { accessToken: access, refreshToken: refresh, expiresIn: ACCESS_TTL_MS / 1000 };
}

/** Refresh-token rotation: the old pair dies, a fresh pair is issued. */
export async function rotateOAuthTokens(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; clientId: string } | undefined> {
  const rows = await q<{ client_id: string; user_id: number }>(
    "DELETE FROM oauth_tokens WHERE refresh_hash = $1 RETURNING client_id, user_id",
    [hashApiToken(refreshToken)]
  );
  const r = rows[0];
  if (!r) return undefined;
  const fresh = await createOAuthTokens(r.client_id, r.user_id);
  return { ...fresh, clientId: r.client_id };
}

/** Resolve an OAuth access token to its (active) user. */
export async function getUserByOAuthToken(raw: string): Promise<User | undefined> {
  if (!raw.startsWith("cdo_")) return undefined;
  const rows = await q<User & { token_id: number; access_expires_at: string }>(
    `SELECT ${USER_COLUMNS.split(",").map((c) => "u." + c.trim()).join(", ")},
            t.id AS token_id, t.access_expires_at
     FROM oauth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.access_hash = $1 AND u.status = 'active'`,
    [hashApiToken(raw)]
  );
  const hit = rows[0];
  if (!hit || new Date(hit.access_expires_at).getTime() < Date.now()) return undefined;
  q("UPDATE oauth_tokens SET last_used_at = now() WHERE id = $1", [hit.token_id]).catch(() => {});
  const { token_id: _t, access_expires_at: _e, ...user } = hit;
  return user as User;
}

/** A user's connected OAuth apps (grouped by client) for the account page. */
export async function listOAuthGrants(
  userId: number
): Promise<{ client_id: string; name: string; created_at: string; last_used_at: string | null }[]> {
  return q(
    `SELECT t.client_id, c.name, min(t.created_at) AS created_at, max(t.last_used_at) AS last_used_at
     FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
     WHERE t.user_id = $1 GROUP BY t.client_id, c.name ORDER BY min(t.created_at) DESC`,
    [userId]
  );
}

export async function revokeOAuthGrant(userId: number, clientId: string): Promise<boolean> {
  const res = await pool().query("DELETE FROM oauth_tokens WHERE user_id = $1 AND client_id = $2", [
    userId,
    clientId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

// --- Groups & space access ------------------------------------------------------

export interface Group {
  id: number;
  name: string;
  source: string; // "manual" | "entra"
  external_id: string | null;
  created_at: string;
  last_synced_at: string | null;
}

export async function listGroups(): Promise<(Group & { member_count: number; space_count: number })[]> {
  return q(`
    SELECT g.*,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id)::int AS member_count,
      (SELECT COUNT(*) FROM space_groups sg WHERE sg.group_id = g.id)::int AS space_count
    FROM groups g ORDER BY g.name`);
}

export async function getGroup(id: number): Promise<Group | undefined> {
  return (await q<Group>("SELECT * FROM groups WHERE id = $1", [id]))[0];
}

export async function createGroup(input: {
  name: string;
  source?: string;
  externalId?: string | null;
}): Promise<Group> {
  const r = await q<{ id: number }>(
    "INSERT INTO groups (name, source, external_id) VALUES ($1,$2,$3) RETURNING id",
    [input.name.slice(0, 80), input.source ?? "manual", input.externalId ?? null]
  );
  return (await getGroup(r[0].id))!;
}

export async function renameGroup(id: number, name: string): Promise<void> {
  await q("UPDATE groups SET name = $1 WHERE id = $2", [name.slice(0, 80), id]);
}

export async function deleteGroup(id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM groups WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

export async function listGroupMembers(groupId: number): Promise<User[]> {
  return q(
    `SELECT ${USER_COLUMNS.split(",").map((c) => "u." + c.trim()).join(", ")}
     FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1 ORDER BY u.name, u.username`,
    [groupId]
  );
}

export async function addGroupMember(groupId: number, userId: number): Promise<void> {
  await q(
    "INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [groupId, userId]
  );
}

export async function removeGroupMember(groupId: number, userId: number): Promise<void> {
  await q("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
}

/** Replace a group's membership wholesale (used by the Entra sync). */
export async function setGroupMembers(groupId: number, userIds: number[]): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM group_members WHERE group_id = $1", [groupId]);
    for (const uid of userIds) {
      await client.query(
        "INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [groupId, uid]
      );
    }
    await client.query("UPDATE groups SET last_synced_at = now() WHERE id = $1", [groupId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** space_id → granted group ids, for the whole workspace (admin UI). */
export async function listAllSpaceGroups(): Promise<Record<number, number[]>> {
  const rows = await q<{ space_id: number; group_id: number }>(
    "SELECT space_id, group_id FROM space_groups ORDER BY space_id"
  );
  const map: Record<number, number[]> = {};
  for (const r of rows) (map[r.space_id] ??= []).push(r.group_id);
  return map;
}

export async function getSpaceGroupIds(spaceId: number): Promise<number[]> {
  return (
    await q<{ group_id: number }>("SELECT group_id FROM space_groups WHERE space_id = $1", [spaceId])
  ).map((r) => r.group_id);
}

export async function setSpaceGroups(spaceId: number, groupIds: number[]): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM space_groups WHERE space_id = $1", [spaceId]);
    for (const gid of groupIds) {
      await client.query(
        "INSERT INTO space_groups (space_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [spaceId, gid]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The space ids a user may see: every public space plus private spaces where
 * one of their groups is granted. Admins bypass (callers use "all").
 */
export async function accessibleSpaceIdsFor(userId: number): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `SELECT s.id FROM spaces s WHERE s.visibility = 'public'
     UNION
     SELECT sg.space_id FROM space_groups sg
       JOIN group_members gm ON gm.group_id = sg.group_id
     WHERE gm.user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.id);
}

/** Map Entra member identities to local user ids (SSO id first, then email). */
export async function matchUsersByIdentity(
  members: { externalId?: string | null; email?: string | null }[]
): Promise<number[]> {
  const ids = new Set<number>();
  for (const m of members) {
    let hit: { id: number } | undefined;
    if (m.externalId) {
      hit = (await q<{ id: number }>("SELECT id FROM users WHERE external_id = $1", [m.externalId]))[0];
    }
    if (!hit && m.email) {
      hit = (
        await q<{ id: number }>("SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1", [m.email])
      )[0];
    }
    if (hit) ids.add(hit.id);
  }
  return [...ids];
}

// --- Notification webhooks -----------------------------------------------------

export interface Webhook {
  id: number;
  name: string;
  url: string;
  format: string;
  events: string[];
  space_ids: number[];
  enabled: number;
  created_at: string;
  last_sent_at: string | null;
  last_status: string | null;
}

export async function listWebhooks(): Promise<Webhook[]> {
  return q("SELECT * FROM webhooks ORDER BY id");
}

export async function getWebhook(id: number): Promise<Webhook | undefined> {
  return (await q<Webhook>("SELECT * FROM webhooks WHERE id = $1", [id]))[0];
}

export async function createWebhook(input: {
  name: string;
  url: string;
  format: string;
  events: string[];
  spaceIds?: number[];
}): Promise<Webhook> {
  const r = await q<{ id: number }>(
    "INSERT INTO webhooks (name, url, format, events, space_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [
      input.name.slice(0, 80),
      input.url,
      input.format,
      JSON.stringify(input.events),
      JSON.stringify(input.spaceIds ?? []),
    ]
  );
  return (await getWebhook(r[0].id))!;
}

export async function updateWebhook(
  id: number,
  patch: {
    name?: string;
    url?: string;
    format?: string;
    events?: string[];
    spaceIds?: number[];
    enabled?: boolean;
  }
): Promise<Webhook | undefined> {
  const existing = await getWebhook(id);
  if (!existing) return undefined;
  await q(
    "UPDATE webhooks SET name=$1, url=$2, format=$3, events=$4, space_ids=$5, enabled=$6 WHERE id=$7",
    [
      (patch.name ?? existing.name).slice(0, 80),
      patch.url ?? existing.url,
      patch.format ?? existing.format,
      JSON.stringify(patch.events ?? existing.events),
      JSON.stringify(patch.spaceIds ?? existing.space_ids),
      patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
      id,
    ]
  );
  return getWebhook(id);
}

export async function deleteWebhook(id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM webhooks WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Delivery bookkeeping so the admin UI can show per-hook health. */
export async function markWebhookResult(id: number, status: string): Promise<void> {
  await q("UPDATE webhooks SET last_sent_at = now(), last_status = $1 WHERE id = $2", [
    status.slice(0, 200),
    id,
  ]);
}

// --- Sessions ----------------------------------------------------------------

export async function createSession(
  token: string,
  userId: number,
  expiresAt: string,
  ip?: string | null,
  userAgent?: string | null
): Promise<void> {
  await q("INSERT INTO sessions (token, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)", [
    token,
    userId,
    expiresAt,
    ip || null,
    (userAgent || "").slice(0, 300) || null,
  ]);
}

export interface SessionInfo {
  sid: string; // md5 of the token — an identifier, never a credential
  created_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

export async function listUserSessions(userId: number, currentToken: string): Promise<SessionInfo[]> {
  return q(
    `SELECT md5(token) AS sid, created_at, expires_at, ip, user_agent,
            (token = $2) AS current
     FROM sessions WHERE user_id = $1 AND expires_at > now()
     ORDER BY (token = $2) DESC, created_at DESC`,
    [userId, currentToken]
  );
}

export async function deleteSessionBySid(userId: number, sid: string): Promise<boolean> {
  const res = await pool().query("DELETE FROM sessions WHERE user_id = $1 AND md5(token) = $2", [
    userId,
    sid,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/** "Sign out everywhere else" — keeps only the calling session alive. */
export async function deleteOtherSessions(userId: number, currentToken: string): Promise<number> {
  const res = await pool().query("DELETE FROM sessions WHERE user_id = $1 AND token <> $2", [
    userId,
    currentToken,
  ]);
  return res.rowCount ?? 0;
}

// --- Two-factor auth (TOTP) ----------------------------------------------------

/** Stash a pending secret during enrollment (2FA not yet enforced). */
export async function setPendingTotpSecret(userId: number, secret: string): Promise<void> {
  await q("UPDATE users SET totp_secret = $1, totp_enabled = 0 WHERE id = $2", [secret, userId]);
}

export async function getTotpState(
  userId: number
): Promise<{ secret: string | null; enabled: boolean; recovery_left: number } | undefined> {
  const r = (
    await q<{ totp_secret: string | null; totp_enabled: number; n: number }>(
      `SELECT totp_secret, totp_enabled, jsonb_array_length(totp_recovery) AS n
       FROM users WHERE id = $1`,
      [userId]
    )
  )[0];
  return r ? { secret: r.totp_secret, enabled: r.totp_enabled === 1, recovery_left: r.n } : undefined;
}

export async function enableTotp(userId: number, recoveryHashes: string[]): Promise<void> {
  await q("UPDATE users SET totp_enabled = 1, totp_recovery = $1 WHERE id = $2", [
    JSON.stringify(recoveryHashes),
    userId,
  ]);
}

export async function disableTotp(userId: number): Promise<void> {
  await q(
    "UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = '[]'::jsonb WHERE id = $1",
    [userId]
  );
}

/** Burn a recovery code (by hash). True if it existed and was removed. */
export async function consumeRecoveryCode(userId: number, codeHash: string): Promise<boolean> {
  const res = await pool().query(
    `UPDATE users SET totp_recovery = totp_recovery - $1
     WHERE id = $2 AND totp_recovery ? $1`,
    [codeHash, userId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getSessionUser(
  token: string
): Promise<(User & { expires_at: string }) | undefined> {
  const cols = USER_COLUMNS.split(",")
    .map((c) => "u." + c.trim())
    .join(", ");
  return (
    await q<User & { expires_at: string }>(
      `SELECT ${cols}, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > now() AND u.status = 'active'`,
      [token]
    )
  )[0];
}

/** Slide a session's expiry forward (sliding idle timeout). */
export async function touchSession(token: string, expiresAt: string): Promise<void> {
  await q("UPDATE sessions SET expires_at = $1 WHERE token = $2", [expiresAt, token]);
}

export async function deleteSession(token: string): Promise<void> {
  await q("DELETE FROM sessions WHERE token = $1", [token]);
}

export async function deleteUserSessions(userId: number): Promise<void> {
  await q("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

// --- Suggestions -------------------------------------------------------------

export async function createSuggestion(input: {
  document_id: number | null;
  proposed_title: string;
  body: string;
  created_by: number;
}): Promise<number> {
  const r = await q<{ id: number }>(
    "INSERT INTO suggestions (document_id, proposed_title, body, created_by) VALUES ($1,$2,$3,$4) RETURNING id",
    [input.document_id, input.proposed_title, input.body, input.created_by]
  );
  return r[0].id;
}

const SUGGESTION_SELECT = `
  SELECT sg.*, u.name AS author_name, d.title AS document_title
  FROM suggestions sg
  JOIN users u ON u.id = sg.created_by
  LEFT JOIN documents d ON d.id = sg.document_id`;

export async function listSuggestions(status?: "open"): Promise<Suggestion[]> {
  // Hide suggestions attached to a trashed document; keep general (doc-less) ones.
  const conds = ["(sg.document_id IS NULL OR d.deleted_at IS NULL)"];
  if (status) conds.push("sg.status = 'open'");
  return q(`${SUGGESTION_SELECT} WHERE ${conds.join(" AND ")} ORDER BY sg.created_at DESC`);
}

export async function resolveSuggestion(
  id: number,
  resolverId: number,
  status: "accepted" | "dismissed"
): Promise<void> {
  await q(
    "UPDATE suggestions SET status = $1, resolved_by = $2, resolved_at = now() WHERE id = $3 AND status = 'open'",
    [status, resolverId, id]
  );
}

export async function countOpenSuggestions(): Promise<number> {
  return (
    await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM suggestions sg
       LEFT JOIN documents d ON d.id = sg.document_id
       WHERE sg.status = 'open' AND (sg.document_id IS NULL OR d.deleted_at IS NULL)`
    )
  )[0].n;
}

// --- Change requests ---------------------------------------------------------

export async function createChangeRequest(input: {
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
}): Promise<number> {
  const r = await q<{ id: number }>(
    `INSERT INTO change_requests (document_id, kind, title, content, summary, tags, type, target_status, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.document_id,
      input.kind,
      input.title,
      input.content,
      input.summary,
      input.tags.join(","),
      input.type,
      input.target_status,
      input.note,
      input.created_by,
    ]
  );
  return r[0].id;
}

const CR_SELECT = `
  SELECT cr.*, u.name AS author_name, d.title AS document_title
  FROM change_requests cr
  JOIN users u ON u.id = cr.created_by
  LEFT JOIN documents d ON d.id = cr.document_id`;

export async function getChangeRequest(id: number): Promise<ChangeRequest | undefined> {
  return (await q<ChangeRequest>(`${CR_SELECT} WHERE cr.id = $1`, [id]))[0];
}

export async function listChangeRequests(
  status?: "pending",
  scope?: number[] | "all"
): Promise<ChangeRequest[]> {
  // Exclude change requests whose document has been trashed.
  const conds = ["d.deleted_at IS NULL"];
  if (status) conds.push("cr.status = 'pending'");
  if (Array.isArray(scope)) conds.push("d.space_id = ANY($1)");
  return q(
    `${CR_SELECT} WHERE ${conds.join(" AND ")} ORDER BY cr.created_at DESC`,
    Array.isArray(scope) ? [scope] : []
  );
}

export async function listPendingForDocument(documentId: number): Promise<ChangeRequest[]> {
  return q(
    `${CR_SELECT} WHERE cr.document_id = $1 AND cr.status = 'pending' ORDER BY cr.created_at DESC`,
    [documentId]
  );
}

export async function countPendingChangeRequests(): Promise<number> {
  return (
    await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM change_requests cr
       JOIN documents d ON d.id = cr.document_id
       WHERE cr.status = 'pending' AND d.deleted_at IS NULL`
    )
  )[0].n;
}

/** Approve a change request: apply its proposed state to the document. */
export async function approveChangeRequest(
  id: number,
  reviewerId: number,
  reviewerName: string,
  note = ""
): Promise<boolean> {
  await ready();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const cr = (
      await client.query(`${CR_SELECT} WHERE cr.id = $1 FOR UPDATE OF cr`, [id])
    ).rows[0] as ChangeRequest | undefined;
    if (!cr || cr.status !== "pending") {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE documents SET title=$1, slug=$2, type=$3, status=$4, content=$5, summary=$6, tags=$7, updated_at=now()
       WHERE id=$8`,
      [
        cr.title,
        slugify(cr.title) || "untitled",
        cr.type,
        cr.target_status,
        cr.content,
        cr.summary,
        cr.tags,
        cr.document_id,
      ]
    );
    await client.query(
      "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1,$2,$3,$4,$5)",
      [cr.document_id, cr.title, cr.content, cr.author_name, `Approved by ${reviewerName}`]
    );
    await client.query(
      "UPDATE change_requests SET status='approved', reviewed_by=$1, reviewed_at=now(), review_note=$2 WHERE id=$3",
      [reviewerId, note, id]
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function rejectChangeRequest(
  id: number,
  reviewerId: number,
  note = ""
): Promise<boolean> {
  const res = await pool().query(
    "UPDATE change_requests SET status='rejected', reviewed_by=$1, reviewed_at=now(), review_note=$2 WHERE id=$3 AND status='pending'",
    [reviewerId, note, id]
  );
  return (res.rowCount ?? 0) > 0;
}
