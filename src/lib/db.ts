import { Pool, types } from "pg";
import { createHash, randomBytes } from "node:crypto";
import { SEED_SPACES, SEED_DOCS } from "./seed-data";
import { hashPassword } from "./password";
import { sealSecret, openSecret, isSealed, getMasterKey, MasterKeyError } from "./secretbox";
import { asScope } from "./space-scope";
import type { SpaceScope } from "./space-scope";
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
  // Probe the master key up front so an unreadable key file (e.g. a missed
  // volume chown after the 0.59 non-root upgrade) is one loud, actionable log
  // line at boot — not a scatter of decrypt failures later. Non-fatal: the
  // app still serves everything that doesn't need sealed credentials.
  try {
    getMasterKey();
  } catch (e) {
    if (e instanceof MasterKeyError) console.error(`[secretbox] ${e.message}`);
    else throw e;
  }
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(id) FROM (SELECT 728341 AS id) t");
    await client.query(SCHEMA_SQL);
    await syncPresetRoles(client);
    await migrateLadderToAssignments(client);
    await migrateDelegationToAssignments(client);
    // After syncPresetRoles, which is what creates space-member/space-author.
    await migrateSpaceGrantsToAssignments(client);
    await dropLegacySpaceGrantTables(client);
    await migrateVisibilityTiers(client);
    await migrateSecuritySealing(client);
    await migrateWeightedSearch(client);
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
  -- Which layout a space opens with ('cards' | 'table' | 'tree' | 'board' | 'timeline' | 'tags');
  -- visitors can switch views and their choice is remembered per browser.
  ALTER TABLE spaces ADD COLUMN IF NOT EXISTS default_view text NOT NULL DEFAULT 'cards';
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
    -- Weighted: title (A) outranks summary/tags (B) outranks body (C), so a
    -- doc TITLED "deploy" beats one that merely mentions it. Existing installs
    -- are rewritten by migrateWeightedSearch().
    search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
      setweight(to_tsvector('english', coalesce(summary,'')), 'B') ||
      setweight(to_tsvector('english', coalesce(replace(tags, ',', ' '), '')), 'B') ||
      setweight(to_tsvector('english', coalesce(content,'')), 'C')
    ) STORED
  );
  CREATE INDEX IF NOT EXISTS idx_documents_space ON documents(space_id);
  -- Doc pages resolve by (space, slug) — give that lookup its exact index so
  -- it stays O(log n) in spaces with thousands of documents.
  CREATE INDEX IF NOT EXISTS idx_documents_space_slug ON documents(space_id, slug);
  CREATE INDEX IF NOT EXISTS idx_documents_search ON documents USING gin(search);

  -- Soft delete: non-null deleted_at means the doc is in the Trash.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
  CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted_at);

  -- Draft branches: a working copy linked to its source document. Branches are
  -- always drafts, are hidden from listings/search, and go away on merge.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS branch_of integer REFERENCES documents(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_documents_branch ON documents(branch_of);

  -- Document templates: reusable starting points for new documents. Built-ins
  -- are seeded by key (editable, hideable, resettable); customs have no key.
  CREATE TABLE IF NOT EXISTS doc_templates (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    builtin_key text UNIQUE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    doc_type text NOT NULL DEFAULT 'knowledge',
    title_pattern text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    tags text NOT NULL DEFAULT '',
    body text NOT NULL DEFAULT '',
    hidden integer NOT NULL DEFAULT 0,
    created_by integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- A space can suggest a template for new documents created in it.
  ALTER TABLE spaces ADD COLUMN IF NOT EXISTS default_template_id integer REFERENCES doc_templates(id) ON DELETE SET NULL;

  -- Nested pages: an optional parent within the same space (3-level cap
  -- enforced in code) and a manual sibling order. Off by default; admins
  -- enable it under Settings → Workspace.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS parent_id integer REFERENCES documents(id) ON DELETE SET NULL;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_id);

  -- Content review reminders: an optional re-review cadence per document.
  -- interval null = off; due/reminded/last-reviewed drive the nudges.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_interval_days integer;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_due_at timestamptz;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_reminded_at timestamptz;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_reviewed_at timestamptz;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_reviewed_by text;

  -- Scheduled publish / auto-unpublish: one-shot timestamps cleared when the
  -- minute tick fires them (claims are atomic UPDATEs, multi-instance safe).
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS publish_at timestamptz;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS archive_at timestamptz;

  -- Public share links: a tokenized read-only link to one published doc.
  -- Revoked rows are kept for the audit trail; at most one active per doc.
  CREATE TABLE IF NOT EXISTS doc_shares (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,
    created_by integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    revoked_at timestamptz,
    view_count integer NOT NULL DEFAULT 0,
    last_viewed_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_doc_shares_doc ON doc_shares(document_id);

  -- Automatic backlinks: one row per internal /doc/N link found in a
  -- document's content, refreshed on every save.
  CREATE TABLE IF NOT EXISTS doc_links (
    from_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    to_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE INDEX IF NOT EXISTS idx_doc_links_to ON doc_links(to_id);

  -- Typed links between documents (policy ↔ procedures, supersession, etc.).
  -- One row per link; symmetric/reverse display is resolved at query time.
  CREATE TABLE IF NOT EXISTS doc_relations (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    target_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT 'related',
    created_by integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (doc_id, target_id, kind),
    CHECK (doc_id <> target_id)
  );
  CREATE INDEX IF NOT EXISTS idx_relations_doc ON doc_relations(doc_id);
  CREATE INDEX IF NOT EXISTS idx_relations_target ON doc_relations(target_id);

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
  -- Group external ids are unique per SOURCE, not globally (0.96). The old
  -- index made "the same team, synced from two directories" unrepresentable —
  -- an Entra GUID and a Google numeric id will not collide in practice, but the
  -- constraint said they must not, which is a different claim. Safe to swap:
  -- every non-null row today is source='entra'.
  DROP INDEX IF EXISTS idx_groups_external;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_source_external
    ON groups(source, external_id) WHERE external_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS group_members (
    group_id integer NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  -- For the hourly expired-session sweep (see runDbMaintenance).
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  -- Single-use guard for SAML responses (replay defense, enterprise SSO). Keyed
  -- on a hash of the response; rows expire with the assertion window.
  CREATE TABLE IF NOT EXISTS saml_seen_responses (
    digest text PRIMARY KEY,
    expires_at timestamptz NOT NULL
  );

  -- Device metadata for the "active sessions" account page.
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip text;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;

  -- TOTP two-factor auth: secret + hashed one-time recovery codes.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled integer NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery jsonb NOT NULL DEFAULT '[]'::jsonb;
  -- Highest accepted TOTP time-step, to reject replay of a code within its window.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint NOT NULL DEFAULT 0;
  -- Personal incoming-webhook URL (Slack/Teams); notifications POST there too.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_webhook_url text NOT NULL DEFAULT '';

  -- Personal account settings (0.73.0): appearance, locale, avatar, and
  -- per-event notification routing. notify_prefs maps kind -> channel booleans
  -- ({"mention":{"inapp":false}}); a missing kind/channel means "on", so an
  -- empty object preserves pre-0.73 behavior exactly.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'system';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS date_format text NOT NULL DEFAULT 'auto';
  -- Small data: URL (client-resized to ~128px); empty = initials.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
  -- ISO week ("2026-W31") of the user's last weekly digest, for per-timezone sends.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_last_week text NOT NULL DEFAULT '';

  -- Per-user notification inbox (the bell). Rows are cheap and pruned by the
  -- hourly maintenance sweep once read and older than 90 days.
  CREATE TABLE IF NOT EXISTS notifications (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    link text NOT NULL DEFAULT '',
    actor_name text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications(user_id, created_at DESC);

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
  -- Token scopes for the public REST API. Pre-scope tokens keep full
  -- read+write (matches their historical behavior with the MCP connector).
  ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS
    scopes jsonb NOT NULL DEFAULT '["read","write"]'::jsonb;

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

  -- "Was this helpful?" votes: one per user per document, revisable.
  CREATE TABLE IF NOT EXISTS doc_feedback (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    helpful smallint NOT NULL,
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_doc ON doc_feedback(document_id);

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

  -- Links to records in external document-management systems (iManage,
  -- NetDocuments, SharePoint, …). Shown alongside attachments on the doc,
  -- but nothing is stored locally — they're just titled deep links.
  CREATE TABLE IF NOT EXISTS doc_dms_links (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    system text NOT NULL DEFAULT 'link',
    title text NOT NULL,
    url text NOT NULL,
    added_by text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_dms_links_doc ON doc_dms_links(document_id);

  -- SaaS status board (0.74.0): the third-party tools an org tracks, polled
  -- from their public status pages (or Graph for M365), plus manual incidents
  -- for internal systems that have no status page. status is the normalized
  -- vendor state: operational | degraded | outage | maintenance | unknown.
  CREATE TABLE IF NOT EXISTS status_services (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    provider text NOT NULL DEFAULT 'statuspage',
    source_url text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'unknown',
    status_detail text NOT NULL DEFAULT '',
    status_url text NOT NULL DEFAULT '',
    last_checked_at timestamptz,
    last_changed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS status_incidents (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    service_id integer NOT NULL REFERENCES status_services(id) ON DELETE CASCADE,
    title text NOT NULL,
    severity text NOT NULL DEFAULT 'outage',
    state text NOT NULL DEFAULT 'open',
    created_by text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS status_incident_updates (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_id integer NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
    body text NOT NULL,
    author text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_status_incidents_service ON status_incidents(service_id);
  CREATE INDEX IF NOT EXISTS idx_status_inc_updates ON status_incident_updates(incident_id);

  -- Who has a document open in the editor right now (heartbeat rows). Rows
  -- older than ~2 minutes are dead sessions; the hourly sweep clears them.
  CREATE TABLE IF NOT EXISTS doc_editing_presence (
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_name text NOT NULL DEFAULT '',
    last_seen timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, user_id)
  );

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
  -- Palette typeahead: lower(name) LIKE 'maya%'. text_pattern_ops is required —
  -- a plain btree on lower(name) will NOT serve a LIKE prefix under a non-C
  -- collation.
  CREATE INDEX IF NOT EXISTS idx_directory_name_lower
    ON directory_people(lower(name) text_pattern_ops);
  CREATE INDEX IF NOT EXISTS idx_directory_email_lower
    ON directory_people(lower(email) text_pattern_ops);

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
  -- Weekly digest email: opt-in (0 = off) so existing installs see no new mail.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_digest integer NOT NULL DEFAULT 0;

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

  -- Training decks (enterprise "training" entitlement): a published document
  -- becomes a slide deck (split on ---) that can be assigned to users with a
  -- due date and a final compliance confirmation. Completion records the doc
  -- version confirmed, so a later edit is visible in the audit trail.
  CREATE TABLE IF NOT EXISTS training_decks (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    active integer NOT NULL DEFAULT 1,
    due_days integer,
    assign_new_members integer NOT NULL DEFAULT 0,
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS training_assignments (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    deck_id integer NOT NULL REFERENCES training_decks(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by text NOT NULL DEFAULT '',
    source text NOT NULL DEFAULT 'manual',
    assigned_at timestamptz NOT NULL DEFAULT now(),
    due_at timestamptz,
    last_slide integer NOT NULL DEFAULT 0,
    completed_at timestamptz,
    confirmed_version integer,
    reminded_at timestamptz,
    UNIQUE (deck_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_training_user ON training_assignments(user_id, completed_at);
  ALTER TABLE training_decks ADD COLUMN IF NOT EXISTS archived_at timestamptz;

  -- Onboarding programs: a named bundle of decks. Active programs with
  -- assign_new_members auto-assign every deck to just-created users, and a
  -- program can be assigned to people/groups/everyone as one unit.
  CREATE TABLE IF NOT EXISTS training_programs (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    active integer NOT NULL DEFAULT 1,
    assign_new_members integer NOT NULL DEFAULT 1,
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS training_program_decks (
    program_id integer NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,
    deck_id integer NOT NULL REFERENCES training_decks(id) ON DELETE CASCADE,
    position integer NOT NULL DEFAULT 0,
    PRIMARY KEY (program_id, deck_id)
  );

  -- 0.80: quizzes (server-graded score gates the confirmation), recurring
  -- recertification, overdue escalation, and a history table that keeps each
  -- prior completion when an assignment reopens for a new cycle.
  ALTER TABLE training_decks ADD COLUMN IF NOT EXISTS pass_pct integer NOT NULL DEFAULT 80;
  ALTER TABLE training_decks ADD COLUMN IF NOT EXISTS recert_months integer;
  ALTER TABLE training_assignments ADD COLUMN IF NOT EXISTS quiz_score integer;
  ALTER TABLE training_assignments ADD COLUMN IF NOT EXISTS quiz_total integer;
  ALTER TABLE training_assignments ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
  CREATE TABLE IF NOT EXISTS training_completion_history (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    deck_id integer NOT NULL REFERENCES training_decks(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at timestamptz NOT NULL,
    completed_at timestamptz,
    confirmed_version integer,
    quiz_score integer,
    quiz_total integer,
    source text NOT NULL DEFAULT '',
    closed_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_training_history ON training_completion_history(deck_id, user_id);

  -- 0.81: console at scale + evidence retention. Deck tags for filtering,
  -- activity timestamp for stall detection, snooze for the attention queue —
  -- and the history table stops cascading away when a person or deck goes:
  -- FKs relax to SET NULL and rows carry name/title snapshots.
  ALTER TABLE training_decks ADD COLUMN IF NOT EXISTS tag text NOT NULL DEFAULT '';
  ALTER TABLE training_assignments ADD COLUMN IF NOT EXISTS progress_at timestamptz;
  ALTER TABLE training_assignments ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
  ALTER TABLE training_completion_history ADD COLUMN IF NOT EXISTS user_name text NOT NULL DEFAULT '';
  ALTER TABLE training_completion_history ADD COLUMN IF NOT EXISTS user_email text NOT NULL DEFAULT '';
  ALTER TABLE training_completion_history ADD COLUMN IF NOT EXISTS deck_title text NOT NULL DEFAULT '';
  ALTER TABLE training_completion_history ALTER COLUMN user_id DROP NOT NULL;
  ALTER TABLE training_completion_history ALTER COLUMN deck_id DROP NOT NULL;
  ALTER TABLE training_completion_history
    DROP CONSTRAINT IF EXISTS training_completion_history_user_id_fkey;
  ALTER TABLE training_completion_history
    ADD CONSTRAINT training_completion_history_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE training_completion_history
    DROP CONSTRAINT IF EXISTS training_completion_history_deck_id_fkey;
  ALTER TABLE training_completion_history
    ADD CONSTRAINT training_completion_history_deck_id_fkey
    FOREIGN KEY (deck_id) REFERENCES training_decks(id) ON DELETE SET NULL;
  UPDATE training_completion_history h
    SET user_name = COALESCE(u.name, h.user_name),
        user_email = COALESCE(u.email, h.user_email)
    FROM users u WHERE u.id = h.user_id AND h.user_name = '';
  UPDATE training_completion_history h
    SET deck_title = COALESCE(d.title, h.deck_title)
    FROM training_decks t JOIN documents d ON d.id = t.document_id
    WHERE t.id = h.deck_id AND h.deck_title = '';

  -- 0.82: auditor-grade evidence + team leads. E-signature completions record
  -- the typed name and a SHA-256 of the exact content confirmed; quiz answers
  -- persist per question for analytics; point-in-time snapshots store the
  -- canonical JSON text they were hashed over (text, not jsonb, so the hash
  -- stays verifiable byte-for-byte); group leads get a scoped team view.
  ALTER TABLE training_decks ADD COLUMN IF NOT EXISTS require_signature integer NOT NULL DEFAULT 0;
  ALTER TABLE training_assignments ADD COLUMN IF NOT EXISTS signed_name text;
  ALTER TABLE training_assignments ADD COLUMN IF NOT EXISTS content_sha256 text;
  ALTER TABLE training_assignments ADD COLUMN IF NOT EXISTS quiz_answers jsonb;
  ALTER TABLE training_completion_history ADD COLUMN IF NOT EXISTS signed_name text;
  ALTER TABLE training_completion_history ADD COLUMN IF NOT EXISTS content_sha256 text;
  ALTER TABLE training_completion_history ADD COLUMN IF NOT EXISTS quiz_answers jsonb;
  CREATE TABLE IF NOT EXISTS training_snapshots (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    taken_at timestamptz NOT NULL DEFAULT now(),
    kind text NOT NULL DEFAULT 'manual',
    period text NOT NULL DEFAULT '',
    taken_by text NOT NULL DEFAULT '',
    sha256 text NOT NULL,
    data text NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_training_snapshots_monthly
    ON training_snapshots(period) WHERE kind = 'monthly';
  CREATE TABLE IF NOT EXISTS group_leads (
    group_id integer NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );

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

  -- A second provider's attribute path, beside graph_path (0.96). Not a rename:
  -- graph_path is in the DirectorySettings API contract and the print-columns
  -- validator, and the two are structurally different anyway —
  -- onPremisesExtensionAttributes.extensionAttribute1 against
  -- customSchemas.HR.employee_id. One column each, one input each in the mapper.
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS google_path text NOT NULL DEFAULT '';

  -- --- Role-based access control (0.91) ------------------------------------
  --
  -- Three tables. Roles hold permissions; assignments bind a role to a subject
  -- (a user or a group) at a scope (workspace-wide, or one space).
  --
  -- Permission keys are stored as plain text and validated against the
  -- code-defined catalog in lib/permissions.ts on write. They are deliberately
  -- NOT a foreign key to a permissions table: the catalog ships with the code,
  -- so a downgrade must not fail on rows referencing a key it doesn't know —
  -- unknown keys are ignored on read, which fails closed.
  CREATE TABLE IF NOT EXISTS roles (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key text NOT NULL UNIQUE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    -- Built-in roles are seeded from PRESET_ROLES and cannot be deleted; their
    -- permission sets are reset to the catalog on every boot so an upgrade
    -- that adds a permission grants it without a migration.
    is_builtin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id integer NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission text NOT NULL,
    PRIMARY KEY (role_id, permission)
  );
  CREATE TABLE IF NOT EXISTS role_assignments (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id integer NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    -- Exactly one of user_id / group_id is set (enforced below).
    user_id integer REFERENCES users(id) ON DELETE CASCADE,
    group_id integer REFERENCES groups(id) ON DELETE CASCADE,
    -- 'global' applies everywhere; 'space' applies to space_id only.
    scope_type text NOT NULL DEFAULT 'global',
    space_id integer REFERENCES spaces(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT role_assignment_subject CHECK (
      (user_id IS NOT NULL AND group_id IS NULL) OR (user_id IS NULL AND group_id IS NOT NULL)
    ),
    CONSTRAINT role_assignment_scope CHECK (
      (scope_type = 'global' AND space_id IS NULL) OR
      (scope_type = 'space'  AND space_id IS NOT NULL)
    )
  );
  -- One assignment per (subject, role, scope). Partial uniques because NULLs
  -- don't compare equal, so a plain UNIQUE would let duplicates through.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ra_user_global
    ON role_assignments (user_id, role_id) WHERE user_id IS NOT NULL AND scope_type = 'global';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ra_user_space
    ON role_assignments (user_id, role_id, space_id) WHERE user_id IS NOT NULL AND scope_type = 'space';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ra_group_global
    ON role_assignments (group_id, role_id) WHERE group_id IS NOT NULL AND scope_type = 'global';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ra_group_space
    ON role_assignments (group_id, role_id, space_id) WHERE group_id IS NOT NULL AND scope_type = 'space';
  -- The hot path is "everything this user holds", resolved once per request.
  CREATE INDEX IF NOT EXISTS idx_ra_user ON role_assignments (user_id) WHERE user_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_ra_group ON role_assignments (group_id) WHERE group_id IS NOT NULL;

  -- Keep the legacy ladder and the new assignments in step, in the database
  -- rather than in application code.
  --
  -- users.role is written from several places — the admin API, SCIM
  -- provisioning, SSO just-in-time creation, the first-run bootstrap — and
  -- until 0.92 removes the ladder entirely, every one of them must also produce
  -- an assignment or the user silently has no permissions. Finding all those
  -- writers and remembering to patch each is exactly the kind of "did we get
  -- them all?" problem this rewrite exists to stop having, so the invariant
  -- lives next to the data instead.
  --
  -- Only the four LADDER rungs at global scope are touched. Custom roles,
  -- space-scoped grants, and the seeded delegated roles (Announcements
  -- manager, Newsletter approver, …) are never created or removed by this —
  -- they are built-in too, and an unqualified is_builtin test would have wiped
  -- someone's section delegation the moment an admin changed their role.
  CREATE OR REPLACE FUNCTION compass_sync_ladder_assignment() RETURNS trigger AS $fn$
  BEGIN
    DELETE FROM role_assignments ra
     USING roles r
     WHERE ra.role_id = r.id AND r.is_builtin
       AND r.key IN ('viewer','editor','approver','admin')
       AND ra.user_id = NEW.id AND ra.scope_type = 'global' AND r.key <> NEW.role;
    INSERT INTO role_assignments (role_id, user_id, scope_type)
    SELECT r.id, NEW.id, 'global' FROM roles r WHERE r.is_builtin AND r.key = NEW.role
    ON CONFLICT DO NOTHING;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;

  -- Shadow-mode observations for the 0.92 authorization port. Each row is a
  -- (route, permission, legacy answer, RBAC answer) combination with a counter,
  -- so the table stays small however much traffic flows through it. A row where
  -- the two answers differ is a porting bug, and the count of such rows is the
  -- gate on flipping enforcement over.
  CREATE TABLE IF NOT EXISTS authz_shadow (
    route text NOT NULL,
    permission text NOT NULL,
    legacy_allowed boolean NOT NULL,
    rbac_allowed boolean NOT NULL,
    hits bigint NOT NULL DEFAULT 0,
    first_seen timestamptz NOT NULL DEFAULT now(),
    last_seen timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (route, permission, legacy_allowed, rbac_allowed)
  );

  DROP TRIGGER IF EXISTS compass_users_ladder_sync ON users;
  CREATE TRIGGER compass_users_ladder_sync
    AFTER INSERT OR UPDATE OF role ON users
    FOR EACH ROW EXECUTE FUNCTION compass_sync_ladder_assignment();
`;

/**
 * One-time rename for the 0.14 visibility tiers: before 0.14, 'public' meant
 * "every signed-in user". That tier is now 'internal', and 'public' means
 * anonymous internet access — so existing rows must flip exactly once (never
 * again, or an admin's deliberate 'public' choice would be reverted on boot).
 */
/**
 * Rebuild documents.search with per-field weights (title A, summary/tags B,
 * body C). Generated columns can't be altered in place, so drop + re-add +
 * reindex — a one-time table rewrite, guarded by inspecting the current
 * generation expression rather than a flag (fresh installs are already
 * weighted and skip the rewrite).
 */
async function migrateWeightedSearch(client: import("pg").PoolClient) {
  const expr = await client.query(
    `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
     FROM pg_attrdef d
     JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE d.adrelid = 'documents'::regclass AND a.attname = 'search'`
  );
  if (!expr.rowCount || /setweight/.test(expr.rows[0].expr)) return;
  console.log("[db] rebuilding documents.search with field weights (one-time)…");
  await client.query(`
    ALTER TABLE documents DROP COLUMN search;
    ALTER TABLE documents ADD COLUMN search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
      setweight(to_tsvector('english', coalesce(summary,'')), 'B') ||
      setweight(to_tsvector('english', coalesce(replace(tags, ',', ' '), '')), 'B') ||
      setweight(to_tsvector('english', coalesce(content,'')), 'C')
    ) STORED;
    CREATE INDEX idx_documents_search ON documents USING gin(search);
  `);
}

/**
 * Reconcile the four built-in roles with the code catalog, every boot.
 *
 * Built-ins are owned by the code, not the database: an upgrade that adds a
 * permission to the Editor preset should grant it without anyone running a
 * migration. So their permission sets are replaced wholesale here. Custom
 * roles are never touched.
 *
 * Deliberately not `DELETE FROM role_permissions` + re-INSERT: that would leave
 * a window inside the transaction where a concurrent reader sees a role with no
 * permissions. Instead the delete is narrowed to keys that are no longer in the
 * preset, and inserts are ON CONFLICT DO NOTHING.
 */
async function syncPresetRoles(client: import("pg").PoolClient) {
  const { PRESET_ROLES, PRESET_ROLE_KEYS, DELEGATED_ROLES } = await import("./permissions");
  const seeded: Record<string, { label: string; description: string; permissions: readonly string[] }> = {
    ...Object.fromEntries(
      PRESET_ROLE_KEYS.map((k) => [k, PRESET_ROLES[k] as { label: string; description: string; permissions: readonly string[] }])
    ),
    ...DELEGATED_ROLES,
  };
  for (const key of Object.keys(seeded)) {
    const preset = seeded[key];
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO roles (key, name, description, is_builtin)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING id`,
      [key, preset.label, preset.description]
    );
    const roleId = rows[0].id;
    const want = preset.permissions as readonly string[];
    await client.query(
      "DELETE FROM role_permissions WHERE role_id = $1 AND permission <> ALL($2::text[])",
      [roleId, want]
    );
    await client.query(
      `INSERT INTO role_permissions (role_id, permission)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [roleId, want]
    );
  }
}

/**
 * Keep every user's ladder role represented as a real global assignment.
 *
 * Runs on every boot, not once. A trigger keeps the two in step for writes made
 * while the app is running, but a backfill costs one indexed anti-join when
 * there is nothing to do and means the system repairs itself after a restore
 * from an older dump, a manual UPDATE, or any future writer that bypasses the
 * trigger. For something that decides whether a user has any permissions at
 * all, self-healing beats a one-shot flag.
 */
async function migrateLadderToAssignments(client: import("pg").PoolClient) {
  const { rowCount } = await client.query(
    `INSERT INTO role_assignments (role_id, user_id, scope_type)
     SELECT r.id, u.id, 'global'
       FROM users u JOIN roles r ON r.key = u.role AND r.is_builtin
      WHERE NOT EXISTS (
        SELECT 1 FROM role_assignments ra
         WHERE ra.user_id = u.id AND ra.role_id = r.id AND ra.scope_type = 'global')
     ON CONFLICT DO NOTHING`
  );
  if (rowCount) console.log(`[rbac] backfilled ${rowCount} role assignment(s) from the ladder`);
}

/**
 * Move the two remaining parallel grant stores into role assignments (0.94).
 *
 * Section delegation lived as JSON in `settings` (`section_access_announcements`
 * and friends); the newsletter capability lived as a text column on `users`.
 * Both expressed "this person or group may do this set of things" — which is
 * an assignment — so both become assignments of the seeded roles.
 *
 * Runs once, guarded by a settings flag, because unlike the ladder backfill
 * this is not self-healing: re-running it after an admin has deliberately
 * revoked one of the migrated grants would put it back.
 *
 * The old data is left in place, untouched. It costs nothing, it is the only
 * record of what the previous state was, and a downgrade to 0.93 needs it.
 */
async function migrateDelegationToAssignments(client: import("pg").PoolClient) {
  const done = await client.query("SELECT 1 FROM settings WHERE key = 'migrated_delegation_rbac'");
  if (done.rowCount) return;

  const { SECTION_ROLES, NEWSLETTER_ROLES } = await import("./permissions");
  let moved = 0;

  const roleId = async (key: string): Promise<number | null> => {
    const { rows } = await client.query<{ id: number }>("SELECT id FROM roles WHERE key = $1", [key]);
    return rows[0]?.id ?? null;
  };

  for (const [key, def] of Object.entries(SECTION_ROLES)) {
    const id = await roleId(key);
    if (!id) continue;
    const { rows } = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = $1",
      [`section_access_${def.section}`]
    );
    if (!rows[0]?.value) continue;
    let parsed: { users?: unknown; groups?: unknown };
    try {
      parsed = JSON.parse(rows[0].value);
    } catch {
      continue; // unreadable grant: leave it alone rather than guess
    }
    const nums = (v: unknown) =>
      Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    for (const userId of nums(parsed.users)) {
      const r = await client.query(
        `INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')
         ON CONFLICT DO NOTHING`,
        [id, userId]
      );
      moved += r.rowCount ?? 0;
    }
    for (const groupId of nums(parsed.groups)) {
      const r = await client.query(
        `INSERT INTO role_assignments (role_id, group_id, scope_type) VALUES ($1, $2, 'global')
         ON CONFLICT DO NOTHING`,
        [id, groupId]
      );
      moved += r.rowCount ?? 0;
    }
  }

  for (const [key, def] of Object.entries(NEWSLETTER_ROLES)) {
    const id = await roleId(key);
    if (!id) continue;
    const r = await client.query(
      `INSERT INTO role_assignments (role_id, user_id, scope_type)
       SELECT $1, u.id, 'global' FROM users u WHERE u.newsletter_role = $2
       ON CONFLICT DO NOTHING`,
      [id, def.level]
    );
    moved += r.rowCount ?? 0;
  }

  await client.query(
    "INSERT INTO settings (key, value) VALUES ('migrated_delegation_rbac','1') ON CONFLICT (key) DO NOTHING"
  );
  console.log(`[rbac] migrated ${moved} delegated grant(s) into role assignments`);
}

/**
 * The three legacy per-space grant tables, and the statement that turns each
 * one into the equivalent role assignment. Shared by the 0.99 migration and by
 * the 1.0 drop, so the sweep before the drop cannot drift from the migration
 * it is double-checking.
 */
const LEGACY_SPACE_GRANT_COPIES: Record<string, string> = {
  space_groups: `INSERT INTO role_assignments (role_id, group_id, scope_type, space_id)
     SELECT r.id, sg.group_id, 'space', sg.space_id
       FROM space_groups sg CROSS JOIN roles r WHERE r.key = 'space-member'
     ON CONFLICT DO NOTHING`,
  space_editors: `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
     SELECT r.id, se.user_id, 'space', se.space_id
       FROM space_editors se CROSS JOIN roles r WHERE r.key = 'space-author'
     ON CONFLICT DO NOTHING`,
  space_editor_groups: `INSERT INTO role_assignments (role_id, group_id, scope_type, space_id)
     SELECT r.id, seg.group_id, 'space', seg.space_id
       FROM space_editor_groups seg CROSS JOIN roles r WHERE r.key = 'space-author'
     ON CONFLICT DO NOTHING`,
};

/** Which of the legacy tables still exist in this database? */
async function presentLegacyTables(client: import("pg").PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [Object.keys(LEGACY_SPACE_GRANT_COPIES)]
  );
  return new Set(rows.map((r) => r.table_name));
}

/**
 * Move per-space grants out of their three side tables and into role
 * assignments (0.99).
 *
 * `space_groups` said "members of this group can read this private space";
 * `space_editors` / `space_editor_groups` said "these people can author here".
 * A space-scoped assignment of the seeded `space-member` / `space-author` role
 * says exactly the same thing, and unlike the tables it shows up in the roles
 * console, the effective-permission explainer, and the audit trail.
 *
 * Insert-only and ON CONFLICT DO NOTHING throughout, so running it twice is a
 * no-op rather than a duplication. That is what lets dropLegacySpaceGrantTables
 * re-run the same copies as a final sweep in 1.0 before the tables go.
 */
async function migrateSpaceGrantsToAssignments(client: import("pg").PoolClient) {
  const done = await client.query("SELECT 1 FROM settings WHERE key = 'migrated_space_grants_rbac'");
  if (done.rowCount) return;

  // A fresh 1.0 install never had these tables; an upgrade from 0.98 still does.
  const have = await presentLegacyTables(client);

  const copy = async (sql: string, table: string) => {
    if (!have.has(table)) return 0;
    const r = await client.query(sql);
    return r.rowCount ?? 0;
  };

  let moved = 0;
  for (const [table, sql] of Object.entries(LEGACY_SPACE_GRANT_COPIES)) {
    moved += await copy(sql, table);
  }

  await client.query(
    "INSERT INTO settings (key, value) VALUES ('migrated_space_grants_rbac','1') ON CONFLICT (key) DO NOTHING"
  );
  console.log(`[rbac] migrated ${moved} per-space grant(s) into role assignments`);
}

/**
 * Drop the three legacy per-space grant tables (1.0).
 *
 * 0.99 copied their contents into role assignments and stopped reading them;
 * this removes them. Two things make that safe to do at boot:
 *
 *   - The copies run once more first, unconditionally. They are insert-only
 *     with ON CONFLICT DO NOTHING, so the sweep costs one indexed anti-join
 *     when there is nothing to move — and it means the drop is lossless by
 *     construction rather than by trusting that the 0.99 marker was written
 *     after a complete run. A tenant upgrading 0.98 -> 1.0 directly is
 *     migrated by the call above and swept by this one.
 *   - It refuses to drop anything if the seeded roles the grants were copied
 *     INTO are missing. Without them the sweep silently moves nothing, and
 *     dropping would discard live grants.
 *
 * This is the release's one-way door: a workspace that rolls back below 0.99
 * after booting 1.0 loses its per-space grants, because the tables they lived
 * in are gone. Called out in the changelog and the upgrade notes.
 */
async function dropLegacySpaceGrantTables(client: import("pg").PoolClient) {
  const have = await presentLegacyTables(client);
  if (have.size === 0) return;

  const { rows: roles } = await client.query<{ key: string }>(
    "SELECT key FROM roles WHERE key IN ('space-member','space-author')"
  );
  if (roles.length < 2) {
    console.error(
      "[rbac] refusing to drop the legacy space-grant tables: the space-member/space-author roles are missing, so the grants have nowhere to go"
    );
    return;
  }

  let swept = 0;
  for (const [table, sql] of Object.entries(LEGACY_SPACE_GRANT_COPIES)) {
    if (have.has(table)) swept += (await client.query(sql)).rowCount ?? 0;
  }
  if (swept) console.log(`[rbac] swept ${swept} straggling per-space grant(s) before the drop`);

  for (const table of have) await client.query(`DROP TABLE IF EXISTS ${table}`);
  console.log(`[rbac] dropped ${have.size} legacy per-space grant table(s)`);
}

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

// --- DMS links (iManage / NetDocuments / SharePoint deep links) -----------------

export interface DmsLink {
  id: number;
  document_id: number;
  system: string;
  title: string;
  url: string;
  added_by: string;
  created_at: string;
}

export async function listDmsLinks(documentId: number): Promise<DmsLink[]> {
  return q("SELECT * FROM doc_dms_links WHERE document_id = $1 ORDER BY created_at DESC", [
    documentId,
  ]);
}

export async function addDmsLink(input: {
  document_id: number;
  system: string;
  title: string;
  url: string;
  added_by: string;
}): Promise<DmsLink> {
  return (
    await q<DmsLink>(
      `INSERT INTO doc_dms_links (document_id, system, title, url, added_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        input.document_id,
        input.system,
        input.title.slice(0, 200),
        input.url.slice(0, 2000),
        input.added_by.slice(0, 100),
      ]
    )
  )[0];
}

/** Editing-presence heartbeat: upsert "this user has the editor open now". */
export async function touchEditingPresence(
  documentId: number,
  userId: number,
  userName: string
): Promise<void> {
  await q(
    `INSERT INTO doc_editing_presence (document_id, user_id, user_name, last_seen)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (document_id, user_id) DO UPDATE SET last_seen = now(), user_name = $3`,
    [documentId, userId, userName.slice(0, 100)]
  );
}

export async function clearEditingPresence(documentId: number, userId: number): Promise<void> {
  await q("DELETE FROM doc_editing_presence WHERE document_id = $1 AND user_id = $2", [
    documentId,
    userId,
  ]);
}

/** Others (not `userId`) editing this doc, heartbeat within the last 90s. */
export async function listOtherEditors(
  documentId: number,
  userId: number
): Promise<{ user_id: number; user_name: string }[]> {
  return q(
    `SELECT user_id, user_name FROM doc_editing_presence
     WHERE document_id = $1 AND user_id <> $2 AND last_seen > now() - interval '90 seconds'
     ORDER BY user_name`,
    [documentId, userId]
  );
}

/** Delete a link, but only from the given document (route-level ownership). */
export async function deleteDmsLink(
  documentId: number,
  id: number
): Promise<DmsLink | undefined> {
  return (
    await q<DmsLink>(
      "DELETE FROM doc_dms_links WHERE id = $1 AND document_id = $2 RETURNING *",
      [id, documentId]
    )
  )[0];
}

// --- SaaS status board ---------------------------------------------------------

import type { ServiceStatus } from "./status-parsers";
export type { ServiceStatus };

export interface StatusService {
  id: number;
  name: string;
  provider: string;
  source_url: string;
  status: ServiceStatus;
  status_detail: string;
  status_url: string;
  last_checked_at: string | null;
  last_changed_at: string | null;
  created_at: string;
}

export interface StatusIncident {
  id: number;
  service_id: number;
  title: string;
  severity: "outage" | "degraded" | "maintenance";
  state: "open" | "resolved";
  created_by: string;
  created_at: string;
  resolved_at: string | null;
  updates: { id: number; body: string; author: string; created_at: string }[];
}

export async function listStatusServices(): Promise<StatusService[]> {
  return q("SELECT * FROM status_services ORDER BY name");
}

export async function addStatusService(input: {
  name: string;
  provider: string;
  source_url: string;
}): Promise<StatusService> {
  // Internal (manual) systems are healthy until someone declares otherwise;
  // polled ones stay unknown until the first check lands.
  return (
    await q<StatusService>(
      `INSERT INTO status_services (name, provider, source_url, status)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [input.name, input.provider, input.source_url, input.provider === "manual" ? "operational" : "unknown"]
    )
  )[0];
}

export async function deleteStatusService(id: number): Promise<boolean> {
  const res = await pool().query("DELETE FROM status_services WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Atomically claim a service for polling. True at most once per interval
 * across instances — the UPDATE only wins if the row is stale. */
export async function claimStatusPoll(id: number, intervalMinutes: number): Promise<boolean> {
  const rows = await q(
    `UPDATE status_services SET last_checked_at = now()
     WHERE id = $1 AND (last_checked_at IS NULL
       OR last_checked_at < now() - make_interval(mins => $2))
     RETURNING id`,
    [id, intervalMinutes]
  );
  return rows.length > 0;
}

/** Record a poll result; returns the previous status for transition alerts. */
export async function setServiceStatus(
  id: number,
  next: { status: ServiceStatus; detail: string; url: string }
): Promise<ServiceStatus | undefined> {
  const rows = await q<{ prev: ServiceStatus }>(
    `UPDATE status_services s SET
       status = $2,
       status_detail = $3,
       status_url = $4,
       last_changed_at = CASE WHEN s.status <> $2 THEN now() ELSE s.last_changed_at END
     FROM (SELECT status AS prev FROM status_services WHERE id = $1) old
     WHERE s.id = $1
     RETURNING old.prev`,
    [id, next.status, next.detail.slice(0, 500), next.url.slice(0, 500)]
  );
  return rows[0]?.prev;
}

export async function createStatusIncident(input: {
  serviceId: number;
  title: string;
  severity: string;
  body: string;
  author: string;
}): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO status_incidents (service_id, title, severity, created_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.serviceId, input.title.slice(0, 200), input.severity, input.author]
  );
  if (input.body.trim()) {
    await q(
      "INSERT INTO status_incident_updates (incident_id, body, author) VALUES ($1,$2,$3)",
      [row.id, input.body.slice(0, 2000), input.author]
    );
  }
  return row.id;
}

export async function addStatusIncidentUpdate(
  incidentId: number,
  body: string,
  author: string
): Promise<boolean> {
  const rows = await q(
    `INSERT INTO status_incident_updates (incident_id, body, author)
     SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM status_incidents WHERE id = $1)
     RETURNING id`,
    [incidentId, body.slice(0, 2000), author]
  );
  return rows.length > 0;
}

export async function resolveStatusIncident(id: number, author: string): Promise<
  { service_id: number; title: string } | undefined
> {
  const rows = await q<{ service_id: number; title: string }>(
    `UPDATE status_incidents SET state = 'resolved', resolved_at = now()
     WHERE id = $1 AND state = 'open' RETURNING service_id, title`,
    [id]
  );
  if (rows[0]) {
    await q(
      "INSERT INTO status_incident_updates (incident_id, body, author) VALUES ($1,'Resolved.',$2)",
      [id, author]
    );
  }
  return rows[0];
}

export async function getStatusIncident(
  id: number
): Promise<{ id: number; service_id: number; title: string; state: string } | undefined> {
  return (
    await q("SELECT id, service_id, title, state FROM status_incidents WHERE id = $1", [id])
  )[0];
}

/** Incidents (open first, then recent resolved) with their update timelines. */
export async function listStatusIncidents(limit = 50): Promise<StatusIncident[]> {
  const incidents = await q<StatusIncident>(
    `SELECT * FROM status_incidents
     ORDER BY (state = 'open') DESC, created_at DESC LIMIT $1`,
    [limit]
  );
  if (incidents.length === 0) return [];
  const updates = await q<{ id: number; incident_id: number; body: string; author: string; created_at: string }>(
    `SELECT id, incident_id, body, author, created_at FROM status_incident_updates
     WHERE incident_id = ANY($1) ORDER BY created_at ASC`,
    [incidents.map((i) => i.id)]
  );
  const byIncident = new Map<number, StatusIncident["updates"]>();
  for (const u of updates) {
    const list = byIncident.get(u.incident_id) ?? [];
    list.push({ id: u.id, body: u.body, author: u.author, created_at: u.created_at });
    byIncident.set(u.incident_id, list);
  }
  return incidents.map((i) => ({ ...i, updates: byIncident.get(i.id) ?? [] }));
}

/** Everything currently wrong: non-operational tracked services + open incidents. */
export async function listStatusProblems(): Promise<
  { name: string; status: string; detail: string }[]
> {
  // Manual systems surface through their open incidents (below), not here —
  // listing both would double-count the same outage.
  const services = await q<{ name: string; status: string; status_detail: string }>(
    `SELECT name, status, status_detail FROM status_services
     WHERE status IN ('degraded','outage','maintenance') AND provider <> 'manual'
     ORDER BY name`
  );
  const incidents = await q<{ title: string; severity: string; name: string }>(
    `SELECT i.title, i.severity, s.name FROM status_incidents i
     JOIN status_services s ON s.id = i.service_id
     WHERE i.state = 'open' ORDER BY i.created_at DESC`
  );
  return [
    ...incidents.map((i) => ({ name: i.name, status: i.severity, detail: i.title })),
    ...services.map((s) => ({ name: s.name, status: s.status, detail: s.status_detail })),
  ];
}

/** Every active user id — status-change alerts fan out to the whole org. */
export async function listActiveUserIds(): Promise<number[]> {
  const rows = await q<{ id: number }>("SELECT id FROM users WHERE status = 'active'");
  return rows.map((r) => r.id);
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

export async function listSpaces(scope: SpaceScope): Promise<(Space & { doc_count: number })[]> {
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
  patch: {
    name?: string;
    description?: string;
    icon?: string;
    color?: string;
    visibility?: string;
    default_template_id?: number | null;
    default_view?: string;
  }
): Promise<Space | undefined> {
  if (patch.visibility !== undefined && !["public", "internal", "private"].includes(patch.visibility)) {
    delete patch.visibility;
  }
  if (
    patch.default_view !== undefined &&
    !["cards", "table", "tree", "board", "timeline", "tags"].includes(patch.default_view)
  ) {
    delete patch.default_view;
  }
  const sets: string[] = [];
  const vals: any[] = [];
  for (const key of ["name", "description", "icon", "color", "visibility", "default_template_id", "default_view"] as const) {
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
  scope: SpaceScope
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

/** Paged listing for the public REST API (space/status filters, newest first). */
export async function listDocumentsV1(opts: {
  scope: SpaceScope;
  spaceId?: number;
  status?: "published" | "draft";
  includeDrafts: boolean;
  limit: number;
  offset: number;
}): Promise<{ items: DocumentWithSpace[]; total: number }> {
  const conds = ["d.deleted_at IS NULL", "d.branch_of IS NULL"];
  const params: unknown[] = [];
  if (!opts.includeDrafts) conds.push("d.status = 'published'");
  else if (opts.status) {
    params.push(opts.status);
    conds.push(`d.status = $${params.length}`);
  }
  if (Array.isArray(opts.scope)) {
    params.push(opts.scope);
    conds.push(`d.space_id = ANY($${params.length})`);
  }
  if (opts.spaceId) {
    params.push(opts.spaceId);
    conds.push(`d.space_id = $${params.length}`);
  }
  const where = conds.join(" AND ");
  const total = (
    await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM documents d WHERE ${where}`, params)
  )[0].n;
  params.push(opts.limit, opts.offset);
  const rows = await q(
    `${DOC_SELECT} WHERE ${where} ORDER BY d.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows.map(mapDoc), total };
}

export async function listRecentDocuments(
  limit = 8,
  includeDrafts = false,
  scope: SpaceScope
): Promise<DocumentWithSpace[]> {
  const filter = includeDrafts ? "" : " AND d.status = 'published'";
  const scoped = Array.isArray(scope) ? " AND d.space_id = ANY($2)" : "";
  const rows = await q(
    `${DOC_SELECT} WHERE d.deleted_at IS NULL AND d.branch_of IS NULL${filter}${scoped} ORDER BY d.updated_at DESC LIMIT $1`,
    Array.isArray(scope) ? [limit, scope] : [limit]
  );
  return rows.map(mapDoc);
}

/**
 * Documents this user opened most recently (deduped, newest view first) —
 * the "pick up where you left off" list on the dashboard. Draft docs are
 * included only when the caller says so (editors see their drafts; a viewer
 * who once opened a doc that later became a draft shouldn't).
 */
export async function listRecentlyViewedBy(
  userId: number,
  scope: SpaceScope,
  includeDrafts = false,
  limit = 6
): Promise<DocumentWithSpace[]> {
  const filter = includeDrafts ? "" : " AND d.status = 'published'";
  const scoped = Array.isArray(scope) ? " AND d.space_id = ANY($3)" : "";
  const rows = await q(
    `SELECT dd.*, s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon,
            s.color AS space_color, s.visibility AS space_visibility
     FROM (
       SELECT d.*, MAX(v.viewed_at) AS last_viewed_at
       FROM doc_views v
       JOIN documents d ON d.id = v.document_id
       WHERE v.user_id = $1 AND d.deleted_at IS NULL AND d.branch_of IS NULL${filter}${scoped}
       GROUP BY d.id
       ORDER BY MAX(v.viewed_at) DESC
       LIMIT $2
     ) dd JOIN spaces s ON s.id = dd.space_id
     ORDER BY dd.last_viewed_at DESC`,
    Array.isArray(scope) ? [userId, limit, scope] : [userId, limit]
  );
  return rows.map(mapDoc);
}

/** This author's unpublished drafts, newest first (dashboard "your drafts"). */
export async function listDraftsByAuthor(
  author: string,
  scope: SpaceScope,
  limit = 4
): Promise<DocumentWithSpace[]> {
  const scoped = Array.isArray(scope) ? " AND d.space_id = ANY($3)" : "";
  const rows = await q(
    `${DOC_SELECT} WHERE d.deleted_at IS NULL AND d.branch_of IS NULL
       AND d.status = 'draft' AND d.author = $1${scoped}
     ORDER BY d.updated_at DESC LIMIT $2`,
    Array.isArray(scope) ? [author, limit, scope] : [author, limit]
  );
  return rows.map(mapDoc);
}

export async function countDocuments(
  includeDrafts = false,
  scope: SpaceScope
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

/** Per-user appearance / locale preferences; only provided keys change. */
export async function setUserPrefs(
  userId: number,
  prefs: { theme?: string; timezone?: string; date_format?: string }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of ["theme", "timezone", "date_format"] as const) {
    if (prefs[key] !== undefined) {
      vals.push(prefs[key]);
      sets.push(`${key} = $${vals.length}`);
    }
  }
  if (sets.length === 0) return;
  vals.push(userId);
  await q(`UPDATE users SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

/** Self-service profile edit (local accounts): display name and email. */
export async function setUserProfile(
  userId: number,
  profile: { name: string; email: string }
): Promise<void> {
  await q("UPDATE users SET name = $1, email = $2 WHERE id = $3", [
    profile.name,
    profile.email,
    userId,
  ]);
}

/** Avatar as a small data: URL; empty string removes it. */
export async function setUserAvatar(userId: number, avatar: string): Promise<void> {
  await q("UPDATE users SET avatar = $1 WHERE id = $2", [avatar, userId]);
}

/** Per-event notification routing map (kind -> {inapp?, webhook?, email?}). */
export async function setNotifyPrefs(userId: number, prefs: object): Promise<void> {
  await q("UPDATE users SET notify_prefs = $1 WHERE id = $2", [JSON.stringify(prefs), userId]);
}

/** notify_prefs for a set of users in one query (notification fan-out). */
export async function getNotifyPrefsFor(
  ids: number[]
): Promise<Map<number, Record<string, Record<string, boolean>>>> {
  const map = new Map<number, Record<string, Record<string, boolean>>>();
  if (ids.length === 0) return map;
  const rows = await q<{ id: number; notify_prefs: Record<string, Record<string, boolean>> }>(
    "SELECT id, notify_prefs FROM users WHERE id = ANY($1)",
    [ids]
  );
  for (const r of rows) map.set(r.id, r.notify_prefs ?? {});
  return map;
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
  void import("./backlinks").then((m) => m.syncDocLinks(id)).catch(() => {});
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

  // Nested pages can't span spaces: moving a doc detaches it from its parent
  // and promotes its children to top level (in their own space).
  if (next.space_id !== existing.space_id) {
    await q("UPDATE documents SET parent_id = NULL WHERE id = $1 OR parent_id = $1", [id]);
  }

  // A real content edit refreshes the review clock — the doc was just
  // touched, so its next review is a full interval away again.
  if (next.content !== existing.content) {
    await q(
      `UPDATE documents
       SET review_due_at = now() + make_interval(days => review_interval_days),
           review_reminded_at = NULL
       WHERE id = $1 AND review_interval_days IS NOT NULL`,
      [id]
    );
  }

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
    void import("./backlinks").then((m) => m.syncDocLinks(id)).catch(() => {});
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

/**
 * Hourly housekeeping (driven from instrumentation.ts): drop rows that can
 * never be read again so hot tables don't grow without bound. Expired sessions
 * are dead weight after the idle timeout; expired OAuth codes were only ever
 * valid for minutes. OAuth *tokens* are intentionally untouched — their
 * refresh halves outlive access_expires_at.
 */
export async function runDbMaintenance(): Promise<{ sessions: number; oauthCodes: number }> {
  await ready();
  const sessions = await pool().query("DELETE FROM sessions WHERE expires_at < now()");
  const codes = await pool().query("DELETE FROM oauth_codes WHERE expires_at < now()");
  // Read notifications older than 90 days are noise nobody revisits.
  await pool().query(
    "DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - interval '90 days'"
  );
  // Editing-presence heartbeats go stale within seconds of a closed tab.
  await pool().query(
    "DELETE FROM doc_editing_presence WHERE last_seen < now() - interval '10 minutes'"
  );
  return { sessions: sessions.rowCount ?? 0, oauthCodes: codes.rowCount ?? 0 };
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

export interface SearchSqlFilters {
  space?: string; // slug or name, case-insensitive
  type?: string;
  tag?: string;
  author?: string;
  status?: "draft" | "published";
}

/** Operator-only search (no words): newest matching docs, summary as snippet. */
async function browseDocuments(
  limit: number,
  includeDrafts: boolean,
  scope: number[] | "all" | undefined,
  spaceId: number | undefined,
  f: SearchSqlFilters
): Promise<SearchHit[]> {
  const params: unknown[] = [limit];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  let filter =
    (includeDrafts ? "" : " AND d.status = 'published'") +
    (Array.isArray(scope) ? ` AND d.space_id = ANY(${p(scope)})` : "") +
    (spaceId ? ` AND d.space_id = ${Number(spaceId)}` : "");
  if (f.space) filter += ` AND (s.slug = lower(${p(f.space)}) OR lower(s.name) = lower(${p(f.space)}))`;
  if (f.type) filter += ` AND d.type = ${p(f.type)}`;
  if (f.tag) filter += ` AND (',' || lower(d.tags) || ',') LIKE ${p(`%,${f.tag.toLowerCase()},%`)}`;
  if (f.author) filter += ` AND d.author ILIKE ${p(`%${f.author}%`)}`;
  if (f.status && includeDrafts) filter += ` AND d.status = ${p(f.status)}`;
  const rows = await q(
    `SELECT d.id, d.title, d.slug, d.type, d.status, d.tags, d.updated_at,
            s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon, s.color AS space_color,
            left(d.summary, 160) AS snippet
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     WHERE d.deleted_at IS NULL AND d.branch_of IS NULL${filter}
     ORDER BY d.updated_at DESC
     LIMIT $1`,
    params
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

export async function searchDocuments(
  raw: string,
  limit = 25,
  includeDrafts = false,
  scope: SpaceScope,
  /** Restrict hits to one space (the in-space search box). */
  spaceId?: number,
  /** Parsed `type:`/`tag:`/… operators from the query. */
  f?: SearchSqlFilters
): Promise<SearchHit[]> {
  // Filter-only queries ("type:sop" with no words) browse by recency instead.
  if (!raw.trim()) {
    if (!f || Object.keys(f).length === 0) return [];
    return browseDocuments(limit, includeDrafts, scope, spaceId, f);
  }
  const params: unknown[] = [raw, limit];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  let filter =
    (includeDrafts ? "" : " AND d.status = 'published'") +
    (Array.isArray(scope) ? ` AND d.space_id = ANY(${p(scope)})` : "") +
    (spaceId ? ` AND d.space_id = ${Number(spaceId)}` : "");
  if (f?.space) filter += ` AND (s.slug = lower(${p(f.space)}) OR lower(s.name) = lower(${p(f.space)}))`;
  if (f?.type) filter += ` AND d.type = ${p(f.type)}`;
  if (f?.tag) filter += ` AND (',' || lower(d.tags) || ',') LIKE ${p(`%,${f.tag.toLowerCase()},%`)}`;
  if (f?.author) filter += ` AND d.author ILIKE ${p(`%${f.author}%`)}`;
  if (f?.status && includeDrafts) filter += ` AND d.status = ${p(f.status)}`;
  // Rank = weighted full-text score (normalized to 0..1 with flag 32) plus a
  // bonus when the query appears verbatim in the title, scaled by a gentle
  // freshness factor so recently-updated docs win ties against stale ones.
  const titleParam = p(raw);
  const rows = await q(
    `SELECT d.id, d.title, d.slug, d.type, d.status, d.tags, d.updated_at,
            s.name AS space_name, s.slug AS space_slug, s.icon AS space_icon, s.color AS space_color,
            ts_headline('english', d.summary || ' ' || d.content, tq.query,
              'StartSel=<mark>, StopSel=</mark>, MaxWords=22, MinWords=8, ShortWord=2, MaxFragments=1') AS snippet
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     CROSS JOIN LATERAL (SELECT ${OR_TSQUERY} AS query) tq
     WHERE d.search @@ tq.query AND d.deleted_at IS NULL AND d.branch_of IS NULL${filter}
     ORDER BY
       (ts_rank(d.search, tq.query, 32)
         + CASE WHEN d.title ILIKE '%' || ${titleParam} || '%' THEN 0.2 ELSE 0 END)
       * (1 + 0.3 * exp(-GREATEST(extract(epoch FROM now() - d.updated_at), 0) / (86400.0 * 180)))
       DESC
     LIMIT $2`,
    params
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
  scope: SpaceScope
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
  "chat_slack_signing_secret",
  "chat_teams_hmac_secret",
  "ai_openai_api_key",
  // Microsoft Graph directory-sync app secret — an Entra client secret; must be
  // sealed like sso_client_secret. Existing plaintext rows auto-seal on next
  // boot via migrateSecuritySealing().
  "directory_graph_client_secret",
  // Google Workspace service-account key (the whole JSON, including its
  // private_key). Sealed for the same reason and auto-sealed on next boot.
  "directory_google_service_account",
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
  notify_webhook_url, page_width, newsletter_role, theme, timezone, date_format,
  avatar, notify_prefs, created_at, last_login_at`;

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
  // New members inherit any auto-assign training decks (best effort —
  // a failure here must never block account creation).
  await autoAssignTraining(r[0].id).catch(() => {});
  return (await getUserById(r[0].id))!;
}

/**
 * Lookup by external id across every provider.
 *
 * Case-INSENSITIVE, which the comment here used to claim while the query did a
 * plain equality. Entra sends lowercase GUIDs and Google sends digits, so the
 * gap never bit — but a comment promising a behaviour the code doesn't have is
 * a trap for the next person, and adding a second provider is exactly when
 * someone would rely on it. Fixed rather than re-documented (0.96).
 *
 * `provider` scopes the search. SCIM's uniqueness check must pass its
 * configured vendor: once two directories can write `external_id`, "is this id
 * taken anywhere?" is the wrong question — a Google id colliding with an Entra
 * id would refuse a legitimate account. Omitting it keeps the old cross-provider
 * behaviour for callers that genuinely want it.
 */
export async function getUserByAnyExternalId(
  externalId: string,
  provider?: string
): Promise<User | undefined> {
  return (
    await q<User>(
      `SELECT ${USER_COLUMNS} FROM users
        WHERE lower(external_id) = lower($1)
          AND ($2::text IS NULL OR auth_provider = $2)
        ORDER BY id LIMIT 1`,
      [externalId, provider ?? null]
    )
  )[0];
}

/** Provision a user from a SCIM push. No password — sign-in is via SSO. */
export async function scimCreateUser(input: {
  username: string;
  name: string;
  email: string;
  externalId: string | null;
  active: boolean;
  /**
   * Which directory pushed this user. Defaults to 'oidc' — a protocol rather
   * than a provider, which is what this column held before 0.96 and why an
   * Entra-provisioned user and a Google-signed-in user could land on the same
   * value and cross-match in getUserByExternalId(). New installs should pass
   * the configured vendor; the default keeps existing rows meaningful.
   */
  authProvider?: string;
}): Promise<User> {
  const r = await q<{ id: number }>(
    `INSERT INTO users (username, email, name, role, status, auth_provider, external_id)
     VALUES ($1,$2,$3,'viewer',$4,$6,$5) RETURNING id`,
    [
      input.username,
      input.email,
      input.name,
      input.active ? "active" : "disabled",
      input.externalId,
      input.authProvider ?? "oidc",
    ]
  );
  // New members inherit any auto-assign training decks (best effort —
  // a failure here must never block account creation).
  await autoAssignTraining(r[0].id).catch(() => {});
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
  // New members inherit any auto-assign training decks (best effort —
  // a failure here must never block account creation).
  await autoAssignTraining(r[0].id).catch(() => {});
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
  // Completed training is compliance evidence — archive it (with snapshots)
  // before the user row and its assignments cascade away.
  await q(
    `INSERT INTO training_completion_history
       (deck_id, user_id, assigned_at, completed_at, confirmed_version, quiz_score, quiz_total,
        source, user_name, user_email, deck_title, signed_name, content_sha256, quiz_answers)
     SELECT a.deck_id, a.user_id, a.assigned_at, a.completed_at, a.confirmed_version,
            a.quiz_score, a.quiz_total, a.source, u.name, u.email, d.title,
            a.signed_name, a.content_sha256, a.quiz_answers
     FROM training_assignments a
     JOIN users u ON u.id = a.user_id
     JOIN training_decks t ON t.id = a.deck_id
     JOIN documents d ON d.id = t.document_id
     WHERE a.user_id = $1 AND a.completed_at IS NOT NULL`,
    [id]
  ).catch(() => {});
  const res = await pool().query("DELETE FROM users WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

// countAdmins() lived here until 1.0. Its callers — the demote/disable/delete
// lockout guards — now ask countGlobalUserAdmins, which counts who still holds
// the recovery permission rather than who has an 'admin' row. Removed rather
// than deprecated: a function that answers "how many admins" with a role count
// is exactly the thing the next lockout guard would reach for.

// --- Personal API tokens (Claude connector / integrations) --------------------

export interface ApiToken {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
}

export const API_TOKEN_SCOPES = ["read", "write"] as const;

function hashApiToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Mint a token for a user. The raw value is returned ONCE and never stored. */
export async function createApiToken(
  userId: number,
  name: string,
  scopes: string[] = ["read", "write"]
): Promise<{ token: string; record: ApiToken }> {
  const clean = [...new Set(scopes.filter((s) => (API_TOKEN_SCOPES as readonly string[]).includes(s)))];
  const finalScopes = clean.length ? clean : ["read"];
  const raw = "cdk_" + randomBytes(24).toString("base64url");
  const prefix = raw.slice(0, 12) + "…";
  const r = await q<{ id: number; created_at: string }>(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, scopes)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [userId, name.trim().slice(0, 60) || "token", hashApiToken(raw), prefix, JSON.stringify(finalScopes)]
  );
  return {
    token: raw,
    record: {
      id: r[0].id,
      name,
      prefix,
      scopes: finalScopes,
      created_at: r[0].created_at,
      last_used_at: null,
    },
  };
}

export async function listApiTokens(userId: number): Promise<ApiToken[]> {
  return q(
    `SELECT id, name, prefix, scopes, created_at, last_used_at FROM api_tokens
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
export async function getUserByApiToken(
  raw: string
): Promise<(User & { token_scopes: string[] }) | undefined> {
  if (!raw.startsWith("cdk_")) return undefined;
  const rows = await q<User & { token_id: number; token_scopes: string[] }>(
    `SELECT ${USER_COLUMNS
      .split(",")
      .map((c) => "u." + c.trim())
      .join(", ")}, t.id AS token_id, t.scopes AS token_scopes
     FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND u.status = 'active'`,
    [hashApiToken(raw)]
  );
  const hit = rows[0];
  if (!hit) return undefined;
  // Fire-and-forget freshness stamp; not worth failing the request over.
  q("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [hit.token_id]).catch(() => {});
  const { token_id: _ignored, ...user } = hit;
  return user as User & { token_scopes: string[] };
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
      (SELECT COUNT(*) FROM (${GRANT_SUBJECTS("space.member")}) sub
        WHERE sub.group_id = g.id)::int AS space_count
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

// --- Per-space grants ------------------------------------------------------------
//
// Space membership and per-space edit rights are role assignments at space
// scope (0.99). They used to be rows in `space_groups`, `space_editors` and
// `space_editor_groups`; those tables are migrated once at boot and then never
// read again. See migrateSpaceGrantsToAssignments for why they still exist.
//
// Everything below goes through these two fragments rather than hand-rolling
// the join, because the join is the part that is easy to get subtly wrong: a
// grant reaches a user either directly or through any group they belong to,
// and it only counts when scoped to the space in question.

/** Subjects holding `permission` on a space, as a subquery over role_assignments. */
const GRANT_SUBJECTS = (permission: string) => `
  SELECT ra.space_id, ra.user_id, ra.group_id
    FROM role_assignments ra
    JOIN role_permissions rp ON rp.role_id = ra.role_id AND rp.permission = '${permission}'
   WHERE ra.scope_type = 'space' AND ra.space_id IS NOT NULL`;

/**
 * SQL predicate: does the user in column `userCol` hold `permission` on the
 * space in column `spaceCol`? Both arguments are column references written by
 * this module — never user input.
 */
const HOLDS_ON_SPACE = (permission: string, spaceCol: string, userCol: string) => `
  EXISTS (
    SELECT 1 FROM (${GRANT_SUBJECTS(permission)}) g
     WHERE g.space_id = ${spaceCol}
       AND (g.user_id = ${userCol}
            OR g.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = ${userCol}))
  )`;

/**
 * SQL predicate: does the user in column `userCol` hold `permission` globally?
 *
 * The counterpart to HOLDS_ON_SPACE, and the SQL half of the 1.0 port. These
 * queries pick an audience rather than gate a request — who is notified, who is
 * expected to acknowledge a policy, who may be reached for review — and every
 * one of them spelled the admin bypass `u.role = 'admin'`. That is the last
 * place the ladder decided anything: a custom role holding `space.read_all`
 * could open a private space in the app and still be left out of its
 * notifications, and no permission check anywhere would show it.
 */
const HOLDS_GLOBALLY = (permission: string, userCol: string) => `
  EXISTS (
    SELECT 1 FROM role_assignments ra
      JOIN role_permissions rp ON rp.role_id = ra.role_id AND rp.permission = '${permission}'
     WHERE ra.scope_type = 'global'
       AND (ra.user_id = ${userCol}
            OR ra.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = ${userCol}))
  )`;

/**
 * The spaces a user may read, as a subquery. `userParam` is a placeholder this
 * module or its caller controls (`$1`, `u.id`, …) — never user input.
 *
 * Exported because the weekly digest needs the same set inline, and a second
 * hand-written copy of this join is how the digest and the app end up
 * disagreeing about who can see a private space.
 *
 * The `space.read_all` arm is 1.0: spaceScopeFor has always had it, this had
 * not, so someone who could see every private space in the app got a digest
 * covering only the public ones.
 */
export function readableSpaceIdsSql(userParam: string): string {
  return `SELECT s.id FROM spaces s WHERE s.visibility IN ('public', 'internal')
          UNION
          SELECT s.id FROM spaces s WHERE ${HOLDS_GLOBALLY("space.read_all", userParam)}
          UNION
          SELECT g.space_id FROM (${GRANT_SUBJECTS("space.member")}) g
           WHERE g.user_id = ${userParam}
              OR g.group_id IN (SELECT gm.group_id FROM group_members gm
                                 WHERE gm.user_id = ${userParam})`;
}

/** space_id → granted group ids, for the whole workspace (admin UI). */
export async function listAllSpaceGroups(): Promise<Record<number, number[]>> {
  const rows = await q<{ space_id: number; group_id: number }>(
    `SELECT g.space_id, g.group_id FROM (${GRANT_SUBJECTS("space.member")}) g
      WHERE g.group_id IS NOT NULL ORDER BY g.space_id`
  );
  const map: Record<number, number[]> = {};
  for (const r of rows) (map[r.space_id] ??= []).push(r.group_id);
  return map;
}

export async function getSpaceGroupIds(spaceId: number): Promise<number[]> {
  return (
    await q<{ group_id: number }>(
      `SELECT g.group_id FROM (${GRANT_SUBJECTS("space.member")}) g
        WHERE g.space_id = $1 AND g.group_id IS NOT NULL`,
      [spaceId]
    )
  ).map((r) => r.group_id);
}

/**
 * Replace a space's granted groups.
 *
 * Scoped to *group* assignments of the seeded role: a user granted membership
 * directly, or a group granted it through a custom role, is not this screen's
 * to remove. The old table could not express either, so "delete every row for
 * this space" was safe there and would be a silent revocation here.
 */
export async function setSpaceGroups(spaceId: number, groupIds: number[]): Promise<void> {
  await setSpaceRoleGroups(spaceId, groupIds, "space-member");
}

/** Replace the space-scoped group assignments of one seeded role. */
async function setSpaceRoleGroups(spaceId: number, groupIds: number[], roleKey: string) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM role_assignments ra USING roles r
        WHERE ra.role_id = r.id AND r.key = $2
          AND ra.scope_type = 'space' AND ra.space_id = $1 AND ra.group_id IS NOT NULL`,
      [spaceId, roleKey]
    );
    for (const gid of groupIds) {
      await client.query(
        `INSERT INTO role_assignments (role_id, group_id, scope_type, space_id)
         SELECT r.id, $2, 'space', $1 FROM roles r WHERE r.key = $3
         ON CONFLICT DO NOTHING`,
        [spaceId, gid, roleKey]
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

/** Replace the space-scoped user assignments of one seeded role. */
async function setSpaceRoleUsers(spaceId: number, userIds: number[], roleKey: string) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM role_assignments ra USING roles r
        WHERE ra.role_id = r.id AND r.key = $2
          AND ra.scope_type = 'space' AND ra.space_id = $1 AND ra.user_id IS NOT NULL`,
      [spaceId, roleKey]
    );
    for (const uid of userIds) {
      await client.query(
        `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
         SELECT r.id, $2, 'space', $1 FROM roles r WHERE r.key = $3
         ON CONFLICT DO NOTHING`,
        [spaceId, uid, roleKey]
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
    await q<{ user_id: number }>(
      `SELECT g.user_id FROM (${GRANT_SUBJECTS("space.author")}) g
        WHERE g.space_id = $1 AND g.user_id IS NOT NULL`,
      [spaceId]
    )
  ).map((r) => r.user_id);
}

export async function getSpaceEditorGroupIds(spaceId: number): Promise<number[]> {
  return (
    await q<{ group_id: number }>(
      `SELECT g.group_id FROM (${GRANT_SUBJECTS("space.author")}) g
        WHERE g.space_id = $1 AND g.group_id IS NOT NULL`,
      [spaceId]
    )
  ).map((r) => r.group_id);
}

export async function setSpaceEditors(spaceId: number, userIds: number[]): Promise<void> {
  await setSpaceRoleUsers(spaceId, userIds, "space-author");
}

export async function setSpaceEditorGroups(spaceId: number, groupIds: number[]): Promise<void> {
  await setSpaceRoleGroups(spaceId, groupIds, "space-author");
}

/** All edit grants at once, for the admin spaces screen. */
export async function listAllSpaceEditorGrants(): Promise<{
  users: Record<number, number[]>;
  groups: Record<number, number[]>;
}> {
  const [u, g] = await Promise.all([
    q<{ space_id: number; user_id: number }>(
      `SELECT g.space_id, g.user_id FROM (${GRANT_SUBJECTS("space.author")}) g
        WHERE g.user_id IS NOT NULL`
    ),
    q<{ space_id: number; group_id: number }>(
      `SELECT g.space_id, g.group_id FROM (${GRANT_SUBJECTS("space.author")}) g
        WHERE g.group_id IS NOT NULL`
    ),
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
 *
 * The "no grants at all means anyone" arm is deliberately preserved from the
 * `space_editors` era (0.99). It reads oddly against role assignments, where
 * absence of a grant normally means no access — and it carries a real edge:
 * removing a space's last editor does not lock the space down, it re-opens it
 * to every editor. That is how per-space rights have behaved since 0.23, and
 * changing it is a policy decision, not a side effect of moving where the rows
 * live. Note it only bites at all when the org-level `editors_edit_all` switch
 * is off; with the default on, callers never reach here.
 */
export async function spaceEditGrantAllows(spaceId: number, userId: number): Promise<boolean> {
  const rows = await q<{ ok: boolean }>(
    `SELECT (
       NOT EXISTS (SELECT 1 FROM (${GRANT_SUBJECTS("space.author")}) g WHERE g.space_id = $1)
       OR ${HOLDS_ON_SPACE("space.author", "$1", "$2")}
     ) AS ok`,
    [spaceId, userId]
  );
  return rows[0]?.ok ?? false;
}

/** Space ids the user may author in under per-space rules (unrestricted ∪ granted). */
export async function editGrantedSpaceIdsFor(userId: number): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `SELECT s.id FROM spaces s
      WHERE NOT EXISTS (SELECT 1 FROM (${GRANT_SUBJECTS("space.author")}) g WHERE g.space_id = s.id)
     UNION
     SELECT g.space_id FROM (${GRANT_SUBJECTS("space.author")}) g
      WHERE g.user_id = $1
         OR g.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = $1)`,
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
    readableSpaceIdsSql("$1"),
    [userId]
  );
  return rows.map((r) => r.id);
}

/**
 * Spaces exposed on the anonymous public site (visibility 'public').
 *
 * This is the scope resolver for the anonymous principal — the counterpart to
 * spaceScopeFor() for someone with no account — so it returns a real
 * SpaceScope rather than a bare id list that a caller would have to brand.
 */
export async function publicSpaceScope(): Promise<SpaceScope> {
  const rows = await q<{ id: number }>("SELECT id FROM spaces WHERE visibility = 'public'");
  return asScope(rows.map((r) => r.id));
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

export async function setNotifyWebhookUrl(userId: number, url: string): Promise<void> {
  await q("UPDATE users SET notify_webhook_url = $1 WHERE id = $2", [url, userId]);
}

// --- Notification inbox (the bell) -----------------------------------------

export interface Notification {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  actor_name: string;
  created_at: string;
  read_at: string | null;
}

/** Bulk-insert one notification row per recipient. */
export async function insertNotifications(
  userIds: number[],
  n: { kind: string; title: string; body?: string; link?: string; actor_name?: string }
): Promise<void> {
  if (userIds.length === 0) return;
  await q(
    `INSERT INTO notifications (user_id, kind, title, body, link, actor_name)
     SELECT uid, $2, $3, $4, $5, $6 FROM unnest($1::int[]) AS uid`,
    [userIds, n.kind, n.title.slice(0, 300), (n.body || "").slice(0, 1000), n.link || "", n.actor_name || ""]
  );
}

export async function listNotificationsFor(userId: number, limit = 30): Promise<Notification[]> {
  return q(
    `SELECT id, kind, title, body, link, actor_name, created_at, read_at
     FROM notifications WHERE user_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [userId, limit]
  );
}

export async function unreadNotificationCount(userId: number): Promise<number> {
  return (
    await q<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL",
      [userId]
    )
  )[0].n;
}

/** Mark one of the user's notifications read; no-op on others' rows. */
export async function markNotificationRead(userId: number, id: number): Promise<void> {
  await q(
    "UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL",
    [id, userId]
  );
}

export async function markAllNotificationsRead(userId: number): Promise<void> {
  await q("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [
    userId,
  ]);
}

/**
 * Space subscribers as bare user ids — same audience as
 * listSubscriberRecipients minus the email-specific filters (the in-app
 * inbox doesn't care about email_notifications or a missing address).
 */
export async function listSubscriberIds(
  spaceId: number,
  excludeUserId: number
): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `SELECT u.id FROM users u
     JOIN spaces s ON s.id = $1
     WHERE u.status = 'active' AND u.id <> $2
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
         OR ${HOLDS_GLOBALLY("space.read_all", "u.id")}
         OR ${HOLDS_ON_SPACE("space.member", "$1", "u.id")}
       )`,
    [spaceId, excludeUserId]
  );
  return rows.map((r) => r.id);
}

/** Everyone (besides the author) who commented on a doc — reply audience. */
export async function listCommenterIds(docId: number, excludeUserId: number): Promise<number[]> {
  const rows = await q<{ user_id: number }>(
    `SELECT DISTINCT c.user_id FROM doc_comments c
     JOIN users u ON u.id = c.user_id AND u.status = 'active'
     WHERE c.document_id = $1 AND c.deleted_at IS NULL AND c.user_id <> $2`,
    [docId, excludeUserId]
  );
  return rows.map((r) => r.user_id);
}

/**
 * Active people who may review changes in the given space AND can see it.
 *
 * Both halves were role rungs until 1.0: `role IN ('approver','admin')` and
 * `role = 'admin'`. Reviewing is now a permission, and it can be held on one
 * space — so a space-scoped reviewer is finally in the audience for the space
 * they actually review.
 */
export async function listApproverIdsForSpace(
  spaceId: number,
  excludeUserId: number
): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `SELECT u.id FROM users u
     JOIN spaces s ON s.id = $1
     WHERE u.status = 'active' AND u.id <> $2
       AND (
         ${HOLDS_GLOBALLY("change_request.read", "u.id")}
         OR ${HOLDS_ON_SPACE("change_request.read", "s.id", "u.id")}
       )
       AND (
         ${HOLDS_GLOBALLY("space.read_all", "u.id")}
         OR s.visibility <> 'private'
         OR ${HOLDS_ON_SPACE("space.member", "s.id", "u.id")}
       )`,
    [spaceId, excludeUserId]
  );
  return rows.map((r) => r.id);
}

export async function setWeeklyDigest(userId: number, on: boolean): Promise<void> {
  await q("UPDATE users SET weekly_digest = $1 WHERE id = $2", [on ? 1 : 0, userId]);
}

export async function getWeeklyDigest(userId: number): Promise<boolean> {
  const r = await q<{ weekly_digest: number }>(
    "SELECT weekly_digest FROM users WHERE id = $1",
    [userId]
  );
  return r[0]?.weekly_digest === 1;
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
         OR ${HOLDS_GLOBALLY("space.read_all", "u.id")}
         OR ${HOLDS_ON_SPACE("space.member", "$1", "u.id")}
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
    OR ${HOLDS_GLOBALLY("space.read_all", "u.id")}
    OR ${HOLDS_ON_SPACE("space.member", "s.id", "u.id")}
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
         OR ${HOLDS_GLOBALLY("space.read_all", "u.id")}
         OR ${HOLDS_ON_SPACE("space.member", "s.id", "u.id")}
       )
     ORDER BY (a.acknowledged_at IS NULL) DESC, u.name`,
    [docId]
  );
}

/** Published ack-required docs in the user's scope they haven't confirmed yet. */
export async function listPendingAcksFor(
  userId: number,
  scope: SpaceScope
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

// --- Training decks (enterprise "training") ---------------------------------------

export interface TrainingDeck {
  id: number;
  document_id: number;
  active: number;
  due_days: number | null;
  assign_new_members: number;
  created_by: number | null;
  created_at: string;
  archived_at: string | null;
  pass_pct: number;
  recert_months: number | null;
  tag: string;
  require_signature: number;
  title: string;
  space_name: string;
  space_icon: string;
  doc_status: string;
  assigned: number;
  completed: number;
  waived: number;
  overdue: number;
  /** Slide where the most in-progress trainees stopped (null = none started). */
  stall_slide: number | null;
}

export async function createTrainingDeck(
  documentId: number,
  opts: { due_days: number | null; assign_new_members: boolean },
  createdBy: number
): Promise<{ id: number } | null> {
  const r = await q<{ id: number }>(
    `INSERT INTO training_decks (document_id, due_days, assign_new_members, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (document_id) DO NOTHING
     RETURNING id`,
    [documentId, opts.due_days, opts.assign_new_members ? 1 : 0, createdBy]
  );
  return r[0] ?? null;
}

export async function updateTrainingDeck(
  id: number,
  patch: {
    active?: boolean;
    due_days?: number | null;
    assign_new_members?: boolean;
    archived?: boolean;
    pass_pct?: number;
    recert_months?: number | null;
    tag?: string;
    require_signature?: boolean;
  }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  if (patch.active !== undefined) sets.push(`active = ${patch.active ? 1 : 0}`);
  if (patch.archived !== undefined)
    sets.push(`archived_at = ${patch.archived ? "now()" : "NULL"}`);
  if (patch.due_days !== undefined) {
    vals.push(patch.due_days);
    sets.push(`due_days = $${vals.length}`);
  }
  if (patch.assign_new_members !== undefined)
    sets.push(`assign_new_members = ${patch.assign_new_members ? 1 : 0}`);
  if (patch.pass_pct !== undefined) {
    vals.push(Math.min(100, Math.max(1, Math.floor(patch.pass_pct))));
    sets.push(`pass_pct = $${vals.length}`);
  }
  if (patch.recert_months !== undefined) {
    vals.push(patch.recert_months);
    sets.push(`recert_months = $${vals.length}`);
  }
  if (patch.tag !== undefined) {
    vals.push(patch.tag.slice(0, 60));
    sets.push(`tag = $${vals.length}`);
  }
  if (patch.require_signature !== undefined)
    sets.push(`require_signature = ${patch.require_signature ? 1 : 0}`);
  if (!sets.length) return;
  await q(`UPDATE training_decks SET ${sets.join(", ")} WHERE id = $1`, vals);
}

export async function listTrainingDecks(archived = false): Promise<TrainingDeck[]> {
  return q(
    `SELECT t.*, d.title, d.status AS doc_status, s.name AS space_name, s.icon AS space_icon,
            (SELECT COUNT(*)::int FROM training_assignments a JOIN users u ON u.id = a.user_id
             WHERE a.deck_id = t.id AND u.status = 'active') AS assigned,
            (SELECT COUNT(*)::int FROM training_assignments a JOIN users u ON u.id = a.user_id
             WHERE a.deck_id = t.id AND u.status = 'active'
               AND a.completed_at IS NOT NULL AND a.source <> 'waived') AS completed,
            (SELECT COUNT(*)::int FROM training_assignments a JOIN users u ON u.id = a.user_id
             WHERE a.deck_id = t.id AND u.status = 'active'
               AND a.completed_at IS NOT NULL AND a.source = 'waived') AS waived,
            (SELECT COUNT(*)::int FROM training_assignments a JOIN users u ON u.id = a.user_id
             WHERE a.deck_id = t.id AND u.status = 'active'
               AND a.completed_at IS NULL AND a.due_at < now()) AS overdue,
            (SELECT a.last_slide FROM training_assignments a
             WHERE a.deck_id = t.id AND a.completed_at IS NULL AND a.last_slide > 0
             GROUP BY a.last_slide ORDER BY COUNT(*) DESC, a.last_slide LIMIT 1) AS stall_slide
     FROM training_decks t
     JOIN documents d ON d.id = t.document_id
     JOIN spaces s ON s.id = d.space_id
     WHERE d.deleted_at IS NULL AND t.archived_at IS ${archived ? "NOT NULL" : "NULL"}
     ORDER BY t.created_at DESC`
  );
}

/**
 * Hard-delete a deck. Completed assignments are archived to the history
 * table first (with name/title snapshots), so the evidence outlives the
 * deck; open assignments and program links cascade away.
 */
export async function deleteTrainingDeck(id: number): Promise<void> {
  await q(
    `INSERT INTO training_completion_history
       (deck_id, user_id, assigned_at, completed_at, confirmed_version, quiz_score, quiz_total,
        source, user_name, user_email, deck_title, signed_name, content_sha256, quiz_answers)
     SELECT a.deck_id, a.user_id, a.assigned_at, a.completed_at, a.confirmed_version,
            a.quiz_score, a.quiz_total, a.source, u.name, u.email, d.title,
            a.signed_name, a.content_sha256, a.quiz_answers
     FROM training_assignments a
     JOIN users u ON u.id = a.user_id
     JOIN training_decks t ON t.id = a.deck_id
     JOIN documents d ON d.id = t.document_id
     WHERE a.deck_id = $1 AND a.completed_at IS NOT NULL`,
    [id]
  );
  await q(`DELETE FROM training_decks WHERE id = $1`, [id]);
}

export async function countArchivedTrainingDecks(): Promise<number> {
  const r = await q<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM training_decks WHERE archived_at IS NOT NULL`
  );
  return r[0]?.n ?? 0;
}

export async function getTrainingDeck(id: number): Promise<TrainingDeck | undefined> {
  return (
    await q<TrainingDeck>(
      `SELECT t.*, d.title, d.status AS doc_status, s.name AS space_name, s.icon AS space_icon,
              0 AS assigned, 0 AS completed, 0 AS waived, 0 AS overdue,
              NULL::int AS stall_slide
       FROM training_decks t
       JOIN documents d ON d.id = t.document_id
       JOIN spaces s ON s.id = d.space_id
       WHERE t.id = $1 AND d.deleted_at IS NULL`,
      [id]
    )
  )[0];
}

/** Published docs eligible to become decks (not already one). */
export async function trainingCandidateDocs(): Promise<
  { id: number; title: string; space_name: string }[]
> {
  return q(
    `SELECT d.id, d.title, s.name AS space_name
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.status = 'published' AND d.deleted_at IS NULL AND d.branch_of IS NULL
       AND NOT EXISTS (SELECT 1 FROM training_decks t WHERE t.document_id = d.id)
     ORDER BY d.updated_at DESC`
  );
}

/** Assign a deck to users; returns the ids actually newly assigned. */
export async function assignTraining(
  deckId: number,
  userIds: number[],
  assignedBy: string,
  source: string,
  dueAt: string | null
): Promise<number[]> {
  if (!userIds.length) return [];
  const r = await q<{ user_id: number }>(
    `INSERT INTO training_assignments (deck_id, user_id, assigned_by, source, due_at)
     SELECT $1, u.id, $2, $3, $4 FROM users u
     WHERE u.id = ANY($5) AND u.status = 'active'
     ON CONFLICT (deck_id, user_id) DO NOTHING
     RETURNING user_id`,
    [deckId, assignedBy.slice(0, 200), source, dueAt, userIds]
  );
  return r.map((x) => x.user_id);
}

/**
 * Waive a deck for users: mark it complete without them taking it — for
 * organizations rolling CompassDocs out to staff who already did the
 * training elsewhere. Waived rows keep source='waived' and no confirmed
 * version, so reporting stays honest about what was actually completed.
 * Returns the user ids newly waived (already-completed rows are untouched).
 */
export async function waiveTraining(
  deckId: number,
  userIds: number[],
  waivedBy: string
): Promise<number[]> {
  if (!userIds.length) return [];
  const r = await q<{ user_id: number }>(
    `INSERT INTO training_assignments (deck_id, user_id, assigned_by, source, completed_at)
     SELECT $1, u.id, $2, 'waived', now() FROM users u
     WHERE u.id = ANY($3) AND u.status = 'active'
     ON CONFLICT (deck_id, user_id) DO UPDATE SET completed_at = now(), source = 'waived'
     WHERE training_assignments.completed_at IS NULL
     RETURNING user_id`,
    [deckId, waivedBy.slice(0, 200), userIds]
  );
  return r.map((x) => x.user_id);
}

export interface MyTraining {
  assignment_id: number;
  deck_id: number;
  document_id: number;
  title: string;
  space_name: string;
  space_icon: string;
  content: string;
  assigned_at: string;
  due_at: string | null;
  last_slide: number;
  completed_at: string | null;
  quiz_score: number | null;
  quiz_total: number | null;
  pass_pct: number;
  source: string;
  require_signature: number;
}

export async function listMyTraining(userId: number): Promise<MyTraining[]> {
  return q(
    `SELECT a.id AS assignment_id, t.id AS deck_id, d.id AS document_id, d.title,
            s.name AS space_name, s.icon AS space_icon, d.content,
            a.assigned_at, a.due_at, a.last_slide, a.completed_at,
            a.quiz_score, a.quiz_total, t.pass_pct, a.source, t.require_signature
     FROM training_assignments a
     JOIN training_decks t ON t.id = a.deck_id
     JOIN documents d ON d.id = t.document_id
     JOIN spaces s ON s.id = d.space_id
     WHERE a.user_id = $1 AND t.active = 1 AND t.archived_at IS NULL
       AND d.status = 'published' AND d.deleted_at IS NULL
     ORDER BY (a.completed_at IS NULL) DESC, a.due_at NULLS LAST, a.assigned_at DESC
     LIMIT 100`,
    [userId]
  );
}

export async function getMyTrainingAssignment(
  assignmentId: number,
  userId: number
): Promise<MyTraining | undefined> {
  return (
    await q<MyTraining>(
      `SELECT a.id AS assignment_id, t.id AS deck_id, d.id AS document_id, d.title,
              s.name AS space_name, s.icon AS space_icon, d.content,
              a.assigned_at, a.due_at, a.last_slide, a.completed_at,
            a.quiz_score, a.quiz_total, t.pass_pct, a.source, t.require_signature
       FROM training_assignments a
       JOIN training_decks t ON t.id = a.deck_id
       JOIN documents d ON d.id = t.document_id
       JOIN spaces s ON s.id = d.space_id
       WHERE a.id = $1 AND a.user_id = $2 AND t.active = 1 AND t.archived_at IS NULL
         AND d.status = 'published' AND d.deleted_at IS NULL`,
      [assignmentId, userId]
    )
  )[0];
}

export async function setTrainingProgress(
  assignmentId: number,
  userId: number,
  slide: number
): Promise<void> {
  await q(
    `UPDATE training_assignments SET last_slide = GREATEST(last_slide, $3), progress_at = now()
     WHERE id = $1 AND user_id = $2 AND completed_at IS NULL`,
    [assignmentId, userId, Math.max(0, Math.floor(slide))]
  );
}

/**
 * Confirm completion once; records the doc version being confirmed, a
 * SHA-256 of the exact content confirmed, and (when the deck demands an
 * e-signature) the name the trainee typed.
 */
export async function completeTraining(
  assignmentId: number,
  userId: number,
  evidence: { contentSha256: string; signedName: string | null }
): Promise<{ deck_id: number; confirmed_version: number | null } | undefined> {
  return (
    await q<{ deck_id: number; confirmed_version: number | null }>(
      `UPDATE training_assignments a
       SET completed_at = now(),
           content_sha256 = $3,
           signed_name = $4,
           confirmed_version = (
             SELECT MAX(v.id) FROM doc_versions v
             JOIN training_decks t ON t.id = a.deck_id
             WHERE v.document_id = t.document_id
           )
       WHERE a.id = $1 AND a.user_id = $2 AND a.completed_at IS NULL
       RETURNING a.deck_id, a.confirmed_version`,
      [assignmentId, userId, evidence.contentSha256, evidence.signedName]
    )
  )[0];
}

export interface TrainingStatusRow {
  assignment_id: number;
  user_id: number;
  name: string;
  username: string;
  email: string;
  assigned_at: string;
  due_at: string | null;
  last_slide: number;
  completed_at: string | null;
  confirmed_version: number | null;
  source: string;
  quiz_score: number | null;
  quiz_total: number | null;
  prior_completions: number;
  signed_name: string | null;
  content_sha256: string | null;
}

export async function trainingDeckStatus(deckId: number): Promise<TrainingStatusRow[]> {
  return q(
    `SELECT a.id AS assignment_id, a.user_id, u.name, u.username, u.email, a.assigned_at, a.due_at,
            a.last_slide, a.completed_at, a.confirmed_version, a.source,
            a.quiz_score, a.quiz_total, a.signed_name, a.content_sha256,
            (SELECT COUNT(*)::int FROM training_completion_history h
             WHERE h.deck_id = a.deck_id AND h.user_id = a.user_id) AS prior_completions
     FROM training_assignments a JOIN users u ON u.id = a.user_id
     WHERE a.deck_id = $1 AND u.status = 'active'
     ORDER BY (a.completed_at IS NULL) DESC, a.due_at NULLS LAST, u.name`,
    [deckId]
  );
}

/** The user's count of open assignments (sidebar badge). */
export async function countMyOpenTraining(userId: number): Promise<number> {
  const r = await q<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM training_assignments a
     JOIN training_decks t ON t.id = a.deck_id
     JOIN documents d ON d.id = t.document_id
     WHERE a.user_id = $1 AND a.completed_at IS NULL AND t.active = 1
       AND t.archived_at IS NULL AND d.status = 'published' AND d.deleted_at IS NULL`,
    [userId]
  );
  return r[0]?.n ?? 0;
}

/**
 * Atomically claim due/overdue incomplete assignments for a reminder pass
 * (once per 3 days per assignment; due within 3 days or already overdue).
 */
export async function claimTrainingReminders(): Promise<
  {
    assignment_id: number;
    user_id: number;
    name: string;
    email: string;
    notify_prefs: Record<string, Record<string, boolean>> | null;
    title: string;
    due_at: string;
  }[]
> {
  return q(
    `UPDATE training_assignments a
     SET reminded_at = now()
     FROM training_decks t, documents d, users u
     WHERE t.id = a.deck_id AND d.id = t.document_id AND u.id = a.user_id
       AND a.completed_at IS NULL AND t.active = 1 AND t.archived_at IS NULL
       AND u.status = 'active'
       AND d.status = 'published' AND d.deleted_at IS NULL
       AND a.due_at IS NOT NULL AND a.due_at < now() + interval '3 days'
       AND (a.reminded_at IS NULL OR a.reminded_at < now() - interval '3 days')
     RETURNING a.id AS assignment_id, a.user_id, u.name, u.email, u.notify_prefs,
               d.title, a.due_at`
  );
}

/**
 * Store a quiz result (latest attempt wins; only before completion). The
 * per-question outcome array feeds the deck's question analytics.
 */
export async function setTrainingQuizScore(
  assignmentId: number,
  userId: number,
  score: number,
  total: number,
  results: boolean[]
): Promise<void> {
  await q(
    `UPDATE training_assignments SET quiz_score = $3, quiz_total = $4, quiz_answers = $5
     WHERE id = $1 AND user_id = $2 AND completed_at IS NULL`,
    [assignmentId, userId, score, total, JSON.stringify(results)]
  );
}

/** Per-question outcome arrays for a deck — live attempts plus prior cycles. */
export async function trainingQuizResultRows(deckId: number): Promise<boolean[][]> {
  const rows = await q<{ quiz_answers: unknown }>(
    `SELECT quiz_answers FROM training_assignments
     WHERE deck_id = $1 AND quiz_answers IS NOT NULL
     UNION ALL
     SELECT quiz_answers FROM training_completion_history
     WHERE deck_id = $1 AND quiz_answers IS NOT NULL`,
    [deckId]
  );
  return rows
    .map((r) => r.quiz_answers)
    .filter((a): a is boolean[] => Array.isArray(a) && a.every((x) => typeof x === "boolean"));
}

/**
 * Reopen completed assignments: archive each completion to history, then
 * reset the assignment for a new cycle. Used by the recert sweep (interval
 * elapsed) and the manager's "reopen completed" action (doc changed).
 */
async function reopenAssignments(where: string, params: unknown[]): Promise<
  { assignment_id: number; user_id: number; title: string; due_at: string | null }[]
> {
  return q(
    `WITH due AS (
       SELECT a.id FROM training_assignments a
       JOIN training_decks t ON t.id = a.deck_id
       JOIN documents d ON d.id = t.document_id
       WHERE a.completed_at IS NOT NULL AND t.active = 1 AND t.archived_at IS NULL
         AND d.status = 'published' AND d.deleted_at IS NULL
         AND ${where}
       FOR UPDATE OF a SKIP LOCKED
     ),
     hist AS (
       INSERT INTO training_completion_history
         (deck_id, user_id, assigned_at, completed_at, confirmed_version, quiz_score, quiz_total,
          source, user_name, user_email, deck_title, signed_name, content_sha256, quiz_answers)
       SELECT a.deck_id, a.user_id, a.assigned_at, a.completed_at, a.confirmed_version,
              a.quiz_score, a.quiz_total, a.source, u.name, u.email, d2.title,
              a.signed_name, a.content_sha256, a.quiz_answers
       FROM training_assignments a
       JOIN due ON due.id = a.id
       JOIN users u ON u.id = a.user_id
       JOIN training_decks t3 ON t3.id = a.deck_id
       JOIN documents d2 ON d2.id = t3.document_id
     )
     UPDATE training_assignments a
     SET completed_at = NULL, confirmed_version = NULL, last_slide = 0,
         quiz_score = NULL, quiz_total = NULL, quiz_answers = NULL,
         signed_name = NULL, content_sha256 = NULL, reminded_at = NULL, escalated_at = NULL,
         assigned_at = now(), source = 'recert',
         due_at = (SELECT CASE WHEN t.due_days IS NULL THEN NULL
                               ELSE now() + make_interval(days => t.due_days) END
                   FROM training_decks t WHERE t.id = a.deck_id)
     FROM due
     WHERE a.id = due.id
     RETURNING a.id AS assignment_id, a.user_id,
               (SELECT d.title FROM training_decks t JOIN documents d ON d.id = t.document_id
                WHERE t.id = a.deck_id) AS title,
               a.due_at`,
    params
  );
}

/** Recert sweep: reopen completions older than the deck's recert interval. */
export async function claimRecertifications(): Promise<
  { assignment_id: number; user_id: number; title: string; due_at: string | null }[]
> {
  return reopenAssignments(
    `t.recert_months IS NOT NULL
       AND a.completed_at < now() - make_interval(months => t.recert_months)`,
    []
  );
}

/**
 * Manager action: reopen completed assignments on one deck — all of them, or
 * just the given assignment ids (individual retraining).
 */
export async function reopenCompletedForDeck(
  deckId: number,
  assignmentIds?: number[]
): Promise<{ assignment_id: number; user_id: number; title: string; due_at: string | null }[]> {
  if (assignmentIds && assignmentIds.length) {
    return reopenAssignments(`a.deck_id = $1 AND a.id = ANY($2)`, [deckId, assignmentIds]);
  }
  return reopenAssignments(`a.deck_id = $1`, [deckId]);
}

/**
 * Escalation claim: incomplete assignments more than 7 days overdue whose
 * deck has a creator, not yet escalated. Marks them so each fires once.
 */
export async function claimTrainingEscalations(): Promise<
  { deck_id: number; creator_id: number; title: string }[]
> {
  return q(
    `UPDATE training_assignments a
     SET escalated_at = now()
     FROM training_decks t, documents d
     WHERE t.id = a.deck_id AND d.id = t.document_id
       AND a.completed_at IS NULL AND a.escalated_at IS NULL
       AND a.due_at IS NOT NULL AND a.due_at < now() - interval '7 days'
       AND t.active = 1 AND t.archived_at IS NULL AND t.created_by IS NOT NULL
       AND d.status = 'published' AND d.deleted_at IS NULL
     RETURNING a.deck_id, t.created_by AS creator_id, d.title`
  );
}

/** Where incomplete trainees stopped, per slide (drop-off insight). */
export async function trainingDropoff(deckId: number): Promise<{ slide: number; n: number }[]> {
  return q(
    `SELECT last_slide AS slide, COUNT(*)::int AS n
     FROM training_assignments
     WHERE deck_id = $1 AND completed_at IS NULL AND last_slide > 0
     GROUP BY last_slide ORDER BY last_slide`,
    [deckId]
  );
}

export interface TrainingOverview {
  decks: number;
  people_assigned: number;
  open: number;
  overdue: number;
  completed: number;
  waived: number;
  overdue_people: { name: string; username: string; deck: string; due_at: string }[];
}

/** Org-wide rollup for the Overview tab. */
export async function trainingOverview(): Promise<TrainingOverview> {
  const base = `FROM training_assignments a
     JOIN training_decks t ON t.id = a.deck_id
     JOIN documents d ON d.id = t.document_id
     JOIN users u ON u.id = a.user_id
     WHERE t.archived_at IS NULL AND d.deleted_at IS NULL AND u.status = 'active'`;
  const totals = await q<{
    decks: number; people_assigned: number; open: number; overdue: number;
    completed: number; waived: number;
  }>(
    `SELECT (SELECT COUNT(*)::int FROM training_decks WHERE archived_at IS NULL) AS decks,
            COUNT(DISTINCT a.user_id)::int AS people_assigned,
            COUNT(*) FILTER (WHERE a.completed_at IS NULL)::int AS open,
            COUNT(*) FILTER (WHERE a.completed_at IS NULL AND a.due_at < now())::int AS overdue,
            COUNT(*) FILTER (WHERE a.completed_at IS NOT NULL AND a.source <> 'waived')::int AS completed,
            COUNT(*) FILTER (WHERE a.completed_at IS NOT NULL AND a.source = 'waived')::int AS waived
     ${base}`
  );
  const overdue_people = await q<{ name: string; username: string; deck: string; due_at: string }>(
    `SELECT u.name, u.username, d.title AS deck, a.due_at
     ${base} AND a.completed_at IS NULL AND a.due_at < now()
     ORDER BY a.due_at ASC LIMIT 50`
  );
  return { ...totals[0], overdue_people };
}

/** Every assignment row across unarchived decks (org CSV). */
export async function trainingOrgRows(): Promise<
  (TrainingStatusRow & { deck: string })[]
> {
  return q(
    `SELECT d.title AS deck, a.id AS assignment_id, a.user_id, u.name, u.username, u.email, a.assigned_at, a.due_at,
            a.last_slide, a.completed_at, a.confirmed_version, a.source,
            a.quiz_score, a.quiz_total, a.signed_name, a.content_sha256,
            (SELECT COUNT(*)::int FROM training_completion_history h
             WHERE h.deck_id = a.deck_id AND h.user_id = a.user_id) AS prior_completions
     FROM training_assignments a
     JOIN training_decks t ON t.id = a.deck_id
     JOIN documents d ON d.id = t.document_id
     JOIN users u ON u.id = a.user_id
     WHERE t.archived_at IS NULL AND d.deleted_at IS NULL AND u.status = 'active'
     ORDER BY d.title, (a.completed_at IS NULL) DESC, u.name`
  );
}

/** One assignment with user + deck context (certificates, manager remind). */
export async function getTrainingAssignment(assignmentId: number): Promise<
  | (MyTraining & {
      user_id: number;
      user_name: string;
      username: string;
      confirmed_version: number | null;
      signed_name: string | null;
      content_sha256: string | null;
    })
  | undefined
> {
  const r = await q<
    MyTraining & {
      user_id: number;
      user_name: string;
      username: string;
      confirmed_version: number | null;
      signed_name: string | null;
      content_sha256: string | null;
    }
  >(
    `SELECT a.id AS assignment_id, t.id AS deck_id, d.id AS document_id, d.title,
            s.name AS space_name, s.icon AS space_icon, d.content,
            a.assigned_at, a.due_at, a.last_slide, a.completed_at,
            a.quiz_score, a.quiz_total, t.pass_pct, a.source, t.require_signature,
            a.user_id, u.name AS user_name, u.username, a.confirmed_version,
            a.signed_name, a.content_sha256
     FROM training_assignments a
     JOIN training_decks t ON t.id = a.deck_id
     JOIN documents d ON d.id = t.document_id
     JOIN spaces s ON s.id = d.space_id
     JOIN users u ON u.id = a.user_id
     WHERE a.id = $1 AND d.deleted_at IS NULL`,
    [assignmentId]
  );
  return r[0];
}

/**
 * Remove OPEN assignments (mis-assignments, leavers). Completed rows are
 * records and cannot be unassigned — reopen or archive the deck instead.
 * Returns how many were removed.
 */
export async function unassignTraining(deckId: number, assignmentIds: number[]): Promise<number> {
  if (!assignmentIds.length) return 0;
  const r = await q<{ id: number }>(
    `DELETE FROM training_assignments
     WHERE deck_id = $1 AND id = ANY($2) AND completed_at IS NULL
     RETURNING id`,
    [deckId, assignmentIds]
  );
  return r.length;
}

/**
 * Push selected open assignments' due dates out by N days (from now, or from
 * the current due date if that's later). Re-arms escalation.
 */
export async function extendTrainingDue(
  deckId: number,
  assignmentIds: number[],
  days: number
): Promise<number> {
  if (!assignmentIds.length) return 0;
  const r = await q<{ id: number }>(
    `UPDATE training_assignments
     SET due_at = GREATEST(COALESCE(due_at, now()), now()) + make_interval(days => $3),
         escalated_at = NULL, snoozed_until = NULL
     WHERE deck_id = $1 AND id = ANY($2) AND completed_at IS NULL
     RETURNING id`,
    [deckId, assignmentIds, Math.min(365, Math.max(1, Math.floor(days)))]
  );
  return r.length;
}

/** Mark manual reminders sent so the sweep doesn't double-nudge within hours. */
export async function setTrainingReminded(assignmentIds: number[]): Promise<void> {
  if (!assignmentIds.length) return;
  await q(`UPDATE training_assignments SET reminded_at = now() WHERE id = ANY($1)`, [
    assignmentIds,
  ]);
}

/** Snooze rows out of the needs-attention queue for N days. */
export async function snoozeTraining(assignmentIds: number[], days: number): Promise<void> {
  if (!assignmentIds.length) return;
  await q(
    `UPDATE training_assignments
     SET snoozed_until = now() + make_interval(days => $2)
     WHERE id = ANY($1) AND completed_at IS NULL`,
    [assignmentIds, Math.min(90, Math.max(1, Math.floor(days)))]
  );
}

export interface AttentionRow {
  assignment_id: number;
  deck_id: number;
  deck: string;
  user_id: number;
  name: string;
  username: string;
  due_at: string | null;
  last_slide: number;
  quiz_score: number | null;
  quiz_total: number | null;
  pass_pct: number;
  reason: "overdue" | "failed_quiz" | "stalled";
}

/**
 * The triage queue: overdue, failed-quiz (below the deck's pass %), or
 * stalled (started, then no activity for 14+ days). Snoozed rows drop out.
 */
export async function trainingNeedsAttention(): Promise<{
  rows: AttentionRow[];
  total: number;
}> {
  const where = `a.completed_at IS NULL
       AND (a.snoozed_until IS NULL OR a.snoozed_until < now())
       AND t.active = 1 AND t.archived_at IS NULL
       AND d.status = 'published' AND d.deleted_at IS NULL AND u.status = 'active'
       AND ((a.due_at IS NOT NULL AND a.due_at < now())
         OR (a.quiz_total IS NOT NULL AND a.quiz_total > 0
             AND a.quiz_score::numeric / a.quiz_total < t.pass_pct / 100.0)
         OR (a.last_slide > 0 AND a.progress_at IS NOT NULL
             AND a.progress_at < now() - interval '14 days'))`;
  const from = `FROM training_assignments a
     JOIN training_decks t ON t.id = a.deck_id
     JOIN documents d ON d.id = t.document_id
     JOIN users u ON u.id = a.user_id`;
  const rows = await q<AttentionRow>(
    `SELECT a.id AS assignment_id, t.id AS deck_id, d.title AS deck,
            u.id AS user_id, u.name, u.username, a.due_at, a.last_slide,
            a.quiz_score, a.quiz_total, t.pass_pct,
            CASE WHEN a.due_at IS NOT NULL AND a.due_at < now() THEN 'overdue'
                 WHEN a.quiz_total IS NOT NULL AND a.quiz_total > 0
                      AND a.quiz_score::numeric / a.quiz_total < t.pass_pct / 100.0
                   THEN 'failed_quiz'
                 ELSE 'stalled' END AS reason
     ${from} WHERE ${where}
     ORDER BY (a.due_at IS NULL), a.due_at ASC, u.name
     LIMIT 200`
  );
  const total = await q<{ n: number }>(`SELECT COUNT(*)::int AS n ${from} WHERE ${where}`);
  return { rows, total: total[0]?.n ?? 0 };
}

export interface TranscriptRow {
  assignment_id: number;
  deck_id: number;
  deck: string;
  deck_archived: boolean;
  assigned_at: string;
  due_at: string | null;
  completed_at: string | null;
  confirmed_version: number | null;
  quiz_score: number | null;
  quiz_total: number | null;
  source: string;
  last_slide: number;
}

/** One person's full training record: live assignments + closed cycles. */
export async function userTrainingTranscript(userId: number): Promise<{
  current: TranscriptRow[];
  history: {
    deck_title: string;
    assigned_at: string;
    completed_at: string | null;
    confirmed_version: number | null;
    quiz_score: number | null;
    quiz_total: number | null;
    source: string;
    closed_at: string;
  }[];
}> {
  const current = await q<TranscriptRow>(
    `SELECT a.id AS assignment_id, t.id AS deck_id, d.title AS deck,
            (t.archived_at IS NOT NULL) AS deck_archived,
            a.assigned_at, a.due_at, a.completed_at, a.confirmed_version,
            a.quiz_score, a.quiz_total, a.source, a.last_slide
     FROM training_assignments a
     JOIN training_decks t ON t.id = a.deck_id
     JOIN documents d ON d.id = t.document_id
     WHERE a.user_id = $1 AND d.deleted_at IS NULL
     ORDER BY (a.completed_at IS NULL) DESC, a.due_at NULLS LAST, d.title`,
    [userId]
  );
  const history = await q<{
    deck_title: string;
    assigned_at: string;
    completed_at: string | null;
    confirmed_version: number | null;
    quiz_score: number | null;
    quiz_total: number | null;
    source: string;
    closed_at: string;
  }>(
    `SELECT COALESCE(NULLIF(h.deck_title, ''),
                     (SELECT d.title FROM training_decks t JOIN documents d ON d.id = t.document_id
                      WHERE t.id = h.deck_id)) AS deck_title,
            h.assigned_at, h.completed_at, h.confirmed_version,
            h.quiz_score, h.quiz_total, h.source, h.closed_at
     FROM training_completion_history h
     WHERE h.user_id = $1
     ORDER BY h.closed_at DESC`,
    [userId]
  );
  return { current, history };
}

/** Resolve an assignment audience (users + groups + everyone) to user ids. */
export async function expandTrainingAudience(
  userIds: number[],
  groupIds: number[],
  everyone: boolean
): Promise<number[]> {
  if (everyone) {
    const r = await q<{ id: number }>(`SELECT id FROM users WHERE status = 'active'`);
    return r.map((x) => x.id);
  }
  const ids = new Set<number>(userIds);
  if (groupIds.length) {
    const r = await q<{ user_id: number }>(
      `SELECT DISTINCT gm.user_id FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ANY($1) AND u.status = 'active'`,
      [groupIds]
    );
    for (const x of r) ids.add(x.user_id);
  }
  return [...ids];
}

/**
 * Auto-assign training to a just-created user: every active new-member deck,
 * plus every deck of an active onboarding program with assign_new_members on.
 */
export async function autoAssignTraining(userId: number): Promise<void> {
  await q(
    `INSERT INTO training_assignments (deck_id, user_id, assigned_by, source, due_at)
     SELECT DISTINCT ON (t.id) t.id, $1, 'auto',
            CASE WHEN pd.deck_id IS NULL THEN 'new_member' ELSE 'onboarding' END,
            CASE WHEN t.due_days IS NULL THEN NULL
                 ELSE now() + make_interval(days => t.due_days) END
     FROM training_decks t
     JOIN documents d ON d.id = t.document_id
     LEFT JOIN training_program_decks pd
       ON pd.deck_id = t.id
      AND pd.program_id IN
          (SELECT id FROM training_programs WHERE active = 1 AND assign_new_members = 1)
     WHERE t.active = 1 AND t.archived_at IS NULL
       AND (t.assign_new_members = 1 OR pd.deck_id IS NOT NULL)
       AND d.status = 'published' AND d.deleted_at IS NULL
     ORDER BY t.id
     ON CONFLICT (deck_id, user_id) DO NOTHING`,
    [userId]
  );
}

// --- Onboarding programs (bundles of decks) ---------------------------------------

export interface TrainingProgram {
  id: number;
  name: string;
  active: number;
  assign_new_members: number;
  created_at: string;
  decks: { id: number; title: string }[];
}

export async function createTrainingProgram(
  name: string,
  deckIds: number[],
  createdBy: number
): Promise<number> {
  const r = await q<{ id: number }>(
    `INSERT INTO training_programs (name, created_by) VALUES ($1, $2) RETURNING id`,
    [name.slice(0, 200), createdBy]
  );
  await setProgramDecks(r[0].id, deckIds);
  return r[0].id;
}

async function setProgramDecks(programId: number, deckIds: number[]): Promise<void> {
  await q(`DELETE FROM training_program_decks WHERE program_id = $1`, [programId]);
  for (let i = 0; i < deckIds.length; i++) {
    await q(
      `INSERT INTO training_program_decks (program_id, deck_id, position)
       SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM training_decks WHERE id = $2)
       ON CONFLICT DO NOTHING`,
      [programId, deckIds[i], i]
    );
  }
}

export async function updateTrainingProgram(
  id: number,
  patch: { name?: string; active?: boolean; assign_new_members?: boolean; deck_ids?: number[] }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  if (patch.name !== undefined) {
    vals.push(patch.name.slice(0, 200));
    sets.push(`name = $${vals.length}`);
  }
  if (patch.active !== undefined) sets.push(`active = ${patch.active ? 1 : 0}`);
  if (patch.assign_new_members !== undefined)
    sets.push(`assign_new_members = ${patch.assign_new_members ? 1 : 0}`);
  if (sets.length) await q(`UPDATE training_programs SET ${sets.join(", ")} WHERE id = $1`, vals);
  if (patch.deck_ids) await setProgramDecks(id, patch.deck_ids);
}

export async function deleteTrainingProgram(id: number): Promise<void> {
  await q(`DELETE FROM training_programs WHERE id = $1`, [id]);
}

export async function listTrainingPrograms(): Promise<TrainingProgram[]> {
  return q(
    `SELECT p.id, p.name, p.active, p.assign_new_members, p.created_at,
            COALESCE(
              (SELECT json_agg(json_build_object('id', t.id, 'title', d.title)
                               ORDER BY pd.position)
               FROM training_program_decks pd
               JOIN training_decks t ON t.id = pd.deck_id
               JOIN documents d ON d.id = t.document_id
               WHERE pd.program_id = p.id AND t.archived_at IS NULL
                 AND d.deleted_at IS NULL),
              '[]'::json) AS decks
     FROM training_programs p
     ORDER BY p.created_at DESC`
  );
}

export async function getTrainingProgram(id: number): Promise<TrainingProgram | undefined> {
  const r = await q<TrainingProgram>(
    `SELECT p.id, p.name, p.active, p.assign_new_members, p.created_at,
            COALESCE(
              (SELECT json_agg(json_build_object('id', t.id, 'title', d.title)
                               ORDER BY pd.position)
               FROM training_program_decks pd
               JOIN training_decks t ON t.id = pd.deck_id
               JOIN documents d ON d.id = t.document_id
               WHERE pd.program_id = p.id AND t.archived_at IS NULL
                 AND d.deleted_at IS NULL),
              '[]'::json) AS decks
     FROM training_programs p WHERE p.id = $1`,
    [id]
  );
  return r[0];
}

/** True when the (published) document is an unarchived training deck. */
export async function isTrainingDeckDoc(documentId: number): Promise<boolean> {
  const r = await q<{ id: number }>(
    `SELECT id FROM training_decks WHERE document_id = $1 AND archived_at IS NULL`,
    [documentId]
  );
  return r.length > 0;
}

// --- Training snapshots, history export, team leads (0.82) -------------------------

export interface TrainingSnapshotMeta {
  id: number;
  taken_at: string;
  kind: string;
  period: string;
  taken_by: string;
  sha256: string;
}

/**
 * Store a point-in-time snapshot. `data` is the canonical JSON TEXT the
 * sha256 was computed over — stored verbatim so auditors can re-hash the
 * download byte-for-byte. Monthly snapshots are unique per period (the
 * partial index makes the claim atomic across instances); returns null when
 * this period was already taken.
 */
export async function insertTrainingSnapshot(input: {
  kind: "manual" | "monthly";
  period: string;
  takenBy: string;
  sha256: string;
  data: string;
}): Promise<number | null> {
  const r = await q<{ id: number }>(
    input.kind === "monthly"
      ? `INSERT INTO training_snapshots (kind, period, taken_by, sha256, data)
         VALUES ('monthly', $1, $2, $3, $4)
         ON CONFLICT (period) WHERE kind = 'monthly' DO NOTHING
         RETURNING id`
      : `INSERT INTO training_snapshots (kind, period, taken_by, sha256, data)
         VALUES ('manual', $1, $2, $3, $4)
         RETURNING id`,
    [input.period, input.takenBy.slice(0, 200), input.sha256, input.data]
  );
  return r[0]?.id ?? null;
}

export async function listTrainingSnapshots(): Promise<TrainingSnapshotMeta[]> {
  return q(
    `SELECT id, taken_at, kind, period, taken_by, sha256
     FROM training_snapshots ORDER BY taken_at DESC LIMIT 100`
  );
}

export async function getTrainingSnapshot(
  id: number
): Promise<(TrainingSnapshotMeta & { data: string }) | undefined> {
  return (await q(`SELECT * FROM training_snapshots WHERE id = $1`, [id]))[0] as
    | (TrainingSnapshotMeta & { data: string })
    | undefined;
}

export interface TrainingHistoryRow {
  deck_title: string;
  user_name: string;
  user_email: string;
  assigned_at: string;
  completed_at: string | null;
  confirmed_version: number | null;
  quiz_score: number | null;
  quiz_total: number | null;
  source: string;
  signed_name: string | null;
  content_sha256: string | null;
  closed_at: string;
}

/** Every closed training cycle (audit package + history CSV). */
export async function listTrainingHistory(): Promise<TrainingHistoryRow[]> {
  return q(
    `SELECT COALESCE(NULLIF(h.deck_title, ''),
                     (SELECT d.title FROM training_decks t JOIN documents d ON d.id = t.document_id
                      WHERE t.id = h.deck_id), '') AS deck_title,
            h.user_name, h.user_email, h.assigned_at, h.completed_at, h.confirmed_version,
            h.quiz_score, h.quiz_total, h.source, h.signed_name, h.content_sha256, h.closed_at
     FROM training_completion_history h
     ORDER BY h.closed_at DESC`
  );
}

/**
 * Atomic once-per-period claim backed by the settings table (weekly team
 * digests). True exactly once per distinct value, across instances.
 */
export async function claimTrainingPeriod(key: string, period: string): Promise<boolean> {
  const r = await q<{ key: string }>(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
     WHERE settings.value <> EXCLUDED.value
     RETURNING key`,
    [key, period]
  );
  return r.length > 0;
}

export interface GroupLeadRow {
  group_id: number;
  group_name: string;
  user_id: number;
  name: string;
  username: string;
}

/** All lead grants, joined for display (managers' Team leads block). */
export async function listGroupLeads(): Promise<GroupLeadRow[]> {
  return q(
    `SELECT gl.group_id, g.name AS group_name, gl.user_id, u.name, u.username
     FROM group_leads gl
     JOIN groups g ON g.id = gl.group_id
     JOIN users u ON u.id = gl.user_id AND u.status = 'active'
     ORDER BY g.name, u.name`
  );
}

export async function setGroupLeads(groupId: number, userIds: number[]): Promise<void> {
  await q(`DELETE FROM group_leads WHERE group_id = $1`, [groupId]);
  if (userIds.length) {
    await q(
      `INSERT INTO group_leads (group_id, user_id)
       SELECT $1, u.id FROM users u WHERE u.id = ANY($2) AND u.status = 'active'
       ON CONFLICT DO NOTHING`,
      [groupId, userIds]
    );
  }
}

/** Groups this user leads (empty = no team view). */
export async function userLeadGroups(userId: number): Promise<{ id: number; name: string }[]> {
  return q(
    `SELECT g.id, g.name FROM group_leads gl JOIN groups g ON g.id = gl.group_id
     WHERE gl.user_id = $1 ORDER BY g.name`,
    [userId]
  );
}

export interface TeamTrainingRow {
  group_id: number;
  group_name: string;
  user_id: number;
  name: string;
  username: string;
  deck: string;
  due_at: string | null;
  completed_at: string | null;
  source: string;
  last_slide: number;
}

/**
 * Training status for every member of the given groups (the lead's scoped
 * view): one row per member × live assignment on an active deck. Members
 * with no assignments still appear (deck = '').
 */
export async function teamTrainingRows(groupIds: number[]): Promise<TeamTrainingRow[]> {
  if (!groupIds.length) return [];
  return q(
    `SELECT g.id AS group_id, g.name AS group_name, u.id AS user_id, u.name, u.username,
            COALESCE(x.deck, '') AS deck, x.due_at, x.completed_at,
            COALESCE(x.source, '') AS source, COALESCE(x.last_slide, 0) AS last_slide
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     JOIN users u ON u.id = gm.user_id AND u.status = 'active'
     LEFT JOIN (
       SELECT a.user_id, a.due_at, a.completed_at, a.source, a.last_slide, d.title AS deck
       FROM training_assignments a
       JOIN training_decks t ON t.id = a.deck_id AND t.active = 1 AND t.archived_at IS NULL
       JOIN documents d ON d.id = t.document_id AND d.status = 'published' AND d.deleted_at IS NULL
     ) x ON x.user_id = u.id
     WHERE g.id = ANY($1)
     ORDER BY g.name, u.name, (x.completed_at IS NULL) DESC, x.due_at NULLS LAST, x.deck`,
    [groupIds]
  );
}

/** Every lead (deduped) with email + the groups they lead — weekly digest. */
export async function listTrainingDigestLeads(): Promise<
  { user_id: number; name: string; email: string; group_ids: number[] }[]
> {
  return q(
    `SELECT u.id AS user_id, u.name, u.email, array_agg(gl.group_id) AS group_ids
     FROM group_leads gl
     JOIN users u ON u.id = gl.user_id AND u.status = 'active' AND u.email <> ''
     GROUP BY u.id, u.name, u.email
     ORDER BY u.name`
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

/** Active people holding `newsletter.decide` — the newsletter review audience. */
export async function listNewsletterApproverPool(): Promise<
  { id: number; name: string; email: string }[]
> {
  return q(
    `SELECT u.id, u.name, u.email FROM users u
      WHERE u.status = 'active' AND ${HOLDS_GLOBALLY("newsletter.decide", "u.id")}
      ORDER BY u.name`
  );
}

/**
 * Set someone's newsletter capability.
 *
 * Since 0.94 the assignment is what decides; the column is kept in step so the
 * people list still reads it, a downgrade to 0.93 still works, and the
 * break-glass path has something to fall back on. Both move together, in one
 * transaction, for the same reason the ladder has a trigger: two stores that
 * can disagree eventually will.
 */
export async function setUserNewsletterRole(userId: number, role: string): Promise<void> {
  const value = role === "contributor" || role === "approver" ? role : "none";
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE users SET newsletter_role = $2 WHERE id = $1", [userId, value]);
    await client.query(
      `DELETE FROM role_assignments ra USING roles r
        WHERE ra.role_id = r.id AND r.key IN ('newsletter-contributor','newsletter-approver')
          AND ra.user_id = $1 AND ra.scope_type = 'global'`,
      [userId]
    );
    if (value !== "none") {
      await client.query(
        `INSERT INTO role_assignments (role_id, user_id, scope_type)
         SELECT r.id, $1, 'global' FROM roles r WHERE r.key = $2 ON CONFLICT DO NOTHING`,
        [userId, `newsletter-${value}`]
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
  // Seal the shared secret at rest (like every other credential); reset the
  // replay counter for the fresh enrollment.
  await q("UPDATE users SET totp_secret = $1, totp_enabled = 0, totp_last_step = 0 WHERE id = $2", [
    sealSecret(secret),
    userId,
  ]);
}

/** Record the highest accepted TOTP step for a user (replay guard). */
export async function recordTotpStep(userId: number, step: number): Promise<void> {
  await q("UPDATE users SET totp_last_step = $1 WHERE id = $2", [step, userId]);
}

/**
 * SAML replay guard: record a validated response's digest as consumed. Returns
 * true when it was newly recorded (accept the sign-in) and false when the same
 * response was already seen (reject as a replay). Works across app instances
 * (unlike node-saml's in-memory cache) via a unique-insert race.
 */
export async function markSamlResponseSeen(digest: string, expiresAt: Date): Promise<boolean> {
  await q("DELETE FROM saml_seen_responses WHERE expires_at < now()").catch(() => {});
  const res = await q(
    "INSERT INTO saml_seen_responses (digest, expires_at) VALUES ($1, $2) ON CONFLICT (digest) DO NOTHING RETURNING digest",
    [digest, expiresAt.toISOString()]
  );
  return res.length > 0;
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
  return r
    ? {
        secret: r.totp_secret ? openSecret(r.totp_secret) : null,
        enabled: r.totp_enabled === 1,
        recovery_left: r.n,
      }
    : undefined;
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

export async function listSuggestions(
  status: "open" | undefined,
  scope: SpaceScope
): Promise<Suggestion[]> {
  // Hide suggestions attached to a trashed document; keep general (doc-less) ones.
  const conds = ["(sg.document_id IS NULL OR d.deleted_at IS NULL)"];
  const params: unknown[] = [];
  if (status) conds.push("sg.status = 'open'");
  // Scope: doc-less suggestions are general feedback (no private content) and
  // stay visible; doc-attached ones only when the doc's space is in scope.
  if (Array.isArray(scope)) {
    params.push(scope);
    conds.push(`(sg.document_id IS NULL OR d.space_id = ANY($${params.length}))`);
  }
  return q(`${SUGGESTION_SELECT} WHERE ${conds.join(" AND ")} ORDER BY sg.created_at DESC`, params);
}

export async function resolveSuggestion(
  id: number,
  resolverId: number,
  status: "accepted" | "dismissed",
  scope: SpaceScope
): Promise<boolean> {
  // Enforce space scope in the UPDATE (race-free): an approver may only resolve
  // a suggestion that is doc-less or attached to a doc in a space they can see.
  const params: unknown[] = [status, resolverId, id];
  let scopeClause = "";
  if (Array.isArray(scope)) {
    params.push(scope);
    scopeClause = ` AND (document_id IS NULL OR document_id IN (SELECT id FROM documents WHERE space_id = ANY($${params.length})))`;
  }
  const res = await q(
    `UPDATE suggestions SET status = $1, resolved_by = $2, resolved_at = now() WHERE id = $3 AND status = 'open'${scopeClause} RETURNING id`,
    params
  );
  return res.length > 0;
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
  status: "pending" | undefined,
  scope: SpaceScope
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

// --- RBAC introspection (0.91) ---------------------------------------------

export async function listRolesWithCounts(): Promise<
  { id: number; key: string; name: string; description: string; is_builtin: boolean; permission_count: number }[]
> {
  return q(
    `SELECT r.id, r.key, r.name, r.description, r.is_builtin,
            count(rp.permission)::int AS permission_count
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
      GROUP BY r.id ORDER BY r.is_builtin DESC, permission_count DESC, r.name`
  );
}

/**
 * Cross-check the migrated LADDER assignments against the ladder they came
 * from. Delegated roles (Announcements manager, Newsletter approver, …) are
 * built-in too but are not rungs, so they are excluded from both counts —
 * including them would report every delegated grant as a mismatch. Both are live until 0.92 ports the check sites, so a disagreement means
 * something wrote one and not the other — worth catching while there is still a
 * second source of truth to compare against.
 */
export async function rbacMigrationAudit(): Promise<{
  users: number;
  users_without_assignment: number;
  mismatched: number;
}> {
  const rows = await q<{ users: string; without: string; mismatched: string }>(
    `SELECT
       (SELECT count(*) FROM users)::text AS users,
       (SELECT count(*) FROM users u
          WHERE NOT EXISTS (SELECT 1 FROM role_assignments ra
                             JOIN roles r ON r.id = ra.role_id
                            WHERE ra.user_id = u.id AND ra.scope_type = 'global'
                              AND r.key IN ('viewer','editor','approver','admin')))::text AS without,
       (SELECT count(*) FROM users u
          JOIN role_assignments ra ON ra.user_id = u.id AND ra.scope_type = 'global'
          JOIN roles r ON r.id = ra.role_id AND r.is_builtin
         WHERE r.key IN ('viewer','editor','approver','admin') AND r.key <> u.role)::text AS mismatched`
  );
  const r = rows[0];
  return {
    users: Number(r?.users ?? 0),
    users_without_assignment: Number(r?.without ?? 0),
    mismatched: Number(r?.mismatched ?? 0),
  };
}

// --- Shadow-mode observations (0.92) ---------------------------------------

/**
 * Record one legacy-vs-RBAC comparison. Upserts a counter rather than logging a
 * row per request, so this is safe to leave on in production: the table is
 * bounded by the number of distinct (route, permission, outcome) shapes.
 *
 * Never throws — an observability write must not be able to fail a request that
 * authorization already allowed.
 */
export async function recordShadowObservation(
  route: string,
  permission: string,
  legacyAllowed: boolean,
  rbacAllowed: boolean
): Promise<void> {
  try {
    await pool().query(
      `INSERT INTO authz_shadow (route, permission, legacy_allowed, rbac_allowed, hits)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (route, permission, legacy_allowed, rbac_allowed)
       DO UPDATE SET hits = authz_shadow.hits + 1, last_seen = now()`,
      [route.slice(0, 200), permission.slice(0, 100), legacyAllowed, rbacAllowed]
    );
  } catch {
    /* observability only */
  }
}

export async function shadowReport(): Promise<{
  agreements: number;
  disagreements: number;
  rows: {
    route: string;
    permission: string;
    legacy_allowed: boolean;
    rbac_allowed: boolean;
    hits: string;
    last_seen: string;
  }[];
}> {
  const rows = await q<{
    route: string;
    permission: string;
    legacy_allowed: boolean;
    rbac_allowed: boolean;
    hits: string;
    last_seen: string;
  }>(
    `SELECT route, permission, legacy_allowed, rbac_allowed, hits::text, last_seen
       FROM authz_shadow ORDER BY (legacy_allowed <> rbac_allowed) DESC, hits DESC LIMIT 500`
  );
  return {
    agreements: rows.filter((r) => r.legacy_allowed === r.rbac_allowed).length,
    disagreements: rows.filter((r) => r.legacy_allowed !== r.rbac_allowed).length,
    rows,
  };
}

// --- Role management (0.93) -------------------------------------------------
//
// Every mutation below that could *reduce* someone's access runs the change and
// then asserts the workspace invariant inside the same transaction, rolling
// back if it no longer holds:
//
//   at least one active person still holds RECOVERY_PERMISSION globally
//
// Apply-then-assert rather than predict-then-apply, deliberately. Predicting
// whether a permission edit strands the workspace means re-implementing the
// resolver in the guard, and any drift between the two is a lockout. Asking the
// database what is true after the change cannot drift.

/** The four rungs of the legacy ladder, mirrored into assignments by a trigger. */
export const LADDER_ROLE_KEYS = ["viewer", "editor", "approver", "admin"];

export type RoleMutationError =
  | "not_found"
  | "builtin"
  | "duplicate"
  | "invalid_permission"
  | "would_orphan"
  | "in_use";

export interface RoleDetail {
  id: number;
  key: string;
  name: string;
  description: string;
  is_builtin: boolean;
  permissions: string[];
}

export interface RoleAssignmentRow {
  id: number;
  role_id: number;
  role_name: string;
  user_id: number | null;
  group_id: number | null;
  subject: string;
  subject_kind: "user" | "group";
  scope_type: string;
  space_id: number | null;
  space_name: string | null;
}

export async function getRoleDetail(id: number): Promise<RoleDetail | null> {
  const rows = await q<RoleDetail>(
    `SELECT r.id, r.key, r.name, r.description, r.is_builtin,
            coalesce(array_agg(rp.permission ORDER BY rp.permission)
                     FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE r.id = $1 GROUP BY r.id`,
    [id]
  );
  return rows[0] ?? null;
}

/** Reject anything not in the shipped catalog before it reaches a role. */
async function validPermissions(keys: string[]): Promise<string[] | null> {
  const { isPermissionKey } = await import("./permissions");
  const clean = [...new Set(keys.map((k) => String(k)))];
  return clean.every(isPermissionKey) ? clean : null;
}

/**
 * Create a custom role, optionally seeded from an existing one. The key is
 * derived from the name and must not collide — including with a built-in key,
 * which would make the ladder trigger start writing assignments for a role that
 * is not a ladder rung.
 */
export async function createRole(input: {
  name: string;
  description?: string;
  permissions: string[];
  copyFromRoleId?: number;
}): Promise<{ id: number } | { error: RoleMutationError }> {
  const name = input.name.trim();
  if (!name) return { error: "duplicate" };
  const key = slugify(name) || `role-${Date.now()}`;

  let want = input.permissions;
  if (input.copyFromRoleId) {
    const src = await getRoleDetail(input.copyFromRoleId);
    if (!src) return { error: "not_found" };
    want = src.permissions;
  }
  const perms = await validPermissions(want);
  if (!perms) return { error: "invalid_permission" };

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT 1 FROM roles WHERE key = $1", [key]);
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return { error: "duplicate" };
    }
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO roles (key, name, description, is_builtin)
       VALUES ($1, $2, $3, false) RETURNING id`,
      [key, name, input.description?.trim() ?? ""]
    );
    const id = rows[0].id;
    if (perms.length) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission)
         SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [id, perms]
      );
    }
    await client.query("COMMIT");
    return { id };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Edit a custom role. Built-in roles are rejected: their permission sets are
 * re-derived from the catalog on every boot, so an edit here would silently
 * revert on the next restart — worse than refusing.
 */
export async function updateRole(
  id: number,
  patch: { name?: string; description?: string; permissions?: string[] }
): Promise<{ ok: true } | { error: RoleMutationError }> {
  const role = await getRoleDetail(id);
  if (!role) return { error: "not_found" };
  if (role.is_builtin) return { error: "builtin" };

  let perms: string[] | null = null;
  if (patch.permissions) {
    perms = await validPermissions(patch.permissions);
    if (!perms) return { error: "invalid_permission" };
  }

  const { countGlobalUserAdmins } = await import("./authz");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    if (patch.name !== undefined || patch.description !== undefined) {
      await client.query(
        "UPDATE roles SET name = coalesce($2, name), description = coalesce($3, description) WHERE id = $1",
        [id, patch.name?.trim() || null, patch.description?.trim() ?? null]
      );
    }
    if (perms) {
      await client.query(
        "DELETE FROM role_permissions WHERE role_id = $1 AND permission <> ALL($2::text[])",
        [id, perms]
      );
      if (perms.length) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [id, perms]
        );
      }
    }
    if ((await countGlobalUserAdmins(client)) === 0) {
      await client.query("ROLLBACK");
      return { error: "would_orphan" };
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteRole(id: number): Promise<{ ok: true } | { error: RoleMutationError }> {
  const role = await getRoleDetail(id);
  if (!role) return { error: "not_found" };
  if (role.is_builtin) return { error: "builtin" };

  const { countGlobalUserAdmins } = await import("./authz");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    // Assignments cascade, which is the point: deleting a role is how you
    // revoke it from everyone at once. The invariant check below is what stops
    // that from being how you lock everyone out at once.
    await client.query("DELETE FROM roles WHERE id = $1", [id]);
    if ((await countGlobalUserAdmins(client)) === 0) {
      await client.query("ROLLBACK");
      return { error: "would_orphan" };
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function listRoleAssignments(roleId?: number): Promise<RoleAssignmentRow[]> {
  return q<RoleAssignmentRow>(
    `SELECT ra.id, ra.role_id, r.name AS role_name, ra.user_id, ra.group_id,
            coalesce(u.name, u.username, g.name, '(removed)') AS subject,
            CASE WHEN ra.user_id IS NOT NULL THEN 'user' ELSE 'group' END AS subject_kind,
            ra.scope_type, ra.space_id, s.name AS space_name
       FROM role_assignments ra
       JOIN roles r ON r.id = ra.role_id
       LEFT JOIN users u ON u.id = ra.user_id
       LEFT JOIN groups g ON g.id = ra.group_id
       LEFT JOIN spaces s ON s.id = ra.space_id
      WHERE $1::int IS NULL OR ra.role_id = $1
      ORDER BY r.is_builtin DESC, r.name, subject_kind, subject`,
    [roleId ?? null]
  );
}

export async function assignRole(input: {
  roleId: number;
  userId?: number;
  groupId?: number;
  spaceId?: number;
}): Promise<{ ok: true } | { error: RoleMutationError }> {
  const role = await getRoleDetail(input.roleId);
  if (!role) return { error: "not_found" };
  if ((input.userId === undefined) === (input.groupId === undefined)) return { error: "not_found" };
  const scope = input.spaceId === undefined ? "global" : "space";
  // Granting can only widen access, so there is no invariant to re-check.
  await q(
    `INSERT INTO role_assignments (role_id, user_id, group_id, scope_type, space_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [input.roleId, input.userId ?? null, input.groupId ?? null, scope, input.spaceId ?? null]
  );
  return { ok: true };
}

/**
 * Revoke one assignment.
 *
 * A built-in role held globally by a user is the ladder's own representation
 * (kept in step by the compass_users_ladder_sync trigger). Deleting that row
 * directly would leave the user with no permissions while `users.role` still
 * says otherwise, and the next boot's backfill would silently put it back —
 * so it is refused here and the user's role is changed in Users & roles
 * instead, which moves both together.
 */
export async function unassignRole(id: number): Promise<{ ok: true } | { error: RoleMutationError }> {
  const rows = await q<{ user_id: number | null; key: string; scope_type: string }>(
    `SELECT ra.user_id, r.key, ra.scope_type
       FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return { error: "not_found" };
  // Only the four LADDER rungs are refused here — those rows are the ladder's
  // own mirror and must move with users.role. The seeded delegated roles are
  // built-in too, but they are ordinary grants and revoking one here is exactly
  // what an admin means to do.
  if (LADDER_ROLE_KEYS.includes(row.key) && row.user_id !== null && row.scope_type === "global") {
    return { error: "in_use" };
  }

  const { countGlobalUserAdmins } = await import("./authz");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM role_assignments WHERE id = $1", [id]);
    if ((await countGlobalUserAdmins(client)) === 0) {
      await client.query("ROLLBACK");
      return { error: "would_orphan" };
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// --- Seeded-role grants (0.94) ---------------------------------------------
//
// The Section access page and the newsletter people picker both edit "who is
// granted this capability", which is now a set of assignments of one seeded
// role. These two helpers are the whole storage layer for that: read the
// subjects, or replace them.

export async function sectionRoleGrants(
  roleKey: string
): Promise<{ users: number[]; groups: number[] }> {
  const rows = await q<{ user_id: number | null; group_id: number | null }>(
    `SELECT ra.user_id, ra.group_id
       FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
      WHERE r.key = $1 AND ra.scope_type = 'global'`,
    [roleKey]
  );
  return {
    users: rows.filter((r) => r.user_id !== null).map((r) => r.user_id as number),
    groups: rows.filter((r) => r.group_id !== null).map((r) => r.group_id as number),
  };
}

/**
 * Replace the subject set for one seeded role, in a single transaction so a
 * half-applied change can't leave someone with access nobody intended.
 *
 * Scoped to this role's own assignments: a person who reaches the same section
 * through a custom role is untouched, because this page did not grant that and
 * has no business revoking it.
 */
export async function setSectionRoleGrants(
  roleKey: string,
  users: number[],
  groups: number[]
): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: number }>("SELECT id FROM roles WHERE key = $1", [
      roleKey,
    ]);
    const roleId = rows[0]?.id;
    if (!roleId) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      `DELETE FROM role_assignments
        WHERE role_id = $1 AND scope_type = 'global'
          AND (user_id IS NOT NULL AND user_id <> ALL($2::int[])
            OR group_id IS NOT NULL AND group_id <> ALL($3::int[]))`,
      [roleId, users, groups]
    );
    if (users.length) {
      await client.query(
        `INSERT INTO role_assignments (role_id, user_id, scope_type)
         SELECT $1, unnest($2::int[]), 'global' ON CONFLICT DO NOTHING`,
        [roleId, users]
      );
    }
    if (groups.length) {
      await client.query(
        `INSERT INTO role_assignments (role_id, group_id, scope_type)
         SELECT $1, unnest($2::int[]), 'global' ON CONFLICT DO NOTHING`,
        [roleId, groups]
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
 * Extra roles each user holds beyond their ladder rung — the custom and seeded
 * roles that Users & roles cannot show from `users.role` alone (0.97).
 *
 * Without this the page states someone's access and is wrong: a Viewer holding
 * "Announcements manager" and a space-scoped "Space editor" renders as plain
 * "Viewer", so an admin auditing access from the obvious page gets the obvious
 * answer and it is incomplete. Returns a map of user id → role labels, deduped,
 * with the space count where a grant is scoped.
 */
export async function extraRolesByUser(): Promise<Map<number, string[]>> {
  const rows = await q<{ user_id: number; name: string; scoped: number }>(
    `SELECT u.id AS user_id, r.name,
            count(*) FILTER (WHERE ra.scope_type = 'space')::int AS scoped
       FROM users u
       JOIN role_assignments ra
         ON ra.user_id = u.id
         OR ra.group_id IN (SELECT group_id FROM group_members WHERE user_id = u.id)
       JOIN roles r ON r.id = ra.role_id
      WHERE NOT (r.is_builtin AND r.key = ANY($1::text[]))
      GROUP BY u.id, r.name
      ORDER BY r.name`,
    [LADDER_ROLE_KEYS]
  );
  const out = new Map<number, string[]>();
  for (const r of rows) {
    const label = r.scoped > 0 ? `${r.name} (${r.scoped} space${r.scoped === 1 ? "" : "s"})` : r.name;
    out.set(r.user_id, [...(out.get(r.user_id) ?? []), label]);
  }
  return out;
}
