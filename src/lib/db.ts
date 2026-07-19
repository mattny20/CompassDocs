import { Pool, types } from "pg";
import { createHash, randomBytes } from "node:crypto";
import { SEED_SPACES, SEED_DOCS } from "./seed-data";
import { hashPassword } from "./password";
import { sealSecret, openSecret, isSealed } from "./secretbox";
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
    await migrateVisibilityTiers(client);
    await migrateSecuritySealing(client);
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

  -- Space security tiers: 'public' (anyone on the internet, no sign-in),
  -- 'internal' (any signed-in user — the default), 'private' (granted groups).
  ALTER TABLE spaces ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'internal';
  ALTER TABLE spaces ALTER COLUMN visibility SET DEFAULT 'internal';

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

  -- Draft branches: a working copy linked to its source document. Branches are
  -- always drafts, are hidden from listings/search, and go away on merge.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS branch_of integer REFERENCES documents(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_documents_branch ON documents(branch_of);

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
  -- Provenance for restores: which older version this snapshot was copied from.
  ALTER TABLE doc_versions ADD COLUMN IF NOT EXISTS restored_from integer;

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

  -- A change request may also move the document to another space (null = stay).
  ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS space_id integer;
  CREATE INDEX IF NOT EXISTS idx_cr_status ON change_requests(status);

  -- Knowledge-base analytics: raw view/search/download events, aggregated by
  -- src/lib/analytics.ts. Views carry a duration updated by heartbeats while
  -- the reader's tab stays visible; source distinguishes in-app from the
  -- public site (where user_id is null).
  CREATE TABLE IF NOT EXISTS doc_views (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    source text NOT NULL DEFAULT 'app',
    duration_seconds integer NOT NULL DEFAULT 0,
    viewed_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_views_doc_at ON doc_views(document_id, viewed_at);
  CREATE INDEX IF NOT EXISTS idx_views_at ON doc_views(viewed_at);
  CREATE INDEX IF NOT EXISTS idx_views_user ON doc_views(user_id);

  CREATE TABLE IF NOT EXISTS search_events (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    query text NOT NULL,
    results integer NOT NULL DEFAULT 0,
    source text NOT NULL DEFAULT 'search',
    searched_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_search_at ON search_events(searched_at);

  CREATE TABLE IF NOT EXISTS download_events (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    attachment_id integer,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    filename text NOT NULL DEFAULT '',
    downloaded_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_downloads_at ON download_events(downloaded_at);
  CREATE INDEX IF NOT EXISTS idx_downloads_doc ON download_events(document_id);

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
  -- How a custom attribute renders: 'field' = label + text value; 'tag' =
  -- comma-separated values shown as badge chips (skills, certifications, …).
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS display text NOT NULL DEFAULT 'field';

  -- Account ↔ directory linking: a user can be tied to their directory entry
  -- (auto-matched by SSO id or email, or set by an admin). Survives directory
  -- syncs because Graph people upsert by external_id; if an entry is removed,
  -- the link clears and auto-link restores it later.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS
    directory_person_id integer REFERENCES directory_people(id) ON DELETE SET NULL;
  -- Per-user master switch for subscription emails.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications integer NOT NULL DEFAULT 1;

  -- Space subscriptions. A row with state='subscribed' is a personal opt-in;
  -- state='muted' overrides a group-based subscription. No row = follow the
  -- admin-assigned group subscriptions below.
  CREATE TABLE IF NOT EXISTS space_subscriptions (
    space_id integer NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state text NOT NULL DEFAULT 'subscribed',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (space_id, user_id)
  );
  -- Admin-assigned: every member of these groups is subscribed to the space
  -- (resolved live at send time, so membership changes just work).
  CREATE TABLE IF NOT EXISTS space_subscription_groups (
    space_id integer NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    group_id integer NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (space_id, group_id)
  );

  -- Policy acknowledgements (enterprise): docs can require readers to confirm
  -- they've read them. The ledger is append-only for compliance — an ack is
  -- "current" only while acknowledged_at >= the doc's updated_at, so any edit
  -- to the document asks everyone again.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_required integer NOT NULL DEFAULT 0;
  -- Spam guard + display for compliance reminders (central portal).
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_last_reminded_at timestamptz;
  CREATE TABLE IF NOT EXISTS acknowledgements (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    acknowledged_at timestamptz NOT NULL DEFAULT now(),
    ip text NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_ack_doc ON acknowledgements(document_id, user_id, acknowledged_at DESC);

  -- Quick links: an admin-curated launchpad of external shortcuts (Duo
  -- Central-style bookmarks). A link with no link_groups rows is visible to
  -- every signed-in user; with rows, only to members of those groups (admins
  -- always see everything).
  CREATE TABLE IF NOT EXISTS link_categories (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    position integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS links (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_id integer REFERENCES link_categories(id) ON DELETE SET NULL,
    title text NOT NULL,
    url text NOT NULL,
    description text NOT NULL DEFAULT '',
    -- favicon = auto-fetched site icon (cached below); brand = workspace logo;
    -- custom = an uploaded image. icon_file/icon_mime hold the cached favicon
    -- or the custom upload; empty = fall back to a letter tile.
    icon_type text NOT NULL DEFAULT 'favicon',
    icon_file text,
    icon_mime text,
    position integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS link_groups (
    link_id integer NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    group_id integer NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (link_id, group_id)
  );

  -- Per-space edit rights. A space with no rows in either table is editable by
  -- any editor+; with rows, only the listed users / group members may author in
  -- it (admins always can). The org-level setting 'editors_edit_all' (default
  -- on) short-circuits all of this back to "any editor edits any space".
  CREATE TABLE IF NOT EXISTS space_editors (
    space_id integer NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (space_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS space_editor_groups (
    space_id integer NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    group_id integer NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (space_id, group_id)
  );

  -- Organization announcements: admin-posted messages shown on every user's
  -- dashboard until they expire, are archived by an admin, or the user
  -- dismisses them for themselves. Email/webhook delivery happens at post
  -- time and doesn't affect who sees the dashboard block.
  CREATE TABLE IF NOT EXISTS announcements (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    level text NOT NULL DEFAULT 'info',
    author_name text NOT NULL DEFAULT '',
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    archived_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS announcement_dismissals (
    announcement_id integer NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (announcement_id, user_id)
  );

  -- Per-user page width preference (normal | wide | full), applied app-wide.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS page_width text NOT NULL DEFAULT 'wide';

  -- Categories within a space: an optional grouping level for its documents.
  -- Deleting a category never deletes documents (they fall back to General).
  CREATE TABLE IF NOT EXISTS space_categories (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    space_id integer NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    position integer NOT NULL DEFAULT 0
  );
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS
    category_id integer REFERENCES space_categories(id) ON DELETE SET NULL;

  -- Org newsletters: rich (markdown) emails with an editorial workflow.
  -- Lifecycle: draft -> in_review -> (changes_requested -> draft…) ->
  -- approved -> sent. Pre-workflow rows default to 'sent' (they were the
  -- send history). Access is per-user (users.newsletter_role) with an
  -- optional per-newsletter approver list.
  CREATE TABLE IF NOT EXISTS newsletters (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject text NOT NULL,
    body text NOT NULL DEFAULT '',
    author_name text NOT NULL DEFAULT '',
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    audience text NOT NULL DEFAULT '',
    sent_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'sent';
  ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'all';
  ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS group_ids text NOT NULL DEFAULT '';
  ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS sent_at timestamptz;
  UPDATE newsletters SET sent_at = created_at WHERE status = 'sent' AND sent_at IS NULL;
  -- none | contributor | approver (admins implicitly have full access).
  ALTER TABLE users ADD COLUMN IF NOT EXISTS newsletter_role text NOT NULL DEFAULT 'none';
  CREATE TABLE IF NOT EXISTS newsletter_approvers (
    newsletter_id integer NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (newsletter_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS newsletter_comments (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    newsletter_id integer NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    author_name text NOT NULL DEFAULT '',
    body text NOT NULL,
    kind text NOT NULL DEFAULT 'comment',
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Approved newsletters can be scheduled: the in-app sweeper sends them when
  -- due. scheduled_origin remembers the site origin from when the schedule was
  -- set, so links absolutize correctly outside a request context.
  ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
  ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS scheduled_origin text NOT NULL DEFAULT '';
  -- Optional per-newsletter sender, picked from the admin-curated list
  -- (setting: newsletter_from_addresses). Empty = the SMTP default From.
  ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS from_address text NOT NULL DEFAULT '';
  -- When set, sending also files the newsletter as a published document in
  -- this space (the archive). Chosen by the author in the draft window.
  ALTER TABLE newsletters ADD COLUMN IF NOT EXISTS
    archive_space_id integer REFERENCES spaces(id) ON DELETE SET NULL;
  -- Sent newsletters surface on every dashboard for a few days; the X hides
  -- one for that user only (mirrors announcement_dismissals).
  CREATE TABLE IF NOT EXISTS newsletter_dismissals (
    newsletter_id integer NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (newsletter_id, user_id)
  );

  -- Cached favicons for external links in documents and newsletters, keyed
  -- by host. stored_name '' = negative cache (site had no usable icon).
  CREATE TABLE IF NOT EXISTS site_icons (
    host text PRIMARY KEY,
    stored_name text NOT NULL DEFAULT '',
    mime text NOT NULL DEFAULT '',
    fetched_at timestamptz NOT NULL DEFAULT now()
  );

  -- Files attached to a newsletter and sent WITH the email (real MIME
  -- attachments), not just linked. Stored like document attachments.
  CREATE TABLE IF NOT EXISTS newsletter_files (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    newsletter_id integer NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
    filename text NOT NULL,
    stored_name text NOT NULL,
    mime_type text NOT NULL DEFAULT 'application/octet-stream',
    size integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Document comments (0.38): a flat discussion under each document, with
  -- @mentions. Admin-deleted comments stay as rows (deleted_at set) so the
  -- thread keeps its shape; their body is never returned to clients.
  CREATE TABLE IF NOT EXISTS doc_comments (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    author_name text NOT NULL DEFAULT '',
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by text NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS doc_comments_doc_idx ON doc_comments(document_id);
  CREATE TABLE IF NOT EXISTS doc_comment_mentions (
    comment_id integer NOT NULL REFERENCES doc_comments(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (comment_id, user_id)
  );
  -- Mention notifications reuse announcements, targeted at ONE user
  -- (target_user_id NULL = org-wide, the pre-0.38 behavior) and optionally
  -- carrying a link rendered as a button on the dashboard block.
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS
    target_user_id integer REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS link text NOT NULL DEFAULT '';
`;

/**
 * One-time rename for the 0.14 visibility tiers: before 0.14, 'public' meant
 * "every signed-in user". That tier is now 'internal', and 'public' means
 * anonymous internet access — so existing rows must flip exactly once (never
 * again, or an admin's deliberate 'public' choice would be reverted on boot).
 */
async function migrateVisibilityTiers(client: import("pg").PoolClient) {
  const done = await client.query("SELECT 1 FROM settings WHERE key = 'migrated_visibility_tiers'");
  if (done.rowCount) return;
  await client.query("UPDATE spaces SET visibility = 'internal' WHERE visibility = 'public'");
  await client.query(
    "INSERT INTO settings (key, value) VALUES ('migrated_visibility_tiers','1') ON CONFLICT (key) DO NOTHING"
  );
}

/**
 * One-time security migrations (0.41.0), inside the init advisory lock:
 * 1. Seal existing plaintext credential settings with the master key.
 * 2. Replace raw session tokens with their SHA-256 (cookies stay valid — the
 *    lookup hashes the cookie value from then on). Guarded by a settings flag
 *    since a raw token and a hash are both 64 hex chars.
 */
async function migrateSecuritySealing(client: import("pg").PoolClient) {
  const keys = Array.from(SENSITIVE_SETTINGS);
  const { rows: secretRows } = await client.query(
    "SELECT key, value FROM settings WHERE key = ANY($1) AND value <> ''",
    [keys]
  );
  for (const r of secretRows) {
    if (!isSealed(r.value)) {
      await client.query("UPDATE settings SET value = $1 WHERE key = $2", [
        sealSecret(r.value),
        r.key,
      ]);
    }
  }

  const done = await client.query("SELECT 1 FROM settings WHERE key = 'sessions_hashed'");
  if (!done.rowCount) {
    const { rows: sessions } = await client.query("SELECT token FROM sessions");
    for (const s of sessions) {
      await client.query("UPDATE sessions SET token = $1 WHERE token = $2", [
        createHash("sha256").update(s.token).digest("hex"),
        s.token,
      ]);
    }
    await client.query(
      "INSERT INTO settings (key, value) VALUES ('sessions_hashed','1') ON CONFLICT (key) DO NOTHING"
    );
  }
}

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
       WHERE d.space_id = s.id AND d.deleted_at IS NULL AND d.branch_of IS NULL) AS doc_count
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
  if (patch.visibility !== undefined && !["public", "internal", "private"].includes(patch.visibility)) {
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
      ["public", "internal", "private"].includes(input.visibility ?? "") ? input.visibility : "internal",
    ]
  );
  return r[0];
}

// --- Documents ---------------------------------------------------------------

const DOC_SELECT = `
  SELECT d.*, s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon,
         s.color AS space_color, s.visibility AS space_visibility
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

/** Live documents credited to an author display name (directory profiles). */
/** Display names of accounts linked to a directory person (byline aliases). */
export async function listLinkedUserNames(personId: number): Promise<string[]> {
  return (
    await q<{ name: string }>(
      "SELECT name FROM users WHERE directory_person_id = $1 AND name <> ''",
      [personId]
    )
  ).map((r) => r.name);
}

export async function listDocumentsByAuthor(
  author: string | string[],
  includeDrafts = false,
  scope?: number[] | "all"
): Promise<DocumentWithSpace[]> {
  const names = (Array.isArray(author) ? author : [author]).map((n) => n.toLowerCase());
  const conds = ["lower(d.author) = ANY($1)", "d.deleted_at IS NULL", "d.branch_of IS NULL"];
  const params: any[] = [names];
  if (!includeDrafts) conds.push("d.status = 'published'");
  if (Array.isArray(scope)) {
    params.push(scope);
    conds.push(`d.space_id = ANY($${params.length})`);
  }
  const rows = await q(
    `${DOC_SELECT} WHERE ${conds.join(" AND ")} ORDER BY d.updated_at DESC LIMIT 100`,
    params
  );
  return rows.map(mapDoc);
}

/** All live documents (incl. drafts) with their space, for a full export. */
export async function exportDocuments(): Promise<DocumentWithSpace[]> {
  const rows = await q(
    `${DOC_SELECT} WHERE d.deleted_at IS NULL AND d.branch_of IS NULL ORDER BY s.slug, d.slug`
  );
  return rows.map(mapDoc);
}

export async function listDocumentsBySpace(
  spaceId: number,
  includeDrafts = false
): Promise<DocumentWithSpace[]> {
  const filter = includeDrafts ? "" : " AND d.status = 'published'";
  const rows = await q(
    `${DOC_SELECT} WHERE d.space_id = $1 AND d.deleted_at IS NULL AND d.branch_of IS NULL${filter} ORDER BY d.updated_at DESC`,
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
    `${DOC_SELECT} WHERE d.deleted_at IS NULL AND d.branch_of IS NULL${filter}${scoped} ORDER BY d.updated_at DESC LIMIT $1`,
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
      `SELECT COUNT(*)::int AS n FROM documents WHERE deleted_at IS NULL AND branch_of IS NULL${filter}`,
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

// --- Space categories ---------------------------------------------------------

export interface SpaceCategory {
  id: number;
  space_id: number;
  name: string;
  position: number;
}

export async function listSpaceCategories(spaceId: number): Promise<SpaceCategory[]> {
  return q("SELECT * FROM space_categories WHERE space_id = $1 ORDER BY position, name", [spaceId]);
}

/** Every category across all spaces (editor dropdowns, admin screen). */
export async function listAllSpaceCategories(): Promise<SpaceCategory[]> {
  return q("SELECT * FROM space_categories ORDER BY space_id, position, name");
}

export async function getSpaceCategory(id: number): Promise<SpaceCategory | undefined> {
  return (await q<SpaceCategory>("SELECT * FROM space_categories WHERE id = $1", [id]))[0];
}

export async function createSpaceCategory(spaceId: number, name: string): Promise<SpaceCategory> {
  const max = (
    await q<{ m: number }>(
      "SELECT COALESCE(MAX(position), 0)::int AS m FROM space_categories WHERE space_id = $1",
      [spaceId]
    )
  )[0].m;
  return (
    await q<SpaceCategory>(
      "INSERT INTO space_categories (space_id, name, position) VALUES ($1,$2,$3) RETURNING *",
      [spaceId, name.trim().slice(0, 60), max + 1]
    )
  )[0];
}

export async function updateSpaceCategory(
  id: number,
  patch: { name?: string; position?: number }
): Promise<void> {
  if (patch.name !== undefined) {
    await q("UPDATE space_categories SET name = $1 WHERE id = $2", [
      patch.name.trim().slice(0, 60),
      id,
    ]);
  }
  if (patch.position !== undefined) {
    await q("UPDATE space_categories SET position = $1 WHERE id = $2", [patch.position, id]);
  }
}

/** Delete a category; its documents stay (category_id becomes NULL). */
export async function deleteSpaceCategory(id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM space_categories WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Per-user page width preference. */
export async function setPageWidth(userId: number, width: string): Promise<void> {
  await q("UPDATE users SET page_width = $1 WHERE id = $2", [width, userId]);
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
  /** Optional category within the space; validated against space_id. */
  category_id?: number | null;
  /** Create as a draft branch of this document. */
  branch_of?: number | null;
}

/** A category id valid for the given space, else null. */
async function categoryForSpace(categoryId: number | null | undefined, spaceId: number) {
  if (!categoryId) return null;
  const cat = await getSpaceCategory(categoryId);
  return cat && cat.space_id === spaceId ? cat.id : null;
}

export async function createDocument(input: DocInput): Promise<DocumentWithSpace> {
  const r = await q<{ id: number }>(
    `INSERT INTO documents (space_id, title, slug, type, status, content, summary, tags, author, category_id, branch_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      input.space_id,
      input.title,
      slugify(input.title) || "untitled",
      input.type,
      // Branches are working copies: they must stay drafts until merged.
      input.branch_of ? "draft" : input.status,
      input.content,
      input.summary,
      input.tags.join(","),
      input.author,
      await categoryForSpace(input.category_id, input.space_id),
      input.branch_of ?? null,
    ]
  );
  const id = r[0].id;
  await q(
    "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1,$2,$3,$4,$5)",
    [id, input.title, input.content, input.author, input.branch_of ? "Branched" : "Created"]
  );
  // Fire-and-forget semantic index (dynamic import avoids a module cycle).
  void import("./embeddings").then((m) => m.indexDocument(id)).catch(() => {});
  return (await getDocument(id))!;
}

export async function updateDocument(
  id: number,
  input: Partial<DocInput> & { versionNote?: string; restoredFrom?: number }
): Promise<DocumentWithSpace | undefined> {
  const existing = await getDocument(id);
  if (!existing) return undefined;

  const next = {
    title: input.title ?? existing.title,
    type: input.type ?? existing.type,
    // A draft branch can never be published directly — it publishes by merging.
    status: existing.branch_of ? "draft" : (input.status ?? existing.status),
    content: input.content ?? existing.content,
    summary: input.summary ?? existing.summary,
    tags: input.tags ? input.tags.join(",") : existing.tags.join(","),
    author: input.author ?? existing.author,
    space_id: input.space_id ?? existing.space_id,
    category_id: input.category_id !== undefined ? input.category_id : existing.category_id,
  };
  // A category must belong to the doc's (possibly new) space; a cross-space
  // move with a stale category quietly falls back to General.
  const categoryId = await categoryForSpace(next.category_id, next.space_id);

  await q(
    `UPDATE documents SET title=$1, slug=$2, type=$3, status=$4, content=$5, summary=$6,
       tags=$7, author=$8, space_id=$9, category_id=$10, updated_at=now() WHERE id=$11`,
    [
      next.title,
      slugify(next.title) || "untitled",
      next.type,
      next.status,
      next.content,
      next.summary,
      next.tags,
      next.author,
      next.space_id,
      categoryId,
      id,
    ]
  );

  if (next.content !== existing.content || next.title !== existing.title) {
    await q(
      "INSERT INTO doc_versions (document_id, title, content, author, note, restored_from) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, next.title, next.content, next.author, input.versionNote || "Edited", input.restoredFrom ?? null]
    );
    // Fire-and-forget semantic re-index (dynamic import avoids a module cycle).
    void import("./embeddings").then((m) => m.indexDocument(id)).catch(() => {});
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

/** The space a trashed doc belongs to (for edit-rights checks on restore). */
export async function getTrashedDocumentSpaceId(id: number): Promise<number | undefined> {
  await ready();
  const rows = await q<{ space_id: number }>(
    "SELECT space_id FROM documents WHERE id = $1 AND deleted_at IS NOT NULL",
    [id]
  );
  return rows[0]?.space_id;
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

/** Distinct authors of live documents (analytics filter options). */
export async function listAuthors(): Promise<string[]> {
  return (
    await q<{ author: string }>(
      `SELECT DISTINCT author FROM documents
       WHERE deleted_at IS NULL AND branch_of IS NULL AND author <> '' ORDER BY author`
    )
  ).map((r) => r.author);
}

export async function listVersions(documentId: number): Promise<DocVersion[]> {
  return q(
    "SELECT * FROM doc_versions WHERE document_id = $1 ORDER BY created_at DESC, id DESC",
    [documentId]
  );
}

export async function getVersion(
  documentId: number,
  versionId: number
): Promise<DocVersion | undefined> {
  return (
    await q<DocVersion>("SELECT * FROM doc_versions WHERE id = $1 AND document_id = $2", [
      versionId,
      documentId,
    ])
  )[0];
}

/** Live draft branches of a document, newest first. */
export async function listBranches(documentId: number): Promise<DocumentWithSpace[]> {
  const rows = await q(
    `${DOC_SELECT} WHERE d.branch_of = $1 AND d.deleted_at IS NULL ORDER BY d.updated_at DESC`,
    [documentId]
  );
  return rows.map(mapDoc);
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
  scope?: number[] | "all",
  /** Restrict hits to one space (the in-space search box). */
  spaceId?: number
): Promise<SearchHit[]> {
  if (!raw.trim()) return [];
  const filter =
    (includeDrafts ? "" : " AND d.status = 'published'") +
    (Array.isArray(scope) ? " AND d.space_id = ANY($3)" : "") +
    (spaceId ? ` AND d.space_id = ${Number(spaceId)}` : "");
  const rows = await q(
    `SELECT d.id, d.title, d.slug, d.type, d.status, d.tags, d.updated_at,
            s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon, s.color AS space_color,
            ts_headline('english', d.summary || ' ' || d.content, tq.query,
              'StartSel=<mark>, StopSel=</mark>, MaxWords=22, MinWords=8, ShortWord=2, MaxFragments=1') AS snippet
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     CROSS JOIN LATERAL (SELECT ${OR_TSQUERY} AS query) tq
     WHERE d.search @@ tq.query AND d.deleted_at IS NULL AND d.branch_of IS NULL${filter}
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

/** Search-hit-shaped cards for a set of ids (for merging semantic results). */
export async function searchCardsByIds(ids: number[]): Promise<Omit<SearchHit, "snippet">[]> {
  if (ids.length === 0) return [];
  const rows = await q(
    `SELECT d.id, d.title, d.slug, d.type, d.status, d.tags, d.updated_at,
            s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon, s.color AS space_color
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.id = ANY($1)`,
    [ids]
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
    updated_at: r.updated_at,
  }));
}

export async function getDocumentsByIds(ids: number[]): Promise<Document[]> {
  if (ids.length === 0) return [];
  const rows = await q("SELECT * FROM documents WHERE id = ANY($1)", [ids]);
  return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }));
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
     WHERE d.search @@ tq.query AND d.deleted_at IS NULL AND d.branch_of IS NULL${filter}
     ORDER BY ts_rank(d.search, tq.query) DESC
     LIMIT $2`,
    Array.isArray(scope) ? [raw, limit, scope] : [raw, limit]
  );
  return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }));
}

// --- Settings ----------------------------------------------------------------

// Settings values that are credentials. They're sealed with the master key on
// write and transparently opened on read; everything else stays plaintext.
const SENSITIVE_SETTINGS = new Set([
  "smtp_pass",
  "anthropic_api_key",
  "embeddings_api_key",
  "sso_client_secret",
  "backup_s3_secret_access_key",
  "backup_azure_connection_string",
  "tls_key_pem",
]);

export async function getSetting(key: string): Promise<string | undefined> {
  const value = (await q<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]))[0]
    ?.value;
  return value === undefined ? undefined : openSecret(value);
}

export async function setSetting(key: string, value: string): Promise<void> {
  const stored = SENSITIVE_SETTINGS.has(key) ? sealSecret(value) : value;
  await q(
    "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, stored]
  );
}

export async function getApprovalMode(): Promise<ApprovalMode> {
  return (await getSetting("approval_mode")) === "open" ? "open" : "strict";
}

/** All settings as a plain key→value map (missing keys simply absent). */
export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await q<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = openSecret(r.value);
  return out;
}

// --- Users -------------------------------------------------------------------

const USER_COLUMNS = `id, username, email, name, role, status, auth_provider, external_id,
  must_change_password, totp_enabled, directory_person_id, email_notifications,
  page_width, newsletter_role, created_at, last_login_at`;

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

/** Case-insensitive lookup by external id (SCIM clients vary the casing). */
export async function getUserByAnyExternalId(externalId: string): Promise<User | undefined> {
  return (
    await q<User>(`SELECT ${USER_COLUMNS} FROM users WHERE external_id = $1 ORDER BY id LIMIT 1`, [
      externalId,
    ])
  )[0];
}

/** Provision a user from a SCIM push. No password — sign-in is via SSO. */
export async function scimCreateUser(input: {
  username: string;
  name: string;
  email: string;
  externalId: string | null;
  active: boolean;
}): Promise<User> {
  const r = await q<{ id: number }>(
    `INSERT INTO users (username, email, name, role, status, auth_provider, external_id)
     VALUES ($1,$2,$3,'viewer',$4,'oidc',$5) RETURNING id`,
    [input.username, input.email, input.name, input.active ? "active" : "disabled", input.externalId]
  );
  return (await getUserById(r[0].id))!;
}

/** Partial profile update from a SCIM push; only provided fields change. */
export async function scimUpdateUser(
  id: number,
  fields: {
    username?: string;
    name?: string;
    email?: string;
    status?: "active" | "disabled";
    externalId?: string;
  }
): Promise<User | undefined> {
  const existing = await getUserById(id);
  if (!existing) return undefined;
  await q(
    `UPDATE users SET username = $1, name = $2, email = $3, status = $4, external_id = $5 WHERE id = $6`,
    [
      fields.username ?? existing.username,
      fields.name ?? existing.name,
      fields.email ?? existing.email,
      fields.status ?? existing.status,
      fields.externalId ?? existing.external_id,
      id,
    ]
  );
  return getUserById(id);
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

// --- Per-space edit rights -------------------------------------------------------

export async function getSpaceEditorUserIds(spaceId: number): Promise<number[]> {
  return (
    await q<{ user_id: number }>("SELECT user_id FROM space_editors WHERE space_id = $1", [spaceId])
  ).map((r) => r.user_id);
}

export async function getSpaceEditorGroupIds(spaceId: number): Promise<number[]> {
  return (
    await q<{ group_id: number }>(
      "SELECT group_id FROM space_editor_groups WHERE space_id = $1",
      [spaceId]
    )
  ).map((r) => r.group_id);
}

export async function setSpaceEditors(spaceId: number, userIds: number[]): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM space_editors WHERE space_id = $1", [spaceId]);
    for (const uid of userIds) {
      await client.query(
        "INSERT INTO space_editors (space_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [spaceId, uid]
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

export async function setSpaceEditorGroups(spaceId: number, groupIds: number[]): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM space_editor_groups WHERE space_id = $1", [spaceId]);
    for (const gid of groupIds) {
      await client.query(
        "INSERT INTO space_editor_groups (space_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
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

/** All edit grants at once, for the admin spaces screen. */
export async function listAllSpaceEditorGrants(): Promise<{
  users: Record<number, number[]>;
  groups: Record<number, number[]>;
}> {
  const [u, g] = await Promise.all([
    q<{ space_id: number; user_id: number }>("SELECT space_id, user_id FROM space_editors"),
    q<{ space_id: number; group_id: number }>("SELECT space_id, group_id FROM space_editor_groups"),
  ]);
  const users: Record<number, number[]> = {};
  const groups: Record<number, number[]> = {};
  for (const r of u) (users[r.space_id] ??= []).push(r.user_id);
  for (const r of g) (groups[r.space_id] ??= []).push(r.group_id);
  return { users, groups };
}

/**
 * Whether the user may author in the space under per-space rules: true when
 * the space has no grants at all (unrestricted), or the user is granted
 * directly or via a group. Role and visibility are checked by the caller.
 */
export async function spaceEditGrantAllows(spaceId: number, userId: number): Promise<boolean> {
  const rows = await q<{ ok: boolean }>(
    `SELECT (
       (NOT EXISTS (SELECT 1 FROM space_editors WHERE space_id = $1)
        AND NOT EXISTS (SELECT 1 FROM space_editor_groups WHERE space_id = $1))
       OR EXISTS (SELECT 1 FROM space_editors WHERE space_id = $1 AND user_id = $2)
       OR EXISTS (SELECT 1 FROM space_editor_groups seg
                    JOIN group_members gm ON gm.group_id = seg.group_id
                  WHERE seg.space_id = $1 AND gm.user_id = $2)
     ) AS ok`,
    [spaceId, userId]
  );
  return rows[0]?.ok ?? false;
}

/** Space ids the user may author in under per-space rules (unrestricted ∪ granted). */
export async function editGrantedSpaceIdsFor(userId: number): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `SELECT s.id FROM spaces s
     WHERE NOT EXISTS (SELECT 1 FROM space_editors se WHERE se.space_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM space_editor_groups seg WHERE seg.space_id = s.id)
     UNION
     SELECT space_id FROM space_editors WHERE user_id = $1
     UNION
     SELECT seg.space_id FROM space_editor_groups seg
       JOIN group_members gm ON gm.group_id = seg.group_id
     WHERE gm.user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.id);
}

/**
 * The space ids a user may see: every public space plus private spaces where
 * one of their groups is granted. Admins bypass (callers use "all").
 */
export async function accessibleSpaceIdsFor(userId: number): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `SELECT s.id FROM spaces s WHERE s.visibility IN ('public', 'internal')
     UNION
     SELECT sg.space_id FROM space_groups sg
       JOIN group_members gm ON gm.group_id = sg.group_id
     WHERE gm.user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.id);
}

/** Spaces exposed on the anonymous public site (visibility 'public'). */
export async function publicSpaceIds(): Promise<number[]> {
  return (await q<{ id: number }>("SELECT id FROM spaces WHERE visibility = 'public'")).map(
    (r) => r.id
  );
}

/** Public spaces with their *published* doc counts, for the public landing. */
export async function listPublicSpaces(): Promise<(Space & { doc_count: number })[]> {
  return q(
    `SELECT s.*, (SELECT COUNT(*)::int FROM documents d
       WHERE d.space_id = s.id AND d.deleted_at IS NULL AND d.status = 'published') AS doc_count
     FROM spaces s WHERE s.visibility = 'public' ORDER BY s.name`
  );
}

// --- Account ↔ directory linking & space subscriptions ---------------------------

/**
 * Link unlinked users to directory entries — by SSO external id first, then
 * by email. Returns how many links were created. Idempotent; never relinks.
 */
export async function autoLinkUsersToDirectory(): Promise<number> {
  const res = await pool().query(
    `UPDATE users u SET directory_person_id = p.id
     FROM directory_people p
     WHERE u.directory_person_id IS NULL AND p.hidden = 0
       AND (
         (u.external_id IS NOT NULL AND u.external_id <> '' AND u.external_id = p.external_id)
         OR (u.email <> '' AND lower(u.email) = lower(p.email))
       )`
  );
  return res.rowCount ?? 0;
}

export async function setUserDirectoryPerson(userId: number, personId: number | null): Promise<void> {
  await q("UPDATE users SET directory_person_id = $1 WHERE id = $2", [personId, userId]);
}

export async function setEmailNotifications(userId: number, on: boolean): Promise<void> {
  await q("UPDATE users SET email_notifications = $1 WHERE id = $2", [on ? 1 : 0, userId]);
}

export type SubscriptionState = "subscribed" | "muted" | null;

export async function getSubscriptionState(
  spaceId: number,
  userId: number
): Promise<{ state: SubscriptionState; viaGroup: boolean }> {
  const row = (
    await q<{ state: string }>(
      "SELECT state FROM space_subscriptions WHERE space_id = $1 AND user_id = $2",
      [spaceId, userId]
    )
  )[0];
  const via = (
    await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM space_subscription_groups sg
       JOIN group_members gm ON gm.group_id = sg.group_id
       WHERE sg.space_id = $1 AND gm.user_id = $2`,
      [spaceId, userId]
    )
  )[0];
  return { state: (row?.state as SubscriptionState) ?? null, viaGroup: via.n > 0 };
}

export async function setSubscriptionState(
  spaceId: number,
  userId: number,
  state: SubscriptionState
): Promise<void> {
  if (state === null) {
    await q("DELETE FROM space_subscriptions WHERE space_id = $1 AND user_id = $2", [spaceId, userId]);
  } else {
    await q(
      `INSERT INTO space_subscriptions (space_id, user_id, state) VALUES ($1,$2,$3)
       ON CONFLICT (space_id, user_id) DO UPDATE SET state = EXCLUDED.state`,
      [spaceId, userId, state]
    );
  }
}

/** A user's subscriptions (direct + via admin-assigned groups), for the account page. */
export async function listSubscriptionsForUser(
  userId: number
): Promise<{ space_id: number; name: string; slug: string; icon: string; state: SubscriptionState; via_group: boolean }[]> {
  return q(
    `SELECT s.id AS space_id, s.name, s.slug, s.icon, ss.state,
            EXISTS (
              SELECT 1 FROM space_subscription_groups sg
              JOIN group_members gm ON gm.group_id = sg.group_id
              WHERE sg.space_id = s.id AND gm.user_id = $1
            ) AS via_group
     FROM spaces s
     LEFT JOIN space_subscriptions ss ON ss.space_id = s.id AND ss.user_id = $1
     WHERE ss.state = 'subscribed'
        OR (ss.state IS DISTINCT FROM 'muted' AND EXISTS (
              SELECT 1 FROM space_subscription_groups sg
              JOIN group_members gm ON gm.group_id = sg.group_id
              WHERE sg.space_id = s.id AND gm.user_id = $1
            ))
        OR ss.state = 'muted'
     ORDER BY s.name`,
    [userId]
  );
}

export async function getSpaceSubscriptionGroupIds(spaceId: number): Promise<number[]> {
  return (
    await q<{ group_id: number }>(
      "SELECT group_id FROM space_subscription_groups WHERE space_id = $1",
      [spaceId]
    )
  ).map((r) => r.group_id);
}

export async function setSpaceSubscriptionGroups(spaceId: number, groupIds: number[]): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM space_subscription_groups WHERE space_id = $1", [spaceId]);
    for (const gid of groupIds) {
      await client.query(
        "INSERT INTO space_subscription_groups (space_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
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

export async function listAllSpaceSubscriptionGroups(): Promise<Record<number, number[]>> {
  const rows = await q<{ space_id: number; group_id: number }>(
    "SELECT space_id, group_id FROM space_subscription_groups"
  );
  const map: Record<number, number[]> = {};
  for (const r of rows) (map[r.space_id] ??= []).push(r.group_id);
  return map;
}

/**
 * Who should be emailed about activity in a space: direct subscribers plus
 * members of admin-subscribed groups, minus mutes — restricted to active
 * accounts with an email, the personal master switch on, and (crucially)
 * permission to see the space. The actor is excluded.
 */
export async function listSubscriberRecipients(
  spaceId: number,
  excludeUserId: number
): Promise<{ id: number; email: string; name: string }[]> {
  return q(
    `SELECT u.id, u.email, u.name
     FROM users u
     JOIN spaces s ON s.id = $1
     WHERE u.status = 'active' AND u.email <> '' AND u.email_notifications = 1
       AND u.id <> $2
       AND (
         EXISTS (SELECT 1 FROM space_subscriptions ss
                 WHERE ss.space_id = $1 AND ss.user_id = u.id AND ss.state = 'subscribed')
         OR (
           EXISTS (SELECT 1 FROM space_subscription_groups sg
                   JOIN group_members gm ON gm.group_id = sg.group_id
                   WHERE sg.space_id = $1 AND gm.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM space_subscriptions ss
                           WHERE ss.space_id = $1 AND ss.user_id = u.id AND ss.state = 'muted')
         )
       )
       AND (
         s.visibility IN ('public', 'internal')
         OR u.role = 'admin'
         OR EXISTS (SELECT 1 FROM space_groups spg
                    JOIN group_members gm2 ON gm2.group_id = spg.group_id
                    WHERE spg.space_id = $1 AND gm2.user_id = u.id)
       )`,
    [spaceId, excludeUserId]
  );
}

// --- Policy acknowledgements (enterprise) ---------------------------------------

export async function setAckRequired(docId: number, required: boolean): Promise<void> {
  await q("UPDATE documents SET ack_required = $1 WHERE id = $2", [required ? 1 : 0, docId]);
}

// Users "eligible" for a doc's acknowledgement = active users who can see its
// space (public/internal, admins, or granted via a group on private spaces).
// Kept as fragments so the central compliance portal and the per-doc record
// count the same people.
const ACK_VISIBILITY = `(
    s.visibility IN ('public', 'internal')
    OR u.role = 'admin'
    OR EXISTS (SELECT 1 FROM space_groups sg JOIN group_members gm ON gm.group_id = sg.group_id
               WHERE sg.space_id = s.id AND gm.user_id = u.id)
  )`;
const ACK_ELIGIBLE = `u.status = 'active' AND ${ACK_VISIBILITY}`;

/** Central compliance portal: every ack-required published doc with counts. */
export async function complianceDocs(): Promise<
  {
    id: number;
    title: string;
    space_name: string;
    space_icon: string;
    updated_at: string;
    ack_last_reminded_at: string | null;
    required: number;
    acked: number;
  }[]
> {
  return q(
    `SELECT d.id, d.title, s.name AS space_name, s.icon AS space_icon,
            d.updated_at, d.ack_last_reminded_at,
            COUNT(u.id)::int AS required,
            COUNT(u.id) FILTER (WHERE a.acknowledged_at IS NOT NULL)::int AS acked
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     LEFT JOIN users u ON ${ACK_ELIGIBLE}
     LEFT JOIN LATERAL (
       SELECT acknowledged_at FROM acknowledgements
       WHERE document_id = d.id AND user_id = u.id AND acknowledged_at >= d.updated_at
       ORDER BY acknowledged_at DESC LIMIT 1
     ) a ON true
     WHERE d.ack_required = 1 AND d.status = 'published' AND d.deleted_at IS NULL
     GROUP BY d.id, d.title, s.name, s.icon, d.updated_at, d.ack_last_reminded_at
     ORDER BY (COUNT(u.id) - COUNT(u.id) FILTER (WHERE a.acknowledged_at IS NOT NULL)) DESC, d.title`
  );
}

/** Eligible users who have NOT acknowledged the doc's current revision. */
export async function compliancePendingUsers(
  docId: number
): Promise<{ id: number; name: string; username: string; email: string }[]> {
  return q(
    `SELECT u.id, u.name, u.username, u.email
     FROM users u
     JOIN documents d ON d.id = $1
     JOIN spaces s ON s.id = d.space_id
     WHERE ${ACK_ELIGIBLE}
       AND NOT EXISTS (
         SELECT 1 FROM acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = u.id AND a.acknowledged_at >= d.updated_at
       )
     ORDER BY u.name`,
    [docId]
  );
}

/** Per-user compliance: how many required policies each active user has left. */
export async function complianceUserSummary(): Promise<
  { id: number; name: string; username: string; role: string; required: number; acked: number }[]
> {
  return q(
    `SELECT u.id, u.name, u.username, u.role,
            COUNT(d.id)::int AS required,
            COUNT(d.id) FILTER (WHERE a.acknowledged_at IS NOT NULL)::int AS acked
     FROM users u
     LEFT JOIN documents d
       ON d.ack_required = 1 AND d.status = 'published' AND d.deleted_at IS NULL
     LEFT JOIN spaces s ON s.id = d.space_id
     LEFT JOIN LATERAL (
       SELECT acknowledged_at FROM acknowledgements
       WHERE document_id = d.id AND user_id = u.id AND acknowledged_at >= d.updated_at
       ORDER BY acknowledged_at DESC LIMIT 1
     ) a ON true
     WHERE u.status = 'active'
       AND (d.id IS NULL OR ${ACK_VISIBILITY})
     GROUP BY u.id, u.name, u.username, u.role
     ORDER BY (COUNT(d.id) - COUNT(d.id) FILTER (WHERE a.acknowledged_at IS NOT NULL)) DESC, u.name`
  );
}

/** Published docs not yet requiring acknowledgement (request-ack picker). */
export async function ackCandidateDocs(): Promise<
  { id: number; title: string; space_name: string; space_icon: string }[]
> {
  return q(
    `SELECT d.id, d.title, s.name AS space_name, s.icon AS space_icon
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.ack_required = 0 AND d.status = 'published' AND d.deleted_at IS NULL
       AND d.branch_of IS NULL
     ORDER BY s.name, d.title`
  );
}

export async function setAckLastReminded(docId: number): Promise<void> {
  await q("UPDATE documents SET ack_last_reminded_at = now() WHERE id = $1", [docId]);
}

/** Record an acknowledgement (append-only; no-op if already current). */
export async function recordAcknowledgement(
  docId: number,
  userId: number,
  ip: string
): Promise<{ recorded: boolean }> {
  const current = await getCurrentAck(docId, userId);
  if (current) return { recorded: false };
  await q(
    "INSERT INTO acknowledgements (document_id, user_id, ip) VALUES ($1,$2,$3)",
    [docId, userId, ip.slice(0, 100)]
  );
  return { recorded: true };
}

/** The user's ack for the doc's *current* revision, if any. */
export async function getCurrentAck(
  docId: number,
  userId: number
): Promise<{ acknowledged_at: string } | undefined> {
  return (
    await q<{ acknowledged_at: string }>(
      `SELECT a.acknowledged_at FROM acknowledgements a
       JOIN documents d ON d.id = a.document_id
       WHERE a.document_id = $1 AND a.user_id = $2 AND a.acknowledged_at >= d.updated_at
       ORDER BY a.acknowledged_at DESC LIMIT 1`,
      [docId, userId]
    )
  )[0];
}

/**
 * Compliance status: everyone who is expected to acknowledge the doc (active
 * accounts that can see its space) with their current-revision ack, if any.
 */
export async function ackStatusForDocument(docId: number): Promise<
  { id: number; name: string; username: string; email: string; role: string; acknowledged_at: string | null }[]
> {
  return q(
    `SELECT u.id, u.name, u.username, u.email, u.role, a.acknowledged_at
     FROM users u
     JOIN documents d ON d.id = $1
     JOIN spaces s ON s.id = d.space_id
     LEFT JOIN LATERAL (
       SELECT acknowledged_at FROM acknowledgements
       WHERE document_id = $1 AND user_id = u.id AND acknowledged_at >= d.updated_at
       ORDER BY acknowledged_at DESC LIMIT 1
     ) a ON true
     WHERE u.status = 'active'
       AND (
         s.visibility IN ('public', 'internal')
         OR u.role = 'admin'
         OR EXISTS (SELECT 1 FROM space_groups sg JOIN group_members gm ON gm.group_id = sg.group_id
                    WHERE sg.space_id = s.id AND gm.user_id = u.id)
       )
     ORDER BY (a.acknowledged_at IS NULL) DESC, u.name`,
    [docId]
  );
}

/** Published ack-required docs in the user's scope they haven't confirmed yet. */
export async function listPendingAcksFor(
  userId: number,
  scope?: number[] | "all"
): Promise<{ id: number; title: string; space_name: string; space_icon: string }[]> {
  const scopeCond = Array.isArray(scope) ? " AND d.space_id = ANY($2)" : "";
  return q(
    `SELECT d.id, d.title, s.name AS space_name, s.icon AS space_icon
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     WHERE d.ack_required = 1 AND d.status = 'published' AND d.deleted_at IS NULL${scopeCond}
       AND NOT EXISTS (
         SELECT 1 FROM acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = $1 AND a.acknowledged_at >= d.updated_at
       )
     ORDER BY d.updated_at DESC
     LIMIT 20`,
    Array.isArray(scope) ? [userId, scope] : [userId]
  );
}

// --- Quick links (external shortcuts launchpad) ----------------------------------

export interface LinkCategory {
  id: number;
  name: string;
  position: number;
  created_at: string;
}

export interface QuickLink {
  id: number;
  category_id: number | null;
  title: string;
  url: string;
  description: string;
  /** favicon = cached site icon; brand = workspace logo; custom = uploaded image. */
  icon_type: "favicon" | "brand" | "custom";
  icon_file: string | null;
  icon_mime: string | null;
  position: number;
  created_at: string;
}

export async function listLinkCategories(): Promise<LinkCategory[]> {
  return q("SELECT * FROM link_categories ORDER BY position, name");
}

export async function createLinkCategory(name: string): Promise<LinkCategory> {
  const max = (
    await q<{ m: number }>("SELECT COALESCE(MAX(position), 0)::int AS m FROM link_categories")
  )[0].m;
  return (
    await q<LinkCategory>(
      "INSERT INTO link_categories (name, position) VALUES ($1,$2) RETURNING *",
      [name.trim().slice(0, 60), max + 1]
    )
  )[0];
}

export async function updateLinkCategory(
  id: number,
  patch: { name?: string; position?: number }
): Promise<void> {
  if (patch.name !== undefined) {
    await q("UPDATE link_categories SET name = $1 WHERE id = $2", [
      patch.name.trim().slice(0, 60),
      id,
    ]);
  }
  if (patch.position !== undefined) {
    await q("UPDATE link_categories SET position = $1 WHERE id = $2", [patch.position, id]);
  }
}

/** Delete a category; its links stay (category_id becomes NULL → "General"). */
export async function deleteLinkCategory(id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM link_categories WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

export async function getLink(id: number): Promise<QuickLink | undefined> {
  return (await q<QuickLink>("SELECT * FROM links WHERE id = $1", [id]))[0];
}

/**
 * Links the user may see: unrestricted ones (no link_groups rows) plus those
 * granted to one of their groups. Admins pass "all" and see everything.
 */
export async function listLinksVisibleTo(who: number | "all"): Promise<QuickLink[]> {
  if (who === "all") return q("SELECT * FROM links ORDER BY position, title");
  return q(
    `SELECT l.* FROM links l
     WHERE NOT EXISTS (SELECT 1 FROM link_groups lg WHERE lg.link_id = l.id)
        OR EXISTS (SELECT 1 FROM link_groups lg
                     JOIN group_members gm ON gm.group_id = lg.group_id
                   WHERE lg.link_id = l.id AND gm.user_id = $1)
     ORDER BY l.position, l.title`,
    [who]
  );
}

/** Whether a specific link is visible to the user (icon serving). */
export async function linkVisibleTo(linkId: number, userId: number): Promise<boolean> {
  const rows = await q<{ ok: boolean }>(
    `SELECT (NOT EXISTS (SELECT 1 FROM link_groups lg WHERE lg.link_id = $1)
         OR EXISTS (SELECT 1 FROM link_groups lg
                      JOIN group_members gm ON gm.group_id = lg.group_id
                    WHERE lg.link_id = $1 AND gm.user_id = $2)) AS ok`,
    [linkId, userId]
  );
  return rows[0]?.ok ?? false;
}

export async function createLink(input: {
  category_id: number | null;
  title: string;
  url: string;
  description: string;
  icon_type: QuickLink["icon_type"];
  icon_file?: string | null;
  icon_mime?: string | null;
}): Promise<QuickLink> {
  const max = (
    await q<{ m: number }>("SELECT COALESCE(MAX(position), 0)::int AS m FROM links")
  )[0].m;
  return (
    await q<QuickLink>(
      `INSERT INTO links (category_id, title, url, description, icon_type, icon_file, icon_mime, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        input.category_id,
        input.title.trim().slice(0, 120),
        input.url.trim().slice(0, 2000),
        input.description.trim().slice(0, 300),
        input.icon_type,
        input.icon_file ?? null,
        input.icon_mime ?? null,
        max + 1,
      ]
    )
  )[0];
}

export async function updateLink(
  id: number,
  patch: Partial<{
    category_id: number | null;
    title: string;
    url: string;
    description: string;
    icon_type: QuickLink["icon_type"];
    icon_file: string | null;
    icon_mime: string | null;
    position: number;
  }>
): Promise<QuickLink | undefined> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.category_id !== undefined) push("category_id", patch.category_id);
  if (patch.title !== undefined) push("title", patch.title.trim().slice(0, 120));
  if (patch.url !== undefined) push("url", patch.url.trim().slice(0, 2000));
  if (patch.description !== undefined) push("description", patch.description.trim().slice(0, 300));
  if (patch.icon_type !== undefined) push("icon_type", patch.icon_type);
  if (patch.icon_file !== undefined) push("icon_file", patch.icon_file);
  if (patch.icon_mime !== undefined) push("icon_mime", patch.icon_mime);
  if (patch.position !== undefined) push("position", patch.position);
  if (!sets.length) return getLink(id);
  vals.push(id);
  return (
    await q<QuickLink>(`UPDATE links SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals)
  )[0];
}

/** Delete a link; returns the row so callers can clean up its icon file. */
export async function deleteLink(id: number): Promise<QuickLink | undefined> {
  return (await q<QuickLink>("DELETE FROM links WHERE id = $1 RETURNING *", [id]))[0];
}

export async function getLinkGroupIds(linkId: number): Promise<number[]> {
  return (
    await q<{ group_id: number }>("SELECT group_id FROM link_groups WHERE link_id = $1", [linkId])
  ).map((r) => r.group_id);
}

/** link_id → granted group ids for the whole workspace (admin UI). */
export async function listAllLinkGroups(): Promise<Record<number, number[]>> {
  const rows = await q<{ link_id: number; group_id: number }>(
    "SELECT link_id, group_id FROM link_groups ORDER BY link_id"
  );
  const map: Record<number, number[]> = {};
  for (const r of rows) (map[r.link_id] ??= []).push(r.group_id);
  return map;
}

export async function setLinkGroups(linkId: number, groupIds: number[]): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM link_groups WHERE link_id = $1", [linkId]);
    for (const gid of groupIds) {
      await client.query(
        "INSERT INTO link_groups (link_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [linkId, gid]
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

// --- Document comments (0.38) -----------------------------------------------------

export interface DocComment {
  id: number;
  document_id: number;
  user_id: number | null;
  author_name: string;
  body: string;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string;
  /** Users @mentioned in this comment (for highlighting + notifications). */
  mentions: { id: number; name: string }[];
}

/**
 * Comments for a document, oldest first. Deleted comments come back with an
 * EMPTY body (the content never leaves the server again) plus who removed
 * them, so the thread keeps its shape.
 */
export async function listDocComments(documentId: number): Promise<DocComment[]> {
  return q(
    `SELECT c.id, c.document_id, c.user_id, c.author_name,
       CASE WHEN c.deleted_at IS NULL THEN c.body ELSE '' END AS body,
       c.created_at, c.deleted_at, c.deleted_by,
       COALESCE(
         (SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
            FROM doc_comment_mentions m JOIN users u ON u.id = m.user_id
           WHERE m.comment_id = c.id),
         '[]'::json
       ) AS mentions
     FROM doc_comments c
     WHERE c.document_id = $1
     ORDER BY c.created_at ASC, c.id ASC
     LIMIT 500`,
    [documentId]
  );
}

export async function createDocComment(input: {
  document_id: number;
  user_id: number;
  author_name: string;
  body: string;
  mention_user_ids: number[];
}): Promise<DocComment> {
  const row = (
    await q<Omit<DocComment, "mentions">>(
      `INSERT INTO doc_comments (document_id, user_id, author_name, body)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [input.document_id, input.user_id, input.author_name.slice(0, 100), input.body]
    )
  )[0];
  let mentions: DocComment["mentions"] = [];
  if (input.mention_user_ids.length > 0) {
    mentions = await q(
      `INSERT INTO doc_comment_mentions (comment_id, user_id)
       SELECT $1, u.id FROM users u WHERE u.id = ANY($2) AND u.status = 'active'
       ON CONFLICT DO NOTHING
       RETURNING user_id AS id, (SELECT name FROM users WHERE id = user_id) AS name`,
      [row.id, input.mention_user_ids]
    );
  }
  return { ...row, mentions };
}

export async function getDocComment(
  id: number
): Promise<(Omit<DocComment, "mentions"> & { space_id: number }) | undefined> {
  return (
    await q<Omit<DocComment, "mentions"> & { space_id: number }>(
      `SELECT c.*, d.space_id FROM doc_comments c
       JOIN documents d ON d.id = c.document_id WHERE c.id = $1`,
      [id]
    )
  )[0];
}

/** Soft delete: clears nothing in the row but marks it removed; the body is
 * filtered out at read time. Idempotent. */
export async function softDeleteDocComment(id: number, byLabel: string): Promise<boolean> {
  const res = await pool().query(
    `UPDATE doc_comments SET deleted_at = now(), deleted_by = $2
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, byLabel.slice(0, 100)]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Mention notification targets: active users among the given ids. */
export async function getMentionTargets(
  ids: number[]
): Promise<{ id: number; name: string; email: string; email_notifications: number }[]> {
  if (ids.length === 0) return [];
  return q(
    `SELECT id, name, email, email_notifications FROM users
     WHERE id = ANY($1) AND status = 'active'`,
    [ids]
  );
}

/** Active users a comment can @mention (any signed-in user may look this up). */
export async function listMentionableUsers(): Promise<{ id: number; name: string; username: string }[]> {
  return q(
    `SELECT id, name, username FROM users WHERE status = 'active' ORDER BY name, username`
  );
}

// --- Organization announcements ---------------------------------------------------

export interface Announcement {
  id: number;
  title: string;
  body: string;
  level: "info" | "warning" | "critical";
  author_name: string;
  created_by: number | null;
  created_at: string;
  expires_at: string | null;
  archived_at: string | null;
  /** When set, only this user sees it (mention notifications). */
  target_user_id: number | null;
  /** Optional link rendered as a button on the dashboard block. */
  link: string;
}

export async function createAnnouncement(input: {
  title: string;
  body: string;
  level: Announcement["level"];
  author_name: string;
  created_by: number;
  /** Days until auto-hide; null/0 = never expires. */
  expires_days?: number | null;
  /** Only this user sees it (mention notifications); omit for org-wide. */
  target_user_id?: number;
  /** Optional link shown as a button on the dashboard block. */
  link?: string;
}): Promise<Announcement> {
  return (
    await q<Announcement>(
      `INSERT INTO announcements (title, body, level, author_name, created_by, expires_at, target_user_id, link)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int > 0 THEN now() + ($6::int || ' days')::interval END, $7, $8)
       RETURNING *`,
      [
        input.title.trim().slice(0, 150),
        input.body.trim().slice(0, 4000),
        input.level,
        input.author_name.slice(0, 100),
        input.created_by,
        input.expires_days ?? 0,
        input.target_user_id ?? null,
        (input.link ?? "").slice(0, 500),
      ]
    )
  )[0];
}

/** Live announcements for a user's dashboard (not expired/archived/dismissed). */
export async function listActiveAnnouncementsFor(userId: number): Promise<Announcement[]> {
  return q(
    `SELECT a.* FROM announcements a
     WHERE a.archived_at IS NULL
       AND (a.expires_at IS NULL OR a.expires_at > now())
       AND (a.target_user_id IS NULL OR a.target_user_id = $1)
       AND NOT EXISTS (
         SELECT 1 FROM announcement_dismissals d
         WHERE d.announcement_id = a.id AND d.user_id = $1
       )
     ORDER BY a.created_at DESC
     LIMIT 10`,
    [userId]
  );
}

/** Every announcement with a per-row dismissal count, for the admin screen. */
export async function listAllAnnouncements(): Promise<(Announcement & { dismissed_count: number })[]> {
  return q(
    `SELECT a.*,
       (SELECT COUNT(*) FROM announcement_dismissals d WHERE d.announcement_id = a.id)::int
         AS dismissed_count
     FROM announcements a WHERE a.target_user_id IS NULL
     ORDER BY a.created_at DESC LIMIT 100`
  );
}

export async function setAnnouncementArchived(id: number, archived: boolean): Promise<boolean> {
  const res = await pool().query(
    `UPDATE announcements SET archived_at = CASE WHEN $2 THEN now() END WHERE id = $1`,
    [id, archived]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteAnnouncement(id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM announcements WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Per-user dismiss (idempotent). */
export async function dismissAnnouncement(id: number, userId: number): Promise<void> {
  await q(
    `INSERT INTO announcement_dismissals (announcement_id, user_id)
     SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM announcements WHERE id = $1)
     ON CONFLICT DO NOTHING`,
    [id, userId]
  );
}

/**
 * Email recipients for an announcement: every active account with an email,
 * or only members of the given groups. Deduplicated.
 */
export async function listAnnouncementRecipients(
  groupIds: number[] | "all"
): Promise<{ email: string; name: string }[]> {
  if (groupIds === "all") {
    return q(
      `SELECT DISTINCT email, name FROM users
       WHERE status = 'active' AND email <> '' ORDER BY email`
    );
  }
  if (groupIds.length === 0) return [];
  return q(
    `SELECT DISTINCT u.email, u.name FROM users u
     JOIN group_members gm ON gm.user_id = u.id
     WHERE gm.group_id = ANY($1) AND u.status = 'active' AND u.email <> ''
     ORDER BY u.email`,
    [groupIds]
  );
}

// --- Newsletters -------------------------------------------------------------------

export type NewsletterStatus = "draft" | "in_review" | "changes_requested" | "approved" | "sent";

export const NEWSLETTER_STATUSES: NewsletterStatus[] = [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "sent",
];

export interface Newsletter {
  id: number;
  subject: string;
  body: string;
  author_name: string;
  created_by: number | null;
  audience: string;
  sent_count: number;
  status: NewsletterStatus;
  /** Planned recipients: 'all' or 'groups' (group_ids holds the ids). */
  mode: string;
  group_ids: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  /** When set (status approved), the sweeper sends it at this time. */
  scheduled_at: string | null;
  scheduled_origin: string;
  /** Sender override from the admin-curated list; '' = SMTP default. */
  from_address: string;
  /** Space that receives an archive document on send; null = no archive. */
  archive_space_id: number | null;
}

export interface NewsletterComment {
  id: number;
  newsletter_id: number;
  user_id: number | null;
  author_name: string;
  body: string;
  /** comment | submitted | changes_requested | approved | sent — events share the thread. */
  kind: string;
  created_at: string;
}

export async function createNewsletterDraft(input: {
  subject: string;
  body: string;
  author_name: string;
  created_by: number;
  mode: string;
  group_ids: string;
}): Promise<Newsletter> {
  return (
    await q<Newsletter>(
      `INSERT INTO newsletters (subject, body, author_name, created_by, status, mode, group_ids)
       VALUES ($1,$2,$3,$4,'draft',$5,$6) RETURNING *`,
      [
        input.subject.trim().slice(0, 200),
        input.body.slice(0, 100_000),
        input.author_name.slice(0, 100),
        input.created_by,
        input.mode === "groups" ? "groups" : "all",
        input.group_ids.slice(0, 300),
      ]
    )
  )[0];
}

export async function getNewsletter(id: number): Promise<Newsletter | undefined> {
  return (await q<Newsletter>("SELECT * FROM newsletters WHERE id = $1", [id]))[0];
}

/**
 * Newsletters visible to a user: everything for admins/approvers (seeAll),
 * otherwise only their own. Sent history is visible to anyone with access
 * to the module. Capped, newest activity first.
 */
export async function listNewslettersFor(userId: number, seeAll: boolean): Promise<Newsletter[]> {
  if (seeAll) {
    return q("SELECT * FROM newsletters ORDER BY updated_at DESC LIMIT 100");
  }
  return q(
    `SELECT * FROM newsletters WHERE created_by = $1 OR status = 'sent'
     ORDER BY updated_at DESC LIMIT 100`,
    [userId]
  );
}

export async function updateNewsletterContent(
  id: number,
  input: {
    subject: string;
    body: string;
    mode: string;
    group_ids: string;
    from_address: string;
    archive_space_id: number | null;
  }
): Promise<Newsletter | undefined> {
  return (
    await q<Newsletter>(
      `UPDATE newsletters SET subject = $2, body = $3, mode = $4, group_ids = $5,
       from_address = $6, archive_space_id = $7, updated_at = now() WHERE id = $1 RETURNING *`,
      [
        id,
        input.subject.trim().slice(0, 200),
        input.body.slice(0, 100_000),
        input.mode === "groups" ? "groups" : "all",
        input.group_ids.slice(0, 300),
        input.from_address.slice(0, 200),
        input.archive_space_id,
      ]
    )
  )[0];
}

export async function setNewsletterStatus(
  id: number,
  status: NewsletterStatus
): Promise<Newsletter | undefined> {
  return (
    await q<Newsletter>(
      "UPDATE newsletters SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [id, status]
    )
  )[0];
}

/** Stamp a newsletter as sent with the final audience + recipient count. */
export async function markNewsletterSent(
  id: number,
  audience: string,
  sentCount: number
): Promise<void> {
  await q(
    `UPDATE newsletters SET status = 'sent', audience = $2, sent_count = $3,
     sent_at = now(), updated_at = now(), scheduled_at = NULL WHERE id = $1`,
    [id, audience.slice(0, 300), sentCount]
  );
}

export async function deleteNewsletter(id: number): Promise<void> {
  await q("DELETE FROM newsletters WHERE id = $1", [id]);
}

/** Per-newsletter approver override; empty = the whole approver pool may act. */
export async function getNewsletterApproverIds(newsletterId: number): Promise<number[]> {
  const rows = await q<{ user_id: number }>(
    "SELECT user_id FROM newsletter_approvers WHERE newsletter_id = $1 ORDER BY user_id",
    [newsletterId]
  );
  return rows.map((r) => r.user_id);
}

export async function setNewsletterApprovers(newsletterId: number, userIds: number[]): Promise<void> {
  await q("DELETE FROM newsletter_approvers WHERE newsletter_id = $1", [newsletterId]);
  for (const uid of [...new Set(userIds)]) {
    await q(
      `INSERT INTO newsletter_approvers (newsletter_id, user_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [newsletterId, uid]
    );
  }
}

export async function addNewsletterComment(input: {
  newsletter_id: number;
  /** null for system events (the schedule sweeper). */
  user_id: number | null;
  author_name: string;
  body: string;
  kind: string;
}): Promise<NewsletterComment> {
  return (
    await q<NewsletterComment>(
      `INSERT INTO newsletter_comments (newsletter_id, user_id, author_name, body, kind)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        input.newsletter_id,
        input.user_id,
        input.author_name.slice(0, 100),
        input.body.slice(0, 10_000),
        input.kind.slice(0, 30),
      ]
    )
  )[0];
}

export async function listNewsletterComments(newsletterId: number): Promise<NewsletterComment[]> {
  return q(
    "SELECT * FROM newsletter_comments WHERE newsletter_id = $1 ORDER BY created_at ASC, id ASC LIMIT 500",
    [newsletterId]
  );
}

/** Active users who can approve newsletters: capability holders plus admins. */
export async function listNewsletterApproverPool(): Promise<
  { id: number; name: string; email: string }[]
> {
  return q(
    `SELECT id, name, email FROM users
     WHERE status = 'active' AND (newsletter_role = 'approver' OR role = 'admin')
     ORDER BY name`
  );
}

export async function setUserNewsletterRole(userId: number, role: string): Promise<void> {
  const value = role === "contributor" || role === "approver" ? role : "none";
  await q("UPDATE users SET newsletter_role = $2 WHERE id = $1", [userId, value]);
}

/** Set (or clear, with null) the send time of an approved newsletter. */
export async function setNewsletterSchedule(
  id: number,
  at: string | null,
  origin: string
): Promise<Newsletter | undefined> {
  return (
    await q<Newsletter>(
      `UPDATE newsletters SET scheduled_at = $2, scheduled_origin = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, at, at ? origin.slice(0, 300) : ""]
    )
  )[0];
}

/**
 * Claim newsletters whose scheduled send time has arrived. Clearing
 * scheduled_at in the same statement makes the claim atomic — concurrent
 * sweeps (or a manual send racing the sweeper) can't double-send.
 */
export async function claimDueNewsletters(): Promise<Newsletter[]> {
  return q<Newsletter>(
    `UPDATE newsletters SET scheduled_at = NULL
     WHERE status = 'approved' AND scheduled_at IS NOT NULL AND scheduled_at <= now()
     RETURNING *`
  );
}

/** Sent newsletters still fresh enough for the dashboard, minus dismissed. */
export async function listDashboardNewslettersFor(
  userId: number,
  days = 3
): Promise<Newsletter[]> {
  return q<Newsletter>(
    `SELECT n.* FROM newsletters n
     WHERE n.status = 'sent' AND n.sent_at > now() - ($2 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM newsletter_dismissals d
         WHERE d.newsletter_id = n.id AND d.user_id = $1
       )
     ORDER BY n.sent_at DESC LIMIT 10`,
    [userId, days]
  );
}

export async function dismissNewsletter(userId: number, newsletterId: number): Promise<void> {
  await q(
    `INSERT INTO newsletter_dismissals (newsletter_id, user_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [newsletterId, userId]
  );
}

export interface NewsletterFile {
  id: number;
  newsletter_id: number;
  filename: string;
  stored_name: string;
  mime_type: string;
  size: number;
  created_at: string;
}

export async function addNewsletterFile(input: {
  newsletter_id: number;
  filename: string;
  stored_name: string;
  mime_type: string;
  size: number;
}): Promise<NewsletterFile> {
  return (
    await q<NewsletterFile>(
      `INSERT INTO newsletter_files (newsletter_id, filename, stored_name, mime_type, size)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        input.newsletter_id,
        input.filename.slice(0, 200),
        input.stored_name,
        input.mime_type.slice(0, 100),
        input.size,
      ]
    )
  )[0];
}

export async function listNewsletterFiles(newsletterId: number): Promise<NewsletterFile[]> {
  return q("SELECT * FROM newsletter_files WHERE newsletter_id = $1 ORDER BY id", [newsletterId]);
}

export async function getNewsletterFile(id: number): Promise<NewsletterFile | undefined> {
  return (await q<NewsletterFile>("SELECT * FROM newsletter_files WHERE id = $1", [id]))[0];
}

export async function deleteNewsletterFileRow(id: number): Promise<void> {
  await q("DELETE FROM newsletter_files WHERE id = $1", [id]);
}

// --- Site icons (external-link favicons) ---------------------------------------

export interface SiteIcon {
  host: string;
  stored_name: string;
  mime: string;
  fetched_at: string;
}

export async function getSiteIcon(host: string): Promise<SiteIcon | undefined> {
  return (await q<SiteIcon>("SELECT * FROM site_icons WHERE host = $1", [host]))[0];
}

export async function saveSiteIcon(host: string, stored: string, mime: string): Promise<void> {
  await q(
    `INSERT INTO site_icons (host, stored_name, mime, fetched_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (host) DO UPDATE SET stored_name = $2, mime = $3, fetched_at = now()`,
    [host, stored, mime]
  );
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

// Sessions are stored by the SHA-256 of the cookie token, so a leaked database
// can't be replayed as a login. The raw token exists only in the user's cookie.
function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  token: string,
  userId: number,
  expiresAt: string,
  ip?: string | null,
  userAgent?: string | null
): Promise<void> {
  await q("INSERT INTO sessions (token, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)", [
    sessionKey(token),
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
    [userId, sessionKey(currentToken)]
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
    sessionKey(currentToken),
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
      [sessionKey(token)]
    )
  )[0];
}

/** Slide a session's expiry forward (sliding idle timeout). */
export async function touchSession(token: string, expiresAt: string): Promise<void> {
  await q("UPDATE sessions SET expires_at = $1 WHERE token = $2", [expiresAt, sessionKey(token)]);
}

export async function deleteSession(token: string): Promise<void> {
  await q("DELETE FROM sessions WHERE token = $1", [sessionKey(token)]);
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
  /** Move the doc to this space on approval (null/undefined = stay put). */
  space_id?: number | null;
}): Promise<number> {
  const r = await q<{ id: number }>(
    `INSERT INTO change_requests (document_id, kind, title, content, summary, tags, type, target_status, note, created_by, space_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
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
      input.space_id ?? null,
    ]
  );
  return r[0].id;
}

const CR_SELECT = `
  SELECT cr.*, u.name AS author_name, d.title AS document_title,
         s.visibility AS space_visibility, ts.name AS target_space_name
  FROM change_requests cr
  JOIN users u ON u.id = cr.created_by
  LEFT JOIN documents d ON d.id = cr.document_id
  LEFT JOIN spaces s ON s.id = d.space_id
  LEFT JOIN spaces ts ON ts.id = cr.space_id`;

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
      `UPDATE documents SET title=$1, slug=$2, type=$3, status=$4, content=$5, summary=$6, tags=$7,
         space_id=COALESCE($8, space_id), updated_at=now()
       WHERE id=$9`,
      [
        cr.title,
        slugify(cr.title) || "untitled",
        cr.type,
        cr.target_status,
        cr.content,
        cr.summary,
        cr.tags,
        cr.space_id ?? null,
        cr.document_id,
      ]
    );
    await client.query(
      "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1,$2,$3,$4,$5)",
      [
        cr.document_id,
        cr.title,
        cr.content,
        cr.author_name,
        // Keep the submitter's change note; record who approved it.
        cr.note ? `${cr.note} — approved by ${reviewerName}` : `Approved by ${reviewerName}`,
      ]
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
