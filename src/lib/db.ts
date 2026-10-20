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
  AckPolicy,
  AckSource,
  AckOutcome,
  AckDecision,
  AckOutcomeInfo,
  AckNotice,
  AckNoticeMode,
  AckNoticeKind,
  AckNoticeChannel,
  AckOutboxRow,
} from "./types";
import { changeSummary, suggestReconfirm } from "./diff";
import type { ChangeSummary } from "./diff";
import type { EditDefault } from "./compliance-settings";
import { storedReadSeconds } from "./read-evidence";
import { RECERT_LEDGER_REASON, recertNoticeSentence, nextRecertDate } from "./ack-recert";
import type { RecertFields, RecertPatch } from "./ack-recert";
import { BUILT_IN, DUE_HISTORY_MAX, endOfDayIn, sanitizeLayer } from "./ack-due";
import type { DueRule, PolicyDefaultsLayer } from "./ack-due";
import {
  PA_OPEN,
  audienceAdmitsSql,
  audienceRemovedReasonSql,
  audienceRulesFromJson,
  audienceRulesFromTable,
  audienceSourceSql,
} from "./audience";
import type { AudienceSqlAliases, AudienceNarrowing } from "./audience";
import type { AudienceMode, AudienceRule, PolicySettings } from "./types";

export type { AckPolicy, AckSource, AckOutcome, AckDecision, AckOutcomeInfo } from "./types";
export type { AckNotice, AckNoticeMode, AckNoticeKind, AckNoticeChannel, AckOutboxRow } from "./types";

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
// A plain `date` (1082) stays the 'YYYY-MM-DD' text Postgres sends: pg would
// otherwise hand back a local-midnight Date object. First used by
// documents.ack_effective_at (1.12.0); nothing else in the schema is a date.
types.setTypeParser(1082, (v) => v);

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
    await client.query(guardCreateIndexes(guardAddColumns(SCHEMA_SQL)));
    await syncPresetRoles(client);
    await migrateLadderToAssignments(client);
    await migrateDelegationToAssignments(client);
    // After syncPresetRoles, which is what creates space-member/space-author.
    await migrateSpaceGrantsToAssignments(client);
    await dropLegacySpaceGrantTables(client);
    await migrateVisibilityTiers(client);
    await migrateAckRevisions(client);
    await migrateAckRetention(client);
    await migrateVersionProvenance(client);
    await migrateSecuritySealing(client);
    await migrateWeightedSearch(client);
    await migrateDirectoryRegistry(client);
    await migratePolicyAssignments(client);
    await seedIfEmpty(client);
    await bootstrapAuth(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock(728341)").catch(() => {});
    client.release();
  }
}

/**
 * The catalog predicate the boot guards share: does table `t` (resolved
 * through search_path, exactly as the ALTER it guards resolves it) carry a
 * live column `c`? to_regclass() is NULL for a table that does not exist
 * yet, so the predicate is simply false until CREATE TABLE has run.
 * information_schema.columns was the earlier form; it spans every schema the
 * role can see, so a same-named table in another schema of a shared
 * database made the guard skip the app's own ALTER.
 */
function columnExistsSql(table: string, column: string): string {
  return `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('${table}') AND attname = '${column}' AND attnum > 0 AND NOT attisdropped`;
}

/**
 * Rewrites every `ALTER TABLE t ADD COLUMN IF NOT EXISTS c …;` in the schema
 * into a block that looks the column up first. Postgres takes the table's
 * ACCESS EXCLUSIVE lock before it checks IF NOT EXISTS, so each of those
 * statements locked users, documents and the rest on every boot; a boot that
 * raced a save (two instances, or the integration suite's parallel
 * processes) could deadlock against it (1.10.0 integration logs, and a
 * rolling upgrade with traffic on the old instance). With the lookup first,
 * a later boot touches no table whose columns are already there, and the
 * first boot runs the identical ALTER. The table name and ADD may be
 * separated by a line break (the directory_people pair is written that
 * way). Exported for its unit test.
 */
export function guardAddColumns(sql: string): string {
  return sql.replace(
    /ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)\s+([^;]+);/g,
    (_m, table: string, column: string, definition: string) =>
      `DO $$ BEGIN IF NOT EXISTS (${columnExistsSql(table, column)}) THEN ALTER TABLE ${table} ADD COLUMN ${column} ${definition.replace(/\s+/g, " ").trim()}; END IF; END $$;`
  );
}

/**
 * The sibling for indexes (1.10.1): every `CREATE [UNIQUE] INDEX IF NOT
 * EXISTS name ON …;` becomes the to_regclass block the ack_notices indexes
 * were written with by hand. CREATE INDEX takes a SHARE lock on its table
 * before it checks IF NOT EXISTS, and SHARE conflicts with every INSERT,
 * UPDATE and DELETE for as long as the schema transaction runs, so until
 * now a boot blocked every save on documents, doc_versions, sessions,
 * notifications, audit_log and the rest. The definition may span lines and
 * carry `USING gin(...)` or a `WHERE …` predicate; nothing inside it
 * contains a semicolon. A CREATE INDEX without IF NOT EXISTS (the ones
 * already inside a hand-written block) is left alone. Exported for its unit
 * test; applied after guardAddColumns in initialize().
 */
export function guardCreateIndexes(sql: string): string {
  return sql.replace(
    /CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON\s+([^;]+);/g,
    (_m, unique: string | undefined, name: string, definition: string) =>
      `DO $$ BEGIN IF to_regclass('${name}') IS NULL THEN CREATE ${unique ?? ""}INDEX ${name} ON ${definition.replace(/\s+/g, " ").trim()}; END IF; END $$;`
  );
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
  -- Installs from before the 0.14 tiers carry the old default; SET DEFAULT
  -- takes an exclusive lock on spaces whether or not it changes anything,
  -- so it runs only while the stored default is something else.
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = to_regclass('spaces') AND a.attname = 'visibility'
        AND pg_get_expr(d.adbin, d.adrelid) = '''internal''::text'
    ) THEN
      ALTER TABLE spaces ALTER COLUMN visibility SET DEFAULT 'internal';
    END IF;
  END $$;

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
  -- One person's views of one document, newest first: the read time a
  -- confirmation records (readSecondsSince, C3) and the never-opened probe
  -- (F1) both ask for exactly this.
  CREATE INDEX IF NOT EXISTS idx_views_doc_user ON doc_views(document_id, user_id, viewed_at DESC);

  -- 1.11.0 (A6): the submitter's recommendation for the readers of a confirmed
  -- document ('keep' | 'reset'; 'auto' = none given) and their reason. The
  -- approver decides at approval; both sides land on the decision row.
  -- Placed after the doc_views index on purpose: SCHEMA_SQL is one
  -- transaction, so the exclusive lock these two take on change_requests
  -- (which every app page reads for the review badge) is held for the tail
  -- of the first 1.11.0 boot rather than across the index build above.
  ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS ack_policy text NOT NULL DEFAULT 'auto';
  ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS ack_reason text NOT NULL DEFAULT '';

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

  -- Read confirmations (enterprise "policy_ack"): docs can require readers to
  -- confirm they've read them. The ledger is append-only for compliance. A
  -- confirmation is "current" while acknowledged_at >= the doc's
  -- ack_revision_at (ACK_CURRENT below) — the marker only moves when an
  -- editor asks everyone again (resetAcknowledgements, 1.10.0), never on a
  -- metadata-only save, so updated_at stays the conflict token and nothing else.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_required integer NOT NULL DEFAULT 0;
  -- Spam guard + display for compliance reminders (central portal).
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_last_reminded_at timestamptz;
  -- 1.10.1 (A5): how a policy treats a change to its text. 'ask' opens the
  -- editor's question on every text save, 'material' only when the change
  -- looks material (smaller edits are kept and recorded), 'reset' always asks
  -- everyone again. A document receives the workspace default the first time
  -- it is set to required (setAckRequired). Metadata-only: a default on an
  -- existing column takes no rewrite.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_edit_default text NOT NULL DEFAULT 'ask';
  -- 1.12.0 (C2): the confirmation statement this policy prints on its card
  -- (NULL = the workspace default, compliance_statement_default) and
  -- whether the reader signs with a typed name (a local account also
  -- re-enters its password; an SSO account is identified by its session).
  -- Metadata-only: a constant default on an added column takes no rewrite.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_statement text;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_signature integer NOT NULL DEFAULT 0;
  -- 1.12.0 (G3): retirement. A retired policy keeps every confirmation and
  -- its marker (ack_revision_at / ack_version_id stay put so the final roster
  -- is reproducible from the ledger); ack_required drops to 0 and these five
  -- columns say when, by whom, why and which policy replaced it. Metadata-only.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_retired_at timestamptz;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_retired_by integer REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_retired_by_name text NOT NULL DEFAULT '';
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_retired_reason text NOT NULL DEFAULT '';
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_superseded_by integer REFERENCES documents(id) ON DELETE SET NULL;
  -- Both references SET NULL on delete: removing an account or purging a
  -- replacement looks for the documents that cite it, and without an index
  -- each firing is a sequential scan of documents (idx_documents_ack_version
  -- is the same case). Partial, so the indexes hold only retired rows.
  CREATE INDEX IF NOT EXISTS idx_documents_ack_retired_by ON documents(ack_retired_by) WHERE ack_retired_by IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_documents_ack_superseded_by ON documents(ack_superseded_by) WHERE ack_superseded_by IS NOT NULL;
  -- 1.12.0 (G1): periodic re-confirmation. ack_recert_months NULL = no cycle;
  -- ack_next_recert_at is stored, never derived (set with the interval, moved
  -- by every reset and by the sweep's claim, whose WHERE tests it: see
  -- claimDueRecertifications); ack_effective_at is the day the requirement
  -- was first switched on (setAckRequired). The partial index is the sweep's
  -- only scan. Metadata-only.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_recert_months integer;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_next_recert_at timestamptz;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS ack_effective_at date;
  CREATE INDEX IF NOT EXISTS idx_documents_ack_recert ON documents(ack_next_recert_at) WHERE ack_required = 1 AND ack_recert_months IS NOT NULL;
  CREATE TABLE IF NOT EXISTS acknowledgements (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    acknowledged_at timestamptz NOT NULL DEFAULT now(),
    ip text NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_ack_doc ON acknowledgements(document_id, user_id, acknowledged_at DESC);

  -- 1.10.0: the currency marker. The order of these four statements is
  -- load-bearing: a no-default ADD COLUMN, the backfill from updated_at, and
  -- only THEN the default and NOT NULL. "ADD COLUMN ... DEFAULT now()" in one
  -- statement would stamp upgrade time on every row and mark every existing
  -- confirmation stale. SCHEMA_SQL runs as one implicit transaction, so no
  -- request ever sees a half-migrated table. The whole sequence is guarded on
  -- the column being absent: SET DEFAULT and SET NOT NULL take an exclusive
  -- lock on documents whether or not they change anything, and a boot that
  -- takes it on every start can deadlock against an instance that is saving
  -- a document at that moment (the ALTERs earlier in this transaction already
  -- hold doc_versions). Once the column exists this block touches nothing.
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass('documents') AND attname = 'ack_revision_at' AND attnum > 0 AND NOT attisdropped
    ) THEN
      ALTER TABLE documents ADD COLUMN ack_revision_at timestamptz;
      UPDATE documents SET ack_revision_at = updated_at WHERE ack_revision_at IS NULL;
      ALTER TABLE documents ALTER COLUMN ack_revision_at SET DEFAULT now();
      ALTER TABLE documents ALTER COLUMN ack_revision_at SET NOT NULL;
      -- The version everyone is asked to confirm (the marker's version).
      ALTER TABLE documents ADD COLUMN ack_version_id integer REFERENCES doc_versions(id) ON DELETE SET NULL;
    END IF;
  END $$;
  -- The FK's ON DELETE SET NULL fires once per version row a purge removes;
  -- without this index each firing is a sequential scan of documents.
  CREATE INDEX IF NOT EXISTS idx_documents_ack_version ON documents(ack_version_id);
  -- What each person confirmed: the version row and the SHA-256 of its text.
  -- version_id is a plain integer on purpose (like training's
  -- confirmed_version): a purged document takes its doc_versions rows with it,
  -- and the id must survive so getAttestedVersion() can still resolve it
  -- through attested_texts. Rows from before 1.10.0 get version_id inferred by
  -- migrateAckRevisions() and keep content_sha256 NULL ("version inferred").
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS version_id integer;
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS content_sha256 text;
  CREATE INDEX IF NOT EXISTS idx_ack_user ON acknowledgements(user_id, acknowledged_at DESC);
  -- 1.11.0 reading evidence (C3). read_seconds: how long the document was
  -- open on screen for this person since everyone was last asked, summed on
  -- the server from doc_views at confirmation time and copied here because
  -- doc_views is not retained with the document (NULL when no view was
  -- recorded, and on every row from before 1.11.0). reached_end: the card's
  -- self-reported latch (use-reached-end.ts), 1 or 0, never trusted for time.
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS read_seconds integer;
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS reached_end integer NOT NULL DEFAULT 0;
  -- 1.12.0 (C2): what the person agreed to and how they were identified.
  -- statement_text is the confirmation statement the server served when
  -- the row was written (the policy's own, else the workspace default at
  -- that moment; never the client's text; '' on rows from before 1.12.0).
  -- signed_name is the typed name when the policy required a signature
  -- (NULL on an unsigned row); identity_proof is 'password' (a local
  -- account re-entered it), 'sso_session' or 'typed_name_only' on a signed
  -- row and '' otherwise; user_agent is the first 300 characters of the
  -- browser's header ('' when unknown). Metadata-only, like the pair above.
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS statement_text text NOT NULL DEFAULT '';
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS signed_name text;
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS identity_proof text NOT NULL DEFAULT '';
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS user_agent text NOT NULL DEFAULT '';

  -- 1.10.0 retention: attestation records outlive the person and the policy.
  -- Metadata-only here; the ON DELETE SET NULL swap and the snapshot backfill
  -- run once in migrateAckRetention() (NOT VALID + VALIDATE, no write stall).
  -- 1.9.x's INSERT (document_id, user_id, ip) stays valid against nullable
  -- columns and its queries JOIN users/documents, so a rollback simply stops
  -- showing rows whose person or policy is gone.
  -- Guarded for the same reason as the marker block above: DROP NOT NULL
  -- takes an exclusive lock on the ledger on every boot otherwise.
  DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass('acknowledgements') AND attname = 'user_id' AND attnum > 0 AND NOT attisdropped AND attnotnull
    ) THEN
      ALTER TABLE acknowledgements ALTER COLUMN user_id DROP NOT NULL;
      ALTER TABLE acknowledgements ALTER COLUMN document_id DROP NOT NULL;
    END IF;
  END $$;
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS user_name text NOT NULL DEFAULT '';
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS user_email text NOT NULL DEFAULT '';
  ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS document_title text NOT NULL DEFAULT '';
  -- The words a hash was taken over, kept when a policy is purged from the
  -- Trash: every doc_versions row cited by a confirmation or a marker is copied
  -- here first (archiveAttestedTexts). No FK to doc_versions on purpose.
  CREATE TABLE IF NOT EXISTS attested_texts (
    version_id integer PRIMARY KEY,
    document_id integer,
    document_title text NOT NULL DEFAULT '',
    title text NOT NULL DEFAULT '',
    content text NOT NULL DEFAULT '',
    content_sha256 text NOT NULL DEFAULT '',
    author text NOT NULL DEFAULT '',
    version_created_at timestamptz,
    archived_at timestamptz NOT NULL DEFAULT now()
  );

  -- 1.10.0 decision ledger (C1): every time the text of a confirmed document
  -- changed, who decided whether everyone is asked again ('reset') or the
  -- confirmations stand ('kept'), why, and how many people it touched. Both
  -- outcomes are rows, because the keep is the decision an auditor questions.
  -- Relaxed FKs and name/title snapshots from day one so the row outlives the
  -- person and the policy; version_id is a plain integer like
  -- acknowledgements.version_id (a purge takes doc_versions with it and the
  -- id must survive to reach attested_texts). No backfill: the ledger starts
  -- at upgrade. Written only by resetAcknowledgements / keepAcknowledgements.
  CREATE TABLE IF NOT EXISTS ack_decisions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer REFERENCES documents(id) ON DELETE SET NULL,
    document_title text NOT NULL DEFAULT '',
    version_id integer,
    outcome text NOT NULL,
    decided_at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL,
    scope text NOT NULL DEFAULT 'all',
    decided_by integer REFERENCES users(id) ON DELETE SET NULL,
    decided_by_name text NOT NULL DEFAULT '',
    submitted_policy text NOT NULL DEFAULT '',
    submitted_by integer REFERENCES users(id) ON DELETE SET NULL,
    submitted_by_name text NOT NULL DEFAULT '',
    reason text NOT NULL DEFAULT '',
    suggested text NOT NULL DEFAULT '',
    overrode_suggestion integer NOT NULL DEFAULT 0,
    change_pct numeric(5,1),
    change_json text,
    confirmations_affected integer,
    eligible integer,
    notified_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_ack_decisions_doc ON ack_decisions(document_id, decided_at DESC);
  -- Both person FKs are ON DELETE SET NULL; indexed so deleting an account
  -- is not a scan of the ledger.
  CREATE INDEX IF NOT EXISTS idx_ack_decisions_decided_by ON ack_decisions(decided_by);
  CREATE INDEX IF NOT EXISTS idx_ack_decisions_submitted_by ON ack_decisions(submitted_by);

  -- 1.10.1 version provenance (C6): who published a version and, through a
  -- change request, who approved it, as data next to the version a reader
  -- confirmed rather than as note text. Stamped by createDocument,
  -- updateDocument and approveChangeRequest; rows from before 1.10.1 are
  -- filled once by migrateVersionProvenance() (name from author, approver
  -- from the legacy note suffix). Person FKs are ON DELETE SET NULL with
  -- name snapshots, indexed so deleting an account is not a scan of
  -- doc_versions. Guarded like the marker block: ADD COLUMN IF NOT EXISTS
  -- takes an exclusive lock on doc_versions before it looks, and a boot
  -- that takes it on every start can deadlock against a request
  -- transaction that already holds a lock the boot wants next (a save
  -- writes documents then doc_versions, in the same order as this file,
  -- so it waits rather than deadlocks; a transaction that writes users,
  -- sessions or audit_log first and documents second is the real partner).
  -- Once the column exists this block touches nothing.
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass('doc_versions') AND attname = 'published_by' AND attnum > 0 AND NOT attisdropped
    ) THEN
      ALTER TABLE doc_versions ADD COLUMN published_by integer REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE doc_versions ADD COLUMN published_by_name text NOT NULL DEFAULT '';
      ALTER TABLE doc_versions ADD COLUMN approved_by integer REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE doc_versions ADD COLUMN approved_by_name text NOT NULL DEFAULT '';
      ALTER TABLE doc_versions ADD COLUMN change_request_id integer;
      CREATE INDEX idx_doc_versions_published_by ON doc_versions(published_by);
      CREATE INDEX idx_doc_versions_approved_by ON doc_versions(approved_by);
    END IF;
  END $$;

  -- 1.10.1 per-person notice log (E3): one append-only row per recipient of
  -- every read-confirmation request, reminder, re-confirmation notice,
  -- escalation or digest, with the channels that actually went out
  -- ('email' only when the server accepted the mail). Written by one helper
  -- (recordNotices in lib/compliance) from the outbox drain, never by a
  -- route. Relaxed FKs and name/title snapshots so the row outlives the
  -- person and the policy; the second index is H1's coalescing key ("no
  -- 'updated' notice for this person and document in the last 24 hours").
  CREATE TABLE IF NOT EXISTS ack_notices (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    user_name text NOT NULL DEFAULT '',
    user_email text NOT NULL DEFAULT '',
    document_id integer REFERENCES documents(id) ON DELETE SET NULL,
    document_title text NOT NULL DEFAULT '',
    kind text NOT NULL,
    channels jsonb NOT NULL DEFAULT '[]'::jsonb,
    sent_at timestamptz NOT NULL DEFAULT now(),
    by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
    by_name text NOT NULL DEFAULT 'system',
    outbox_id integer
  );
  -- The indexes are created with the table, guarded: CREATE INDEX IF NOT
  -- EXISTS takes a share lock on the table before it looks, and a boot that
  -- holds one on ack_outbox while a save's transaction (documents,
  -- doc_versions, ack_decisions, then ack_outbox) waits for it, and then
  -- itself waits for documents, is a deadlock. A guarded block locks
  -- nothing once the index exists.
  DO $$ BEGIN
    IF to_regclass('idx_ack_notices_user') IS NULL THEN
      CREATE INDEX idx_ack_notices_user ON ack_notices(user_id, sent_at DESC);
      CREATE INDEX idx_ack_notices_doc_user_kind ON ack_notices(document_id, user_id, kind, sent_at DESC);
      CREATE INDEX idx_ack_notices_by_user ON ack_notices(by_user_id);
    END IF;
  END $$;

  -- 1.10.1 notification outbox (H4): every read-confirmation fan-out is a
  -- row here, claimed by the minute tick (FOR UPDATE SKIP LOCKED, so every
  -- instance may drain), delivered by notifyAckRequest, retried after a
  -- 10-minute reclaim up to three attempts. Nothing on a request path sends
  -- mail. user_ids NULL = everyone pending at delivery time. A row goes
  -- with its document (CASCADE): the per-person record is ack_notices.
  CREATE TABLE IF NOT EXISTS ack_outbox (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer REFERENCES documents(id) ON DELETE CASCADE,
    mode text NOT NULL,
    source text NOT NULL DEFAULT '',
    reason text NOT NULL DEFAULT '',
    actor_id integer,
    actor_name text NOT NULL DEFAULT '',
    user_ids jsonb,
    not_before timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    done_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    emailed integer,
    noticed integer,
    error text
  );
  -- The sending request's origin (1.10.1): the drain runs from a timer with
  -- no request to take one from, so the origin travels with the row and a
  -- workspace without custom_domain still mails absolute links. Nothing is
  -- remembered across requests. guardAddColumns rewrites this statement.
  ALTER TABLE ack_outbox ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT '';
  -- 1.13.0 (E2): what a sweep hands the drain beside the recipient list. A
  -- 'due' row carries each person's due date and whether it is past; an
  -- 'escalation' row the overdue people, the threshold in days and who is
  -- told through which role. NULL on every other row; a 1.12.0 binary
  -- ignores it. guardAddColumns rewrites this statement.
  ALTER TABLE ack_outbox ADD COLUMN IF NOT EXISTS payload jsonb;
  DO $$ BEGIN
    IF to_regclass('idx_ack_outbox_due') IS NULL THEN
      CREATE INDEX idx_ack_outbox_due ON ack_outbox(done_at, not_before);
    END IF;
  END $$;

  -- 1.13.0 audiences (D1): who must confirm a policy, as materialised rows.
  -- policy_settings is the per-policy audience and deadline configuration
  -- (one row per policy, inserted by setAckRequired / the migration, healed
  -- by reconcileAllPolicies); policy_audience_rules the include / exclude
  -- rules of 'targeted' mode; policy_assignments one row per person the
  -- policy currently asks (open), asked and excused (exempt_at), or asked
  -- and then no longer (removed_at: kept as history, never deleted; the
  -- same row re-opens when the person returns). The acknowledgements ledger
  -- is untouched: a row here says who OWES a confirmation, never who gave
  -- one. Metadata-only and rollback-safe: a 1.12.0 binary ignores all three.
  -- The E1 deadline (due_days | due_at), the E2 reminder cadence and the
  -- owner live on policy_settings; the per-person clock on the assignment.
  CREATE TABLE IF NOT EXISTS policy_settings (
    document_id integer PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    audience_mode text NOT NULL DEFAULT 'space',
    assign_new_members integer NOT NULL DEFAULT 1,
    exclude_stewards integer NOT NULL DEFAULT 0,
    owner_user_id integer REFERENCES users(id) ON DELETE SET NULL,
    due_days integer,
    due_at date,
    remind_before_days integer,
    remind_every_days integer,
    escalate_after_days integer,
    nudge_every_days integer,
    requested_by integer REFERENCES users(id) ON DELETE SET NULL,
    requested_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS policy_audience_rules (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    kind text NOT NULL,
    ref text NOT NULL,
    effect text NOT NULL DEFAULT 'include',
    UNIQUE (document_id, kind, ref, effect)
  );
  CREATE INDEX IF NOT EXISTS idx_policy_rules_doc ON policy_audience_rules(document_id);
  CREATE TABLE IF NOT EXISTS policy_assignments (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source text NOT NULL DEFAULT 'space',
    assigned_at timestamptz NOT NULL DEFAULT now(),
    cycle_started_at timestamptz NOT NULL DEFAULT now(),
    due_at timestamptz,
    due_history jsonb NOT NULL DEFAULT '[]',
    reminded_at timestamptz,
    reminder_count integer NOT NULL DEFAULT 0,
    escalated_at timestamptz,
    snoozed_until timestamptz,
    snoozed_by integer,
    exempt_at timestamptz,
    exempt_by integer,
    exempt_by_name text NOT NULL DEFAULT '',
    exempt_reason text NOT NULL DEFAULT '',
    exempt_until timestamptz,
    removed_at timestamptz,
    removed_reason text NOT NULL DEFAULT '',
    UNIQUE (document_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_policy_assign_user ON policy_assignments(user_id, due_at);
  CREATE INDEX IF NOT EXISTS idx_policy_assign_doc_exempt ON policy_assignments(document_id, exempt_at);
  CREATE INDEX IF NOT EXISTS idx_policy_assign_due ON policy_assignments(due_at) WHERE exempt_at IS NULL AND removed_at IS NULL;

  -- 1.13.0 deadlines (E1): the space layer of the defaults cascade
  -- (policy_settings -> spaces.policy_defaults -> ack_defaults -> built-in).
  -- Any subset of {due_days, new_joiner_days, overdue_grace_days,
  -- remind_before_days, remind_every_days, escalate_after_days,
  -- nudge_every_days, owner_user_id}; a key absent means inherit
  -- (lib/ack-due). Metadata-only: a 1.12.0 binary never reads it.
  ALTER TABLE spaces ADD COLUMN IF NOT EXISTS policy_defaults jsonb NOT NULL DEFAULT '{}';

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
  -- Each step is guarded on the catalog (1.10.1): DROP NOT NULL and the
  -- constraint swap take an exclusive lock on the history table, and ADD
  -- FOREIGN KEY a share-row-exclusive lock on users / training_decks plus a
  -- validation scan, on every boot otherwise. A fresh table starts NOT NULL
  -- with CASCADE FKs (the CREATE TABLE above), so the first boot still
  -- runs every step; a later boot finds nothing to do.
  DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass('training_completion_history') AND attname = 'user_id' AND attnum > 0 AND NOT attisdropped AND attnotnull
    ) THEN
      ALTER TABLE training_completion_history ALTER COLUMN user_id DROP NOT NULL;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass('training_completion_history') AND attname = 'deck_id' AND attnum > 0 AND NOT attisdropped AND attnotnull
    ) THEN
      ALTER TABLE training_completion_history ALTER COLUMN deck_id DROP NOT NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('training_completion_history')
        AND conname = 'training_completion_history_user_id_fkey' AND contype = 'f' AND confdeltype = 'n'
    ) THEN
      ALTER TABLE training_completion_history
        DROP CONSTRAINT IF EXISTS training_completion_history_user_id_fkey;
      ALTER TABLE training_completion_history
        ADD CONSTRAINT training_completion_history_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('training_completion_history')
        AND conname = 'training_completion_history_deck_id_fkey' AND contype = 'f' AND confdeltype = 'n'
    ) THEN
      ALTER TABLE training_completion_history
        DROP CONSTRAINT IF EXISTS training_completion_history_deck_id_fkey;
      ALTER TABLE training_completion_history
        ADD CONSTRAINT training_completion_history_deck_id_fkey
        FOREIGN KEY (deck_id) REFERENCES training_decks(id) ON DELETE SET NULL;
    END IF;
  END $$;
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
  -- Per-user interface scale (compact | default | large | larger), a multiplier
  -- on the fluid root size (globals.css --ui-scale).
  ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_scale text NOT NULL DEFAULT 'default';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS single_key_shortcuts boolean NOT NULL DEFAULT true;

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

  -- (Placed after users and documents, which it references. 1.1.0 declared
  -- it earlier in this file, which worked on every existing database and
  -- failed on a fresh one -- the 1.1.1 fix.)
  -- Image upload tickets (1.1): the handoff for "put this screenshot in the
  -- doc" when the picture only exists in someone's chat window.
  --
  -- An MCP client cannot send us that image. A screenshot pasted into a
  -- conversation reaches the model as vision input, not as a file it can read
  -- back byte for byte, so add_image's base64 argument is unfillable for the
  -- single most common request. (Even when the bytes ARE available the
  -- argument is the wrong pipe: base64 inflates by a third, and a 300 KB
  -- screenshot is ~400,000 characters in one tool call.)
  --
  -- So the model asks for a ticket instead and hands the human a link. Tickets
  -- are single-use and short-lived: one image, then consumed. The token is the
  -- only credential the drop page needs, which is why it is long, why it
  -- expires, and why used_at is set in the same statement that claims it.
  CREATE TABLE IF NOT EXISTS image_upload_tickets (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token text NOT NULL UNIQUE,
    document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_by integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Where the markdown goes once the file lands, if anywhere.
    insert_mode text NOT NULL DEFAULT 'none',
    alt text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    attachment_id integer
  );
  CREATE INDEX IF NOT EXISTS idx_image_tickets_doc ON image_upload_tickets(document_id);

  -- --- Directory registry (1.2) ----------------------------------------------
  --
  -- directory_fields stops being "a label plus a Graph path" and becomes the
  -- directory's schema. Built-in columns (title, department, office, assistant)
  -- are seeded as rows with builtin = 1 so the same machinery -- options with
  -- an admin-defined order, value maps, mappings, group-by -- reaches them.
  --   kind          text | choice | people
  --   multi         a choice/people field can hold several values
  --   group_by      offered in the directory's "Group by" menu
  --   options       ordered [{value, label, matches[], color, hidden}]
  --   value_format  raw | label | code_label  (how a value with an option shows)
  --   show_with     render this field's chips beside another field's value
  --   highlight     chips in the accent colour (existing tag fields keep it)
  --   inverse_label people fields: the label on the other end ("Assists")
  --   mappings      {microsoft?: Mapping, google?: Mapping} -- see
  --                 directory-mapping.ts. graph_path/google_path stay as the
  --                 legacy single-property form the older overlay reads.
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS multi integer NOT NULL DEFAULT 0;
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS group_by integer NOT NULL DEFAULT 0;
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS builtin integer NOT NULL DEFAULT 0;
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS value_format text NOT NULL DEFAULT 'raw';
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS show_with text NOT NULL DEFAULT '';
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS highlight integer NOT NULL DEFAULT 0;
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS inverse_label text NOT NULL DEFAULT '';
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS link_direction text NOT NULL DEFAULT 'out';
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS mappings jsonb NOT NULL DEFAULT '{}'::jsonb;

  -- Two layers per person. synced = what the provider's mappings produced on
  -- the last run, replaced wholesale each sync; custom = what an admin typed,
  -- which no sync ever writes. The effective value is custom over synced, per
  -- key. provider_record is the raw user object the provider returned (minus
  -- the photo), so a mapping can be previewed and re-applied without another
  -- sync. pin_order is admin-owned like hidden: never named in the upsert.
  ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS synced jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS provider_record jsonb;
  ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS pin_order integer;
  -- 1.3: the 48px thumbnail stays in photo (every list row carries it); a
  -- 240px copy for profiles and contact cards lives apart so listing the
  -- directory never ships it. A field can be a date, and a date can mean
  -- something (start date, birthday) -- see directory-display milestones.
  ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS photo_large text NOT NULL DEFAULT '';
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS date_role text NOT NULL DEFAULT '';
  ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'everyone';

  -- People-kind fields: a relation between two rows, queried from both ends,
  -- owned by whoever wrote it. The old single assistant_id is folded in here by
  -- migrateDirectoryRegistry and no longer read.
  CREATE TABLE IF NOT EXISTS directory_person_links (
    person_id integer NOT NULL REFERENCES directory_people(id) ON DELETE CASCADE,
    field_key text NOT NULL,
    target_id integer NOT NULL REFERENCES directory_people(id) ON DELETE CASCADE,
    source text NOT NULL DEFAULT 'manual',
    sort integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, field_key, target_id),
    CHECK (person_id <> target_id)
  );
  CREATE INDEX IF NOT EXISTS idx_directory_links_target
    ON directory_person_links(target_id, field_key);

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

  -- The trigger is created once (1.10.1): DROP TRIGGER takes an exclusive
  -- lock on users and CREATE TRIGGER a share-row-exclusive one, on every
  -- boot otherwise. The function it calls is CREATE OR REPLACE'd above, so
  -- a change to the function reaches the existing trigger without
  -- recreating it; a change to the trigger's own definition (its events)
  -- needs a new name or a one-shot migration.
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('users') AND tgname = 'compass_users_ladder_sync'
    ) THEN
      CREATE TRIGGER compass_users_ladder_sync
        AFTER INSERT OR UPDATE OF role ON users
        FOR EACH ROW EXECUTE FUNCTION compass_sync_ladder_assignment();
    END IF;
  END $$;
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
 * Directory registry migrations (1.2). Every step is idempotent, and the two
 * that would otherwise re-run on every boot -- folding assistant_id into the
 * links table, splitting synced values out of custom -- are recorded in the
 * settings table, because both copy data that an admin may then legitimately
 * delete; re-running them at the next restart would resurrect it.
 */
const DIRECTORY_RESERVED_KEYS = [
  "name", "title", "department", "email", "phone", "mobile", "office",
  "assistant", "assists", "photo", "hidden", "source", "id", "manager", "reports",
];
const DIRECTORY_BUILTIN_FIELDS: {
  key: string; label: string; kind: string; multi: number; group_by: number; inverse_label: string; sort: number;
}[] = [
  { key: "title", label: "Title", kind: "text", multi: 0, group_by: 1, inverse_label: "", sort: -40 },
  { key: "department", label: "Department", kind: "text", multi: 0, group_by: 1, inverse_label: "", sort: -30 },
  { key: "office", label: "Office", kind: "text", multi: 0, group_by: 1, inverse_label: "", sort: -20 },
  { key: "assistant", label: "Assistant", kind: "people", multi: 1, group_by: 0, inverse_label: "Assists", sort: -10 },
  // 1.3.3: the org chart's edge. One manager per person; the inverse is the team.
  { key: "manager", label: "Reports to", kind: "people", multi: 0, group_by: 0, inverse_label: "Direct reports", sort: -5 },
];

async function migrateDirectoryRegistry(client: import("pg").PoolClient) {
  const doneRow = await client.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'directory_migrations'"
  );
  const done = new Set<string>(
    (() => {
      try {
        const parsed = JSON.parse(doneRow.rows[0]?.value ?? "[]");
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    })()
  );
  const markDone = async (step: string) => {
    done.add(step);
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('directory_migrations', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify([...done])]
    );
  };

  // A custom field that happens to be keyed like a built-in column would shadow
  // it the moment the built-in row exists. Rename it (and its values) instead
  // of refusing to boot.
  const clashes = await client.query<{ id: number; key: string }>(
    "SELECT id, key FROM directory_fields WHERE builtin = 0 AND key = ANY($1::text[])",
    [DIRECTORY_RESERVED_KEYS]
  );
  for (const row of clashes.rows) {
    const next = `${row.key}_custom`;
    console.warn(`[db] directory field "${row.key}" collides with a built-in column; renaming to "${next}"`);
    await client.query("UPDATE directory_fields SET key = $2 WHERE id = $1", [row.id, next]);
    for (const col of ["custom", "synced"]) {
      await client.query(
        `UPDATE directory_people SET ${col} = (${col} - $1::text) || jsonb_build_object($2::text, ${col}->$1::text)
         WHERE ${col} ? $1::text`,
        [row.key, next]
      );
    }
  }

  for (const f of DIRECTORY_BUILTIN_FIELDS) {
    await client.query(
      `INSERT INTO directory_fields (key, label, graph_path, google_path, show_in_card, sort, display, kind, multi, group_by, builtin, inverse_label)
       VALUES ($1, $2, '', '', 0, $3, 'field', $4, $5, $6, 1, $7)
       ON CONFLICT (key) DO UPDATE SET builtin = 1`,
      [f.key, f.label, f.sort, f.kind, f.multi, f.group_by, f.inverse_label]
    );
  }

  if (!done.has("links_v1")) {
    const moved = await client.query(
      `INSERT INTO directory_person_links (person_id, field_key, target_id, source, sort)
       SELECT id, 'assistant', assistant_id, 'manual', 0 FROM directory_people
       WHERE assistant_id IS NOT NULL AND assistant_id <> id
       ON CONFLICT DO NOTHING`
    );
    if (moved.rowCount) console.log(`[db] directory: folded ${moved.rowCount} assistant link(s) into directory_person_links`);
    await markDone("links_v1");
  }

  if (!done.has("synced_v1")) {
    // Values the old sync wrote into custom for mapped keys belong in the synced
    // layer, or they would shadow every future sync as "manual overrides".
    const mapped = await client.query<{ key: string }>(
      "SELECT key FROM directory_fields WHERE builtin = 0 AND (graph_path <> '' OR google_path <> '')"
    );
    const keys = mapped.rows.map((r) => r.key);
    if (keys.length) {
      const res = await client.query(
        `UPDATE directory_people
            SET synced = synced || COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(custom) AS e WHERE e.key = ANY($1::text[])), '{}'::jsonb),
                custom = custom - $1::text[]
          WHERE source <> 'manual' AND custom ?| $1::text[]`,
        [keys]
      );
      if (res.rowCount) console.log(`[db] directory: moved mapped values into the synced layer for ${res.rowCount} people`);
    }
    await markDone("synced_v1");
  }

  if (!done.has("manager_mappings_v1")) {
    // Reports to fills itself from the identity system unless an admin says
    // otherwise: Graph's manager relationship, Google's manager relation.
    // Seeded once, so clearing the mapping under Fields sticks.
    await client.query(
      `UPDATE directory_fields
          SET mappings = '{"microsoft":{"kind":"path","path":"manager.mail"},"google":{"kind":"path","path":"relations[manager].value"}}'::jsonb,
              graph_path = 'manager.mail', google_path = 'relations[manager].value'
        WHERE key = 'manager' AND builtin = 1 AND mappings = '{}'::jsonb AND graph_path = '' AND google_path = ''`
    );
    await markDone("manager_mappings_v1");
  }

  if (!done.has("tag_highlight_v1")) {
    // Chips default to neutral from 1.2; fields that were tags before keep the
    // accent so nothing on an existing workspace changes colour.
    await client.query("UPDATE directory_fields SET highlight = 1 WHERE display = 'tag' AND builtin = 0");
    await markDone("tag_highlight_v1");
  }
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
 * One-shot backfill for the 1.10.0 confirmation marker (A1). SCHEMA_SQL has
 * already added the columns and copied updated_at into ack_revision_at (that
 * part is atomic and must be); this stamps the row-level evidence that can be
 * inferred for rows written before 1.10.0:
 *
 *   - documents.ack_version_id = the newest version (what everyone is asked
 *     to confirm from now on);
 *   - acknowledgements.version_id = the newest version that existed when the
 *     person confirmed. content_sha256 stays NULL, which is how every surface
 *     tells an inferred row ("version inferred") from a recorded one.
 *
 * The documents half runs on every boot: it only touches rows without a
 * marker version, and a document created while the workspace was rolled
 * back to 1.9.x (whose createDocument writes no stamp) must get one when
 * 1.10 boots again. The confirmation inference stays one-shot behind the
 * settings flag, so a tenant that later edits documents never has its
 * ledger re-inferred underneath it; ack_marker_schema tells support the
 * tenant has been through it.
 */
async function migrateAckRevisions(client: import("pg").PoolClient) {
  const docs = await client.query(
    `UPDATE documents d
     SET ack_version_id = (SELECT MAX(v.id) FROM doc_versions v WHERE v.document_id = d.id)
     WHERE d.ack_version_id IS NULL
       AND EXISTS (SELECT 1 FROM doc_versions v WHERE v.document_id = d.id)`
  );
  const done = await client.query("SELECT 1 FROM settings WHERE key = 'migrated_ack_revisions'");
  if (done.rowCount) {
    if (docs.rowCount) {
      console.log(`[ack] stamped the confirmation marker on ${docs.rowCount} document(s) created without one`);
    }
    return;
  }
  const acks = await client.query(
    `UPDATE acknowledgements a SET version_id = (
       SELECT v.id FROM doc_versions v
       WHERE v.document_id = a.document_id AND v.created_at <= a.acknowledged_at
       ORDER BY v.created_at DESC, v.id DESC LIMIT 1
     )
     WHERE a.version_id IS NULL AND a.document_id IS NOT NULL`
  );
  await client.query(
    "INSERT INTO settings (key, value) VALUES ('migrated_ack_revisions','1') ON CONFLICT (key) DO NOTHING"
  );
  await client.query(
    "INSERT INTO settings (key, value) VALUES ('ack_marker_schema','1') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
  );
  console.log(
    `[ack] stamped the confirmation marker on ${docs.rowCount ?? 0} document(s) and inferred the version on ${acks.rowCount ?? 0} earlier confirmation(s)`
  );
}

/**
 * One-shot retention migration (C5): the attestation ledger stops cascading
 * away with its person or policy. The FKs are swapped to ON DELETE SET NULL
 * as NOT VALID and then VALIDATEd (SHARE UPDATE EXCLUSIVE, so a years-deep
 * table is checked without blocking writes), and every row gets the
 * name/email/title snapshots the live queries fall back to once the join
 * target is gone. Guarded like migrateVisibilityTiers; ack_retention_schema
 * tells support the tenant has been through it.
 */
async function migrateAckRetention(client: import("pg").PoolClient) {
  const done = await client.query("SELECT 1 FROM settings WHERE key = 'migrated_ack_retention'");
  if (done.rowCount) return;
  for (const [column, target] of [
    ["user_id", "users"],
    ["document_id", "documents"],
  ] as const) {
    const name = `acknowledgements_${column}_fkey`;
    // The swap is one short transaction, so the table is never without the
    // constraint: during a rolling upgrade a 1.9.x instance still serving
    // could otherwise delete a person or purge a policy in the gap and leave
    // orphan rows that make VALIDATE fail and wedge every later boot.
    // VALIDATE runs outside it, under SHARE UPDATE EXCLUSIVE, so writes are
    // not blocked while a years-deep table is checked.
    await client.query("BEGIN");
    try {
      await client.query(`ALTER TABLE acknowledgements DROP CONSTRAINT IF EXISTS ${name}`);
      await client.query(
        `ALTER TABLE acknowledgements ADD CONSTRAINT ${name}
           FOREIGN KEY (${column}) REFERENCES ${target}(id) ON DELETE SET NULL NOT VALID`
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
    // A stray row (a hand edit, or an older instance that slipped through)
    // must not wedge the boot either: the record stays, its dead link goes.
    await client.query(
      `UPDATE acknowledgements a SET ${column} = NULL
       WHERE a.${column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${target} t WHERE t.id = a.${column})`
    );
    await client.query(`ALTER TABLE acknowledgements VALIDATE CONSTRAINT ${name}`);
  }
  const people = await client.query(
    `UPDATE acknowledgements a SET user_name = u.name, user_email = u.email
     FROM users u WHERE u.id = a.user_id AND a.user_name = ''`
  );
  const titles = await client.query(
    `UPDATE acknowledgements a SET document_title = d.title
     FROM documents d WHERE d.id = a.document_id AND a.document_title = ''`
  );
  await client.query(
    "INSERT INTO settings (key, value) VALUES ('migrated_ack_retention','1') ON CONFLICT (key) DO NOTHING"
  );
  await client.query(
    "INSERT INTO settings (key, value) VALUES ('ack_retention_schema','1') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
  );
  console.log(
    `[ack] attestation records now outlive their person and policy; snapshotted ${people.rowCount ?? 0} name(s) and ${titles.rowCount ?? 0} title(s)`
  );
}

/**
 * The row-rewriting half of the C6 provenance backfill: published_by_name
 * from the version's author for every row that lacks one, approved_by_name
 * from the fixed note suffix approveChangeRequest wrote before 1.10.1
 * ("{note} — approved by {name}" or "Approved by {name}") where present.
 * Only blank names are touched, so running it twice changes nothing; the
 * ids stay null (a name is not an account). Exported for the test; the boot
 * calls it once through migrateVersionProvenance.
 */
export async function backfillVersionProvenance(
  client: Queryable
): Promise<{ published: number; approved: number }> {
  const published = await client.query(
    "UPDATE doc_versions SET published_by_name = author WHERE published_by_name = '' AND author <> ''"
  );
  const approved = await client.query(
    `UPDATE doc_versions
     SET approved_by_name = COALESCE(
           substring(note from ' — approved by (.+)$'),
           substring(note from '^Approved by (.+)$'))
     WHERE approved_by_name = ''
       AND (note ~ ' — approved by .+$' OR note ~ '^Approved by .+$')`
  );
  return { published: published.rowCount ?? 0, approved: approved.rowCount ?? 0 };
}

/**
 * One-shot provenance backfill (1.10.1, C6), guarded like migrateAckRetention:
 * the names a version can tell from what it already holds, so the AckCard
 * and the record can say "published by Dana · approved by Priya" for
 * versions written before the columns existed. Rows that carry no legacy
 * approval note stay blank; the docs say provenance is recorded from the
 * upgrade onward.
 */
async function migrateVersionProvenance(client: import("pg").PoolClient) {
  const done = await client.query("SELECT 1 FROM settings WHERE key = 'migrated_version_provenance'");
  if (done.rowCount) return;
  const n = await backfillVersionProvenance(client);
  await client.query(
    "INSERT INTO settings (key, value) VALUES ('migrated_version_provenance','1') ON CONFLICT (key) DO NOTHING"
  );
  console.log(
    `[ack] version provenance backfilled: ${n.published} publisher name(s) and ${n.approved} approver name(s)`
  );
}

/**
 * One-shot audience migration (1.13.0, D1), guarded like
 * migrateVersionProvenance: every policy that requires confirmation or was
 * retired gets its policy_settings row (space mode, the defaults) and one
 * policy_assignments row per person who owed it under 1.12.0's rule (an
 * active account that can see the space), with the row's cycle dated from
 * the document marker and source 'space', so every confirmation that was
 * current stays current and no count moves on the upgrade boot
 * (test/ack-boot.test.ts proves the KPI sums and each roster identical
 * before and after). Trashed and paused policies are included, so a
 * restore or a republish finds its audience as it was. A policy switched
 * on later by a rolled-back 1.12.0 binary is healed by the hourly sweep.
 * Exported for test/ack-audience.test.ts, which runs it inside a rolled-back
 * transaction; the boot calls it once.
 */
export async function migratePolicyAssignments(client: Queryable) {
  const done = await client.query("SELECT 1 FROM settings WHERE key = 'policy_assignments_migrated'");
  if (done.rowCount) return;
  const settings = await client.query(
    `INSERT INTO policy_settings (document_id)
     SELECT d.id FROM documents d WHERE d.ack_required = 1 OR d.ack_retired_at IS NOT NULL
     ON CONFLICT (document_id) DO NOTHING`
  );
  const rows = await client.query(
    `INSERT INTO policy_assignments (document_id, user_id, source, cycle_started_at)
     SELECT d.id, u.id, 'space', d.ack_revision_at
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     JOIN users u ON ${ACK_ELIGIBLE}
     WHERE d.ack_required = 1 OR d.ack_retired_at IS NOT NULL
     ON CONFLICT (document_id, user_id) DO NOTHING`
  );
  await client.query(
    "INSERT INTO settings (key, value) VALUES ('policy_assignments_migrated','1') ON CONFLICT (key) DO NOTHING"
  );
  console.log(
    `[ack] policy audiences materialised: ${settings.rowCount ?? 0} policy setting row(s) and ${rows.rowCount ?? 0} assignment(s)`
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

export async function listSpaces(
  scope: SpaceScope
): Promise<(Space & { doc_count: number; last_activity: string | null })[]> {
  const filter = Array.isArray(scope) ? " WHERE s.id = ANY($1)" : "";
  return q(
    `SELECT s.*, (SELECT COUNT(*)::int FROM documents d
       WHERE d.space_id = s.id AND d.deleted_at IS NULL AND d.branch_of IS NULL) AS doc_count,
       (SELECT MAX(d.updated_at) FROM documents d
       WHERE d.space_id = s.id AND d.deleted_at IS NULL AND d.branch_of IS NULL) AS last_activity
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
    /** The space layer of the deadline cascade (E1), stored whole: the route merges a PATCH over the current object first (lib/ack-due mergeLayer). */
    policy_defaults?: PolicyDefaultsLayer;
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
  // Only known keys with values in range are stored; a junk value from a
  // direct caller is dropped, never written (the route refuses it with 400).
  if (patch.policy_defaults !== undefined) patch.policy_defaults = sanitizeLayer(patch.policy_defaults);
  const sets: string[] = [];
  const vals: any[] = [];
  for (const key of ["name", "description", "icon", "color", "visibility", "default_template_id", "default_view"] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = $${sets.length + 1}`);
      vals.push(patch[key]);
    }
  }
  if (patch.policy_defaults !== undefined) {
    sets.push(`policy_defaults = $${sets.length + 1}::jsonb`);
    vals.push(JSON.stringify(patch.policy_defaults));
  }
  if (!sets.length) return getSpaceById(id);
  vals.push(id);
  const before = patch.visibility !== undefined ? await getSpaceById(id) : undefined;
  const r = await q<Space>(
    `UPDATE spaces SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  // A visibility change moves who can see the space, so its policies'
  // audiences follow (D1): private shrinks them to the granted people,
  // internal opens them to every active account.
  if (before && r[0] && r[0].visibility !== before.visibility) {
    await reconcilePoliciesForSpace(id).catch((e) => console.error("[ack] could not reconcile the space's policies:", e));
  }
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
 * The most-read documents of the last 30 days within the viewer's scope —
 * the Ask page's first-run suggestions (1.9.3). Published only unless the
 * caller may see drafts; never a branch or a trashed document.
 */
export async function listPopularDocuments(
  scope: SpaceScope,
  includeDrafts = false,
  limit = 6
): Promise<DocumentWithSpace[]> {
  const filter = includeDrafts ? "" : " AND d.status = 'published'";
  const scoped = Array.isArray(scope) ? " AND d.space_id = ANY($2)" : "";
  const rows = await q(
    `${DOC_SELECT} JOIN (
       SELECT v.document_id, COUNT(*)::int AS views FROM doc_views v
       WHERE v.viewed_at > now() - interval '30 days' GROUP BY v.document_id
     ) pv ON pv.document_id = d.id
     WHERE d.deleted_at IS NULL AND d.branch_of IS NULL${filter}${scoped}
     ORDER BY pv.views DESC, d.updated_at DESC LIMIT $1`,
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
  prefs: { theme?: string; timezone?: string; date_format?: string; ui_scale?: string; single_key_shortcuts?: boolean }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of ["theme", "timezone", "date_format", "ui_scale", "single_key_shortcuts"] as const) {
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
  const v = await q<{ id: number }>(
    `INSERT INTO doc_versions (document_id, title, content, author, note, published_by_name)
     VALUES ($1,$2,$3,$4,$5,$4) RETURNING id`,
    [id, input.title, input.content, input.author, input.branch_of ? "Branched" : "Created"]
  );
  // The confirmation marker starts at the first version (ack_revision_at took
  // its default of now() on insert); resetAcknowledgements moves it later.
  await q("UPDATE documents SET ack_version_id = $2 WHERE id = $1", [id, v[0].id]);
  // Fire-and-forget semantic index (dynamic import avoids a module cycle).
  void import("./embeddings").then((m) => m.indexDocument(id)).catch(() => {});
  void import("./backlinks").then((m) => m.syncDocLinks(id)).catch(() => {});
  return (await getDocument(id))!;
}

/** Who took a confirmation decision: the signed-in user, or a system actor (id null) with a display name. */
export interface AckActor {
  id: number | null;
  name: string;
}

/**
 * documents.ack_edit_default (A5, 1.10.1): what a policy does when its text
 * changes. The same three values as the workspace setting
 * (lib/compliance-settings EditDefault; a type-only import, so this module
 * never loads that server-only one).
 */
export type AckEditDefault = EditDefault;
export const ACK_EDIT_DEFAULTS: readonly AckEditDefault[] = ["ask", "material", "reset"];
export function isAckEditDefault(v: unknown): v is AckEditDefault {
  return typeof v === "string" && (ACK_EDIT_DEFAULTS as readonly string[]).includes(v);
}
/**
 * The column as a row carries it (a documents row, a DocumentWithSpace,
 * which selects d.*), with the column default for anything unreadable. The
 * Document type does not declare the field (lib/types is not this
 * release's to change); the handoff asks for it.
 */
export function editDefaultOf(row: object | null | undefined): AckEditDefault {
  const v = (row as { ack_edit_default?: unknown } | null | undefined)?.ack_edit_default;
  return isAckEditDefault(v) ? v : "ask";
}

/**
 * How a caller that cannot ask resolves 'auto' (A5, rule 4): the document's
 * edit default decides. 'material' keeps a change the heuristic calls
 * editorial with high confidence (only keep/high is safe to act on
 * unasked), and the row then names source 'default', because the setting
 * decided, not the caller; 'ask' and 'reset', and every other change under
 * 'material', reset with the caller's source. One helper, so updateDocument
 * (edit, merge, restore, the API, MCP, imports), approveChangeRequest and
 * the scheduled publish take the same decision for the same text.
 */
export function resolveAutoAckPolicy(
  row: object | null | undefined,
  suggestion: { policy: "keep" | "reset"; confidence: "high" | "low" }
): { resolved: "keep" | "reset"; decidedBySetting: boolean } {
  const keep =
    editDefaultOf(row) === "material" && suggestion.policy === "keep" && suggestion.confidence === "high";
  return { resolved: keep ? "keep" : "reset", decidedBySetting: keep };
}

/**
 * A save's outcome together with the ledger row it wrote (null when no
 * decision was taken). The audit echo (auditAckDecision) reads that row by
 * id, never "the newest row for the document", so two concurrent saves of
 * one document cannot echo each other's decision.
 */
export type AckOutcomeWithDecision = AckOutcomeInfo & { decision_id: number | null };

/** The shortest change note a person may give when the text of a confirmed document changes. */
export const ACK_REASON_MIN = 10;

/**
 * Thrown by updateDocument before any write when an explicit 'keep' or
 * 'reset' arrives without a usable reason for a substantive change to a
 * confirmed, published document. Routes answer 400 with the message as is.
 */
export class AckReasonRequiredError extends Error {
  readonly code = "ack_reason_required";
  constructor() {
    super(
      "A change note of at least 10 characters is required when the text of a confirmed document changes."
    );
    this.name = "AckReasonRequiredError";
  }
}

export type UpdateDocumentInput = Partial<DocInput> & {
  versionNote?: string;
  restoredFrom?: number;
  /**
   * What to do with existing confirmations when the text of a confirmed,
   * published document changes (A2). 'keep' and 'reset' are a person's
   * decision and need ackReason (10+ characters; the keep side is excused
   * when ackKeepReasonRequired is false). 'auto', the default when a caller
   * says nothing, resolves from the document's edit default (A5, 1.10.1):
   * 'ask' and 'reset' reset (a caller that could ask would have asked, and
   * system actors cannot); 'material' keeps only when the change-size
   * heuristic says keep with high confidence, and the row then records
   * source 'default' because the document's setting took the decision. For
   * 'auto' the reason is ackReason, else the versionNote, else "Content
   * changed", with no length rule, so merge, restore, bulk, MCP, v1 and the
   * importers (which pass no policy until A6, 1.11.0) keep working exactly
   * as before and simply record what they did.
   */
  ackPolicy?: AckPolicy;
  /** Who decided; the version's author when absent. */
  ackActor?: AckActor;
  ackReason?: string;
  /** Where the save came from (the C1 vocabulary); 'default' when absent. */
  ackSource?: AckSource;
  /**
   * The workspace setting "Require a reason for editorial fixes too" (E4,
   * ack_defaults.keep_reason_required; the route reads it). True when
   * absent. Only the keep side is excused: a reset always needs its note.
   */
  ackKeepReasonRequired?: boolean;
  /**
   * The sending request's origin (requestOrigin(req)), carried on the
   * outbox row a reset queues so the notice's links are absolute on a
   * workspace without custom_domain; empty when no request exists (an
   * import).
   */
  ackOrigin?: string;
};

/**
 * Update a document. The five rules for confirmations (A2, 1.10.0), in order,
 * on the normalised next row (author excluded from the comparison, because
 * PUT always passes the current user as author):
 *
 *   1. Nothing changed: return the existing row with ack_outcome.changed
 *      false. No UPDATE, no updated_at bump, no version, no reset.
 *   2. Substantive = the next text or title differs from the version
 *      everyone was last asked to confirm (documents.ack_version_id), not
 *      merely from the previous save, and the save either writes a version
 *      (text/title changed) or publishes the document. So a draft edited
 *      over several saves and then published counts at the publish
 *      transition, while a tag-only save after a kept edit does not.
 *   3. Substantive while the requirement is off: the marker advances to the
 *      new version silently (no ledger row, no notice), so "off, edit, on"
 *      can never show 100% for unread text. While the requirement is on but
 *      the document is a draft, the marker stays: the decision is taken at
 *      publish, against the text people actually confirmed.
 *   4. Substantive, required and published: 'reset' calls
 *      resetAcknowledgements, 'keep' calls keepAcknowledgements, both with
 *      the reason; 'auto' follows documents.ack_edit_default (see
 *      UpdateDocumentInput.ackPolicy).
 *   5. Metadata-only: UPDATE as before; the ack columns are untouched
 *      whatever the policy.
 *
 * Everything from the UPDATE to the decision row runs in one transaction, so
 * a failure leaves no half-applied save. A reset also queues the 'updated'
 * notice in that transaction (resetAcknowledgements, 1.10.1); nothing here
 * sends mail.
 */
export async function updateDocument(
  id: number,
  input: UpdateDocumentInput
): Promise<(DocumentWithSpace & { ack_outcome?: AckOutcomeWithDecision }) | undefined> {
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

  const policy: AckPolicy = input.ackPolicy ?? "auto";
  const source: AckSource = input.ackSource ?? "default";
  const outcomeOf = (o: Partial<AckOutcomeWithDecision>): AckOutcomeWithDecision => ({
    changed: false,
    substantive: false,
    reset: false,
    confirmations_reset: 0,
    policy,
    source,
    decision_id: null,
    ...o,
  });

  // Rule 1: a save that changes nothing is not a save.
  const versionWorthy = next.content !== existing.content || next.title !== existing.title;
  const metadataChanged =
    next.type !== existing.type ||
    next.status !== existing.status ||
    next.summary !== existing.summary ||
    next.tags !== existing.tags.join(",") ||
    next.space_id !== existing.space_id ||
    (categoryId ?? null) !== (existing.category_id ?? null);
  if (!versionWorthy && !metadataChanged) {
    return { ...existing, ack_outcome: outcomeOf({}) };
  }

  // Rule 2: compare with the text people were last asked to confirm.
  const baseline = existing.ack_version_id
    ? (
        await q<{ title: string; content: string }>(
          "SELECT title, content FROM doc_versions WHERE id = $1 AND document_id = $2",
          [existing.ack_version_id, id]
        )
      )[0]
    : undefined;
  const base = baseline ?? { title: existing.title, content: existing.content };
  const driftsFromBaseline = next.content !== base.content || next.title !== base.title;
  const publishing = existing.status !== "published" && next.status === "published";
  const substantive = driftsFromBaseline && (versionWorthy || publishing);
  const decides = substantive && existing.ack_required === 1 && next.status === "published";
  const silentAdvance = substantive && existing.ack_required !== 1;

  // The reason is checked before any write, so a refused save leaves the
  // document exactly as it was. A keep without a usable note is allowed
  // only when the workspace excuses editorial fixes (keep_reason_required
  // off); the reset side is never excused.
  let reason = (input.ackReason ?? "").trim();
  if (decides) {
    if (policy === "auto") {
      reason = reason || (input.versionNote ?? "").trim() || "Content changed";
    } else if (reason.length < ACK_REASON_MIN && (policy === "reset" || input.ackKeepReasonRequired !== false)) {
      throw new AckReasonRequiredError();
    }
  }

  await ready();
  const client = await pool().connect();
  let ack = outcomeOf({ changed: true, substantive });
  try {
    await client.query("BEGIN");

    // Nested pages can't span spaces: moving a doc detaches it from its parent
    // and promotes its children to top level (in their own space).
    if (next.space_id !== existing.space_id) {
      await client.query("UPDATE documents SET parent_id = NULL WHERE id = $1 OR parent_id = $1", [id]);
    }

    // A real content edit refreshes the review clock — the doc was just
    // touched, so its next review is a full interval away again.
    if (next.content !== existing.content) {
      await client.query(
        `UPDATE documents
         SET review_due_at = now() + make_interval(days => review_interval_days),
             review_reminded_at = NULL
         WHERE id = $1 AND review_interval_days IS NOT NULL`,
        [id]
      );
    }

    await client.query(
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

    // The version the decision is about: the row written now, or (publish
    // transition without a text change) the newest row already there.
    let versionId: number | null = null;
    if (versionWorthy) {
      // Provenance (C6): the signed-in person when the route passed one,
      // otherwise the author byline (an import, the API with no actor).
      const v = await client.query<{ id: number }>(
        `INSERT INTO doc_versions (document_id, title, content, author, note, restored_from, published_by, published_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          id,
          next.title,
          next.content,
          next.author,
          input.versionNote || "Edited",
          input.restoredFrom ?? null,
          input.ackActor?.id ?? null,
          input.ackActor?.name || next.author,
        ]
      );
      versionId = v.rows[0].id;
    } else if (substantive) {
      const v = await client.query<{ id: number | null }>(
        "SELECT MAX(id) AS id FROM doc_versions WHERE document_id = $1",
        [id]
      );
      versionId = v.rows[0]?.id ?? null;
    }

    if (decides && versionId !== null) {
      // Rule 4: a decision, recorded either way (C1).
      const actor: AckActor = input.ackActor ?? { id: null, name: next.author };
      const summary = changeSummary(base.content, next.content, { oldTitle: base.title, newTitle: next.title });
      const suggestion = suggestReconfirm(summary);
      // 'auto' resolves from the document's edit default (A5), through the
      // helper every caller that cannot ask shares (resolveAutoAckPolicy).
      const { resolved, decidedBySetting } =
        policy === "auto"
          ? resolveAutoAckPolicy(existing, suggestion)
          : { resolved: policy, decidedBySetting: false };
      const decision = {
        versionId,
        actor,
        source: decidedBySetting ? ("default" as const) : source,
        reason,
        summary,
        suggested: suggestion.policy,
        overrodeSuggestion: policy !== "auto" && policy !== suggestion.policy,
        submittedPolicy: policy === "auto" ? ("" as const) : policy,
        origin: input.ackOrigin,
      };
      if (resolved === "keep") {
        const k = await keepAcknowledgements(client, id, decision);
        ack = outcomeOf({
          changed: true,
          substantive: true,
          decision_id: k.decision_id,
          ...(decidedBySetting ? { source: "default" as const } : {}),
        });
      } else {
        const r = await resetAcknowledgements(client, id, decision);
        ack = outcomeOf({
          changed: true,
          substantive: true,
          reset: true,
          confirmations_reset: r.confirmations_reset,
          decision_id: r.decision_id,
        });
      }
    } else if (silentAdvance && versionId !== null) {
      // Rule 3: nobody is being asked, so the marker simply follows the text.
      await resetAcknowledgements(client, id, {
        versionId,
        actor: input.ackActor ?? { id: null, name: next.author },
        source,
        reason: "",
        silent: true,
      });
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  if (versionWorthy) {
    // Fire-and-forget semantic re-index (dynamic import avoids a module cycle).
    void import("./embeddings").then((m) => m.indexDocument(id)).catch(() => {});
    void import("./backlinks").then((m) => m.syncDocLinks(id)).catch(() => {});
  }
  const doc = await getDocument(id);
  return doc ? { ...doc, ack_outcome: ack } : undefined;
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
export interface TrashedDocRow {
  id: number;
  title: string;
  type: string;
  status: string;
  deleted_at: string | null;
  space_name: string;
  space_icon: string;
  space_slug: string;
  /** Confirmations on record for this document (G3, 1.12.0): a row with any is never auto-purged. */
  ack_count: number;
  /** When the policy was retired (G3), null for a document that never was. */
  ack_retired_at: string | null;
}

/**
 * The Trash, a page at a time and without document bodies (the old query
 * loaded every body of every trashed document to render a title). `q`
 * matches the title or the space name, case-insensitively. Each row carries
 * its confirmation count and its retirement stamp (G3, 1.12.0) so the page
 * can say which rows the retention sweep leaves alone.
 */
export async function listTrashedDocuments(opts: { q?: string; limit?: number; offset?: number } = {}): Promise<{
  rows: TrashedDocRow[];
  total: number;
}> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const needle = (opts.q ?? "").trim();
  const params: unknown[] = [];
  let where = "d.deleted_at IS NOT NULL";
  if (needle) {
    params.push(`%${needle}%`);
    where += ` AND (d.title ILIKE $${params.length} OR s.name ILIKE $${params.length})`;
  }
  const from = `FROM documents d JOIN spaces s ON s.id = d.space_id WHERE ${where}`;
  const [{ n: total }] = await q<{ n: number }>(`SELECT COUNT(*)::int AS n ${from}`, params);
  const rows = await q<TrashedDocRow>(
    `SELECT d.id, d.title, d.type, d.status, d.deleted_at,
            s.name AS space_name, s.icon AS space_icon, s.slug AS space_slug,
            (SELECT COUNT(*)::int FROM acknowledgements a WHERE a.document_id = d.id) AS ack_count,
            d.ack_retired_at
     ${from} ORDER BY d.deleted_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows, total };
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

/**
 * Before a document's versions go (purge), copy every version a confirmation
 * or a marker cites into attested_texts so the words behind each
 * content_sha256 stay verifiable (C5). Insert-only with ON CONFLICT DO
 * NOTHING, so running it twice is free. Also fills the document_title
 * snapshot on any confirmation that still lacks one (rows written by 1.9.x
 * after a rollback), since the join target is about to disappear. Runs inside
 * the caller's transaction, before the DELETE. The cited set is every version
 * a confirmation, the marker or a decision row (ack_decisions, C1) names.
 */
async function archiveAttestedTexts(client: import("pg").PoolClient, docIds: number[]): Promise<number> {
  if (docIds.length === 0) return 0;
  await client.query(
    `UPDATE acknowledgements a SET document_title = d.title
     FROM documents d WHERE d.id = a.document_id AND a.document_id = ANY($1) AND a.document_title = ''`,
    [docIds]
  );
  const res = await client.query(
    `INSERT INTO attested_texts
       (version_id, document_id, document_title, title, content, content_sha256, author, version_created_at)
     SELECT v.id, v.document_id, d.title, v.title, v.content,
            encode(sha256(convert_to(v.content, 'UTF8')), 'hex'), v.author, v.created_at
     FROM doc_versions v
     JOIN documents d ON d.id = v.document_id
     WHERE v.document_id = ANY($1)
       AND (d.ack_version_id = v.id
            OR EXISTS (SELECT 1 FROM acknowledgements a WHERE a.version_id = v.id)
            OR EXISTS (SELECT 1 FROM ack_decisions x WHERE x.version_id = v.id))
     ON CONFLICT (version_id) DO NOTHING`,
    [docIds]
  );
  return res.rowCount ?? 0;
}

/** Permanently delete a trashed document (irreversible). Only affects Trash. */
export async function purgeDocument(id: number): Promise<boolean> {
  await ready();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    // Only a document in the Trash can be purged, and the check comes before
    // the archive: a live document's versions are never copied into
    // attested_texts (the route passes any id through).
    const trashed = await client.query(
      "SELECT 1 FROM documents WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE",
      [id]
    );
    if (trashed.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await archiveAttestedTexts(client, [id]);
    const res = await client.query("DELETE FROM documents WHERE id = $1", [id]);
    await client.query("COMMIT");
    return (res.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Permanently delete trashed documents older than `retentionDays`. A value of
 * 0 (or less) disables auto-purge (Trash is kept forever). Returns the count
 * removed. The attested text behind every confirmation is archived first, in
 * the same transaction.
 *
 * A document with confirmations on record is never auto-purged (G3,
 * 1.12.0): the NOT EXISTS leaves it in the Trash, where the page says so,
 * until someone chooses "Delete forever" (purgeDocument, which archives the
 * cited versions first). The sweep is for ordinary documents; evidence
 * waits for a deliberate decision.
 */
export async function purgeExpiredTrash(retentionDays: number): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  await ready();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<{ id: number }>(
      `SELECT id FROM documents
       WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 * interval '1 day')
         AND NOT EXISTS (SELECT 1 FROM acknowledgements a WHERE a.document_id = documents.id)
       FOR UPDATE SKIP LOCKED`,
      [retentionDays]
    );
    const ids = due.rows.map((r) => r.id);
    if (ids.length === 0) {
      await client.query("COMMIT");
      return 0;
    }
    await archiveAttestedTexts(client, ids);
    const res = await client.query("DELETE FROM documents WHERE id = ANY($1)", [ids]);
    await client.query("COMMIT");
    return res.rowCount ?? 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
  // The notice outbox is a queue, not a record (ack_notices is the record):
  // closed rows are kept a month for support and then dropped. A row that
  // gave up (three failed attempts, or an instance that died on the last
  // one) is closed with its error like a delivered one, so it is swept too;
  // the audit row ack.notice_failed is what lasts.
  await pool().query(
    "DELETE FROM ack_outbox WHERE done_at IS NOT NULL AND done_at < now() - interval '30 days'"
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
  notify_webhook_url, page_width, ui_scale, single_key_shortcuts, newsletter_role, theme, timezone, date_format,
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
  // a failure here must never block account creation), and a row for every
  // policy whose audience admits them, with one welcome notice (D1).
  await autoAssignTraining(r[0].id).catch(() => {});
  await autoAssignPolicies(r[0].id).catch((e) => console.error("[ack] could not enrol the new account:", e));
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
  // a failure here must never block account creation), and a row for every
  // policy whose audience admits them, with one welcome notice (D1).
  await autoAssignTraining(r[0].id).catch(() => {});
  await autoAssignPolicies(r[0].id).catch((e) => console.error("[ack] could not enrol the new account:", e));
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
  // A status flip closes or re-opens the person's policy rows (D1).
  if (fields.status !== undefined && fields.status !== existing.status) {
    await reconcilePoliciesForUser(id).catch((e) => console.error("[ack] could not reconcile the account's policies:", e));
  }
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
  // a failure here must never block account creation), and a row for every
  // policy whose audience admits them, with one welcome notice (D1).
  await autoAssignTraining(r[0].id).catch(() => {});
  await autoAssignPolicies(r[0].id).catch((e) => console.error("[ack] could not enrol the new account:", e));
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
  // A status flip closes or re-opens the person's policy rows (D1); a role
  // change waits for the hourly sweep, as every role writer does.
  if (fields.status !== undefined && fields.status !== existing.status) {
    await reconcilePoliciesForUser(id).catch((e) => console.error("[ack] could not reconcile the account's policies:", e));
  }
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
  // Read confirmations are kept (their FK is ON DELETE SET NULL since 1.10.0);
  // every row must carry the name snapshot the record will show once the
  // join target is gone (rows written by 1.9.x after a rollback lack it).
  // The snapshot and the delete are one transaction, and a failed snapshot
  // keeps the account: it is the only thing that will ever name the record.
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE acknowledgements a SET user_name = u.name, user_email = u.email
       FROM users u WHERE u.id = $1 AND a.user_id = $1 AND a.user_name = ''`,
      [id]
    );
    const res = await client.query("DELETE FROM users WHERE id = $1", [id]);
    await client.query("COMMIT");
    return (res.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** How many attestation records a user has (kept after deleteUser; the audit detail). */
export async function countUserAttestations(userId: number): Promise<number> {
  const r = await q<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM acknowledgements WHERE user_id = $1",
    [userId]
  );
  return r[0]?.n ?? 0;
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
  // The policies the group reaches (a group rule, a private space) follow (D1).
  await reconcilePoliciesForGroup(groupId).catch((e) => console.error("[ack] could not reconcile the group's policies:", e));
}

export async function removeGroupMember(groupId: number, userId: number): Promise<void> {
  await q("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
  await reconcilePoliciesForGroup(groupId).catch((e) => console.error("[ack] could not reconcile the group's policies:", e));
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
  // After the commit, never inside it: the membership stands whatever the
  // audiences do. The counts feed the sync report (drainAudienceSyncTally).
  await reconcilePoliciesForGroup(groupId).catch((e) => console.error("[ack] could not reconcile the group's policies:", e));
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
  // Who can see a private space changed: its policies' audiences follow (D1).
  if (roleKey === "space-member") {
    await reconcilePoliciesForSpace(spaceId).catch((e) => console.error("[ack] could not reconcile the space's policies:", e));
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
  if (roleKey === "space-member") {
    await reconcilePoliciesForSpace(spaceId).catch((e) => console.error("[ack] could not reconcile the space's policies:", e));
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

/**
 * Bulk-insert one notification row per recipient. An id whose account is
 * gone by now is skipped, not a failed batch: the join reads the statement's
 * snapshot and the foreign-key check the latest commit, so a deletion that
 * lands between the two fails once with 23503 and the second attempt sees it.
 */
export async function insertNotifications(
  userIds: number[],
  n: { kind: string; title: string; body?: string; link?: string; actor_name?: string }
): Promise<void> {
  if (userIds.length === 0) return;
  for (let attempt = 0; ; attempt++) {
    try {
      await q(
        `INSERT INTO notifications (user_id, kind, title, body, link, actor_name)
         SELECT u.id, $2, $3, $4, $5, $6 FROM unnest($1::int[]) AS uid JOIN users u ON u.id = uid`,
        [userIds, n.kind, n.title.slice(0, 300), (n.body || "").slice(0, 1000), n.link || "", n.actor_name || ""]
      );
      return;
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== "23503" || attempt >= 3) throw e;
    }
  }
}

/** Newest first. `beforeId` pages older than a row the caller already has
 *  (the Notifications page's "Load older"); ids rise with time. */
export async function listNotificationsFor(
  userId: number,
  limit = 30,
  beforeId?: number
): Promise<Notification[]> {
  return q(
    `SELECT id, kind, title, body, link, actor_name, created_at, read_at
     FROM notifications WHERE user_id = $1 AND ($3::int IS NULL OR id < $3)
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [userId, limit, beforeId ?? null]
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

/**
 * The workspace's "When the text of a policy changes" (E4) and "Re-confirm
 * every" (G1) defaults. A dynamic import: lib/compliance-settings imports
 * this module, and a static import back would be a cycle. Unreadable
 * settings fall back to the column defaults ('ask', no cycle).
 */
async function workspaceAckDefaults(): Promise<{ edit_default: AckEditDefault; recert_months: number | null }> {
  try {
    const m = await import("./compliance-settings");
    const d = (await m.getComplianceSettings()).ack_defaults;
    return { edit_default: d.edit_default, recert_months: d.recert_months };
  } catch {
    return { edit_default: "ask", recert_months: null };
  }
}

/**
 * Switch the requirement on or off. Switching ON applies the workspace edit
 * default to a document that still carries the column default 'ask' (A5): a
 * document receives the workspace value the first time it is set to
 * required, and a per-document choice of 'material' or 'reset' survives a
 * later off-and-on. (An explicit 'ask' cannot be told from the default, so
 * it follows the workspace value again after a toggle; the popover shows
 * the result.) Pass `editDefault: null` to leave the column alone, or a
 * value to apply instead of the workspace's. Every caller of the old
 * two-argument form keeps working: the portal's Request and the shield both
 * reach this through requestAcknowledgement.
 *
 * 1.12.0 (G1): the switch-on that wins the claim also dates the policy
 * (ack_effective_at = today, kept once set) and, when the workspace has a
 * default interval and the document has none, starts its cycle
 * (ack_recert_months = the default, ack_next_recert_at = now + interval).
 * `recertMonths` works like `editDefault`: undefined reads the workspace,
 * null leaves the columns alone, a number applies instead.
 *
 * A policy with an interval of its own that is stopped and switched on
 * again keeps its next date, unless that date passed while it was off:
 * then the switch-on moves it to now + interval, the rule un-retire
 * applies (RECERT_NEXT_ON_RESUME), so the sweep does not fire a cycle at
 * the next tick on top of the request that just went out.
 *
 * A retired policy (G3, ack_retired_at set) never switches on here: the
 * WHERE refuses it and the call answers `switched_on: false` like a policy
 * that already requires confirmation. Un-retire (unretirePolicy) is the one
 * way back; the routes answer 409 before they get here.
 */
export async function setAckRequired(
  docId: number,
  required: boolean,
  opts: { editDefault?: AckEditDefault | null; recertMonths?: number | null } = {}
): Promise<{ switched_on: boolean; edit_default: AckEditDefault }> {
  if (!required) {
    const r = await q<{ ack_edit_default: string }>(
      "UPDATE documents SET ack_required = 0 WHERE id = $1 RETURNING ack_edit_default",
      [docId]
    );
    return { switched_on: false, edit_default: editDefaultOf(r[0]) };
  }
  const workspace =
    opts.editDefault === undefined || opts.recertMonths === undefined ? await workspaceAckDefaults() : null;
  const apply = opts.editDefault === undefined ? workspace!.edit_default : opts.editDefault;
  const recert = opts.recertMonths === undefined ? workspace!.recert_months : opts.recertMonths;
  // The flip is the claim: `ack_required = 0` in the WHERE is re-checked
  // against the row as updated by a concurrent call (READ COMMITTED), so of
  // two simultaneous switch-ons exactly one gets a row back. A snapshot
  // subquery here would let both report switched_on.
  //
  // The next date's second WHEN is RECERT_NEXT_ON_RESUME's body: a stale
  // date on a policy with an interval moves out a whole interval.
  const r = await q<{ ack_edit_default: string }>(
    `UPDATE documents
     SET ack_required = 1,
         ack_edit_default = CASE
           WHEN ack_edit_default = 'ask' AND $2::text IS NOT NULL THEN $2::text
           ELSE ack_edit_default
         END,
         ack_effective_at = COALESCE(ack_effective_at, CURRENT_DATE),
         ack_next_recert_at = CASE
           WHEN ack_recert_months IS NULL AND $3::int IS NOT NULL THEN now() + make_interval(months => $3::int)
           WHEN ack_recert_months IS NOT NULL AND ack_next_recert_at <= now()
           THEN now() + make_interval(months => ack_recert_months)
           ELSE ack_next_recert_at
         END,
         ack_recert_months = COALESCE(ack_recert_months, $3::int)
     WHERE id = $1 AND ack_required = 0 AND ack_retired_at IS NULL
     RETURNING ack_edit_default`,
    [docId, apply, recert]
  );
  if (r[0]) {
    // The audience (D1, 1.13.0): the policy's settings row (space mode
    // unless it already had one) and a row for everyone its audience names,
    // in one transaction, so the first count after a switch-on is right.
    // Only the call that flipped the requirement does this; the loser of a
    // race changes nothing.
    await reconcilePolicyAssignments(null, docId, { auto: false });
    return { switched_on: true, edit_default: editDefaultOf(r[0]) };
  }
  const cur = await q<{ ack_edit_default: string }>("SELECT ack_edit_default FROM documents WHERE id = $1", [docId]);
  return { switched_on: false, edit_default: editDefaultOf(cur[0]) };
}

/**
 * Set the per-document edit default (the popover's Select). Returns the
 * values before and after for the audit row, or null when the document is
 * gone. The value is validated by the caller (isAckEditDefault).
 */
export async function setAckEditDefault(
  docId: number,
  value: AckEditDefault
): Promise<{ from: AckEditDefault; to: AckEditDefault } | null> {
  const r = await q<{ before: string; after: string }>(
    `UPDATE documents d SET ack_edit_default = $2
     FROM (SELECT id, ack_edit_default AS before FROM documents WHERE id = $1) o
     WHERE d.id = o.id
     RETURNING o.before, d.ack_edit_default AS after`,
    [docId, value]
  );
  if (!r[0]) return null;
  return { from: editDefaultOf({ ack_edit_default: r[0].before }), to: editDefaultOf({ ack_edit_default: r[0].after }) };
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

// A confirmation (alias a) counts for a document (alias d) while it was made
// on or after the doc's confirmation marker. The marker — not updated_at — is
// the single source of currency (1.10.0): metadata-only saves, moves,
// scheduling and trash/restore never touch it. Every compliance query below
// uses this fragment and nothing else, so they cannot disagree.
const ACK_CURRENT = `a.acknowledged_at >= d.ack_revision_at`;

// Who owes a policy, since 1.13.0 (D1): an open row of policy_assignments
// (alias pa; PA_OPEN from lib/audience = not removed, not exempt) for an
// active account. ACK_ELIGIBLE is no longer recomputed by the counts: the
// rows are materialised from the policy's audience by
// reconcilePolicyAssignments (below), which intersects every target with
// ACK_VISIBILITY, so the private-space ceiling still holds. Where a query
// joins pa, a confirmation counts from the later of the document marker and
// the row's own cycle start (a per-person re-ask, D4, or a return to the
// audience), so the roster, the portal, My policies and the reader agree.
const ACK_CURRENT_PA = `a.acknowledged_at >= GREATEST(d.ack_revision_at, pa.cycle_started_at)`;
/** An open row of an active account: the people a policy asks. */
const PA_OWES = `${PA_OPEN} AND u.status = 'active'`;

// 1-based position of a version among its document's versions, ordered the
// way Version history numbers them (oldest = v1). NULL when the column is
// NULL or the version row is gone (a purged policy: the archive keeps the
// text, but not the numbering).
const VERSION_REV = (col: string) => `(
    SELECT NULLIF(COUNT(*), 0)::int FROM doc_versions v2
    JOIN doc_versions v ON v.id = ${col}
    WHERE v2.document_id = v.document_id
      AND (v2.created_at, v2.id) <= (v.created_at, v.id)
  )`;

/** 'recorded' when the row carries the hash of the text confirmed; 'inferred' for rows from before 1.10.0. */
export type AckVersionSource = "recorded" | "inferred";
const VERSION_SOURCE = (shaCol: string) =>
  `CASE WHEN ${shaCol} IS NOT NULL THEN 'recorded' ELSE 'inferred' END`;

/** The slice of a decision row the portal and the CSVs show. */
export interface AckDecisionBrief {
  decided_at: string;
  decided_by_name: string;
  reason: string;
  outcome: AckOutcome;
  source: AckSource;
}

export interface ComplianceDocRow {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
  /**
   * 'published', or 'draft' for a paused policy (G2, 1.11.0): unpublished
   * with the requirement still on. The portal lists it under "Paused
   * (unpublished)" with no actions, and the KPI sums skip it, so a policy
   * taken down for a rewrite neither drops the percentage nor vanishes.
   */
  status: DocStatus;
  updated_at: string;
  ack_revision_at: string;
  ack_version_id: number | null;
  /** The marker version's number ("v12"), null when the version row is gone. */
  ack_rev: number | null;
  ack_last_reminded_at: string | null;
  /** How the policy treats a text edit (A5): the portal's "Asks editor" / "Asks when material" / "Always re-asks" chip. */
  ack_edit_default: AckEditDefault;
  required: number;
  acked: number;
  /** The newest decision of either outcome (C1); null before the ledger started. */
  last_decision: AckDecisionBrief | null;
  /** The newest 'reset' (who last asked everyone, and why); null when the marker predates the ledger. */
  last_reset: AckDecisionBrief | null;
  /** Kept edits since everyone was last asked. */
  kept_since_reset: number;
  /** How far the live text drifted from the confirmed version, in % of words (0 when nothing was kept). */
  drift_pct: number;
  /**
   * Retirement (G3, 1.12.0): when the policy was retired, by whom and why;
   * null / '' for a live policy. A retired row's `required` and `acked` are
   * the counts frozen on its 'retired' ledger row (the final standing), not
   * the live audience, and `retired_rev` is the version people had been
   * asked to confirm at that moment (the marker may move on later edits).
   * The portal lists retired rows in their own collapsed group; the tiles
   * leave them out.
   */
  ack_retired_at: string | null;
  ack_retired_by_name: string;
  ack_retired_reason: string;
  /** The policy that replaced this one, and its title (null when none, or when it was trashed). */
  ack_superseded_by: number | null;
  superseded_by_title: string | null;
  retired_rev: number | null;
  /**
   * Periodic re-confirmation (G1, 1.12.0): the interval in months (null =
   * off), the stored next date and the effective date as 'YYYY-MM-DD'. The
   * portal row reads "Next re-confirmation {date}" from them and the
   * Overview tile counts the rows due within 30 days (recertDueWithin).
   */
  ack_recert_months: number | null;
  ack_next_recert_at: string | null;
  ack_effective_at: string | null;
  /**
   * Deadlines (E1, 1.13.0): `overdue` counts the open rows of active
   * accounts whose due date plus the grace (the space's policy_defaults,
   * else the workspace's ack_defaults, else 0 days) has passed with no
   * current confirmation; `due_days` / `due_at` are the policy's own rule as
   * policy_settings stores it (both null = inherit; `due_at` is
   * 'YYYY-MM-DD') and `due_days_resolved` the days the cascade settles on
   * (policy, space, workspace, built-in 14), so the portal row can read
   * "Due 29 Oct 2026 · 12 overdue" or "Due 14 days after assignment"
   * (portalDueLine in lib/ack-due). A retired row's counts are the live
   * ones (nothing is overdue on a policy that asks nobody).
   */
  overdue: number;
  due_days: number | null;
  due_at: string | null;
  due_days_resolved: number;
  /**
   * Audiences (D1, 1.13.0): people whose assignment row was opened in the
   * last seven days and is still open ("+6 enrolled this week"); a row
   * re-opened for a returning person keeps its original assigned_at, so a
   * return is not an enrolment.
   */
  enrolled_week: number;
}

// The workspace's grace after a due date (ack_defaults.overdue_grace_days,
// E1) is read raw by workspaceOverdueGraceDays, declared beside the My
// policies queries further down (one reader for the portal, the dashboard
// and My policies); null there means the built-in 0.

/**
 * An open row past its due date and the grace with no current confirmation,
 * over the aliases complianceDocs and complianceUserSummary share (pa, s, a
 * the LATERAL confirmation): the portal's overdue counts (E1). The grace has
 * no per-policy column, so it resolves space, workspace (the parameter),
 * built-in 0; isOverdue in lib/ack-due is the same rule in TypeScript.
 */
const PA_OVERDUE = (graceParam: string) =>
  `a.acknowledged_at IS NULL AND pa.due_at IS NOT NULL
   AND pa.due_at + make_interval(days => COALESCE((s.policy_defaults->>'overdue_grace_days')::int, ${graceParam}::int, 0)) < now()`;

/**
 * Central compliance portal: every ack-required doc with counts and its last
 * decisions. Published policies and paused ones alike (G2, 1.11.0: an
 * unpublished policy keeps its requirement and its confirmations; `status`
 * says which it is, and the route's KPI sums and the CSV matrix take only
 * the published rows), and retired ones (G3, 1.12.0: the requirement is off
 * but the record stays; they sort last, with their counts frozen at
 * retirement). Draft branches never appear: they are working copies whose
 * text reaches readers only by merging, and only setAckRequired ever
 * writes ack_required, so a branch cannot carry it anyway.
 */
export async function complianceDocs(): Promise<ComplianceDocRow[]> {
  // The workspace layer of the cascade (E1), read once: the days a policy
  // without its own rule gets, and the grace before a row counts as overdue.
  const [workspaceDays, workspaceGrace] = await Promise.all([workspaceDueDays(), workspaceOverdueGraceDays()]);
  const docs = await q<
    Omit<ComplianceDocRow, "last_decision" | "last_reset" | "kept_since_reset" | "drift_pct" | "retired_rev" | "enrolled_week">
  >(
    `SELECT d.id, d.title, s.name AS space_name, s.icon AS space_icon, d.status,
            d.updated_at, d.ack_revision_at, d.ack_version_id, d.ack_last_reminded_at,
            d.ack_edit_default,
            d.ack_retired_at, d.ack_retired_by_name, d.ack_retired_reason, d.ack_superseded_by,
            r.title AS superseded_by_title,
            d.ack_recert_months, d.ack_next_recert_at, d.ack_effective_at::text AS ack_effective_at,
            ${VERSION_REV("d.ack_version_id")} AS ack_rev,
            COUNT(u.id)::int AS required,
            COUNT(u.id) FILTER (WHERE a.acknowledged_at IS NOT NULL)::int AS acked,
            COUNT(u.id) FILTER (WHERE ${PA_OVERDUE("$2")})::int AS overdue,
            ps.due_days, ps.due_at::text AS due_at,
            COALESCE(ps.due_days, (s.policy_defaults->>'due_days')::int, $1::int, 14) AS due_days_resolved
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     LEFT JOIN documents r ON r.id = d.ack_superseded_by AND r.deleted_at IS NULL
     LEFT JOIN policy_settings ps ON ps.document_id = d.id
     LEFT JOIN policy_assignments pa ON pa.document_id = d.id AND ${PA_OPEN}
     LEFT JOIN users u ON u.id = pa.user_id AND u.status = 'active'
     LEFT JOIN LATERAL (
       SELECT a.acknowledged_at FROM acknowledgements a
       WHERE a.document_id = d.id AND a.user_id = u.id AND ${ACK_CURRENT_PA}
       ORDER BY a.acknowledged_at DESC LIMIT 1
     ) a ON true
     WHERE (d.ack_required = 1 OR d.ack_retired_at IS NOT NULL) AND d.deleted_at IS NULL AND d.branch_of IS NULL
     GROUP BY d.id, d.title, s.id, s.name, s.icon, d.status, d.updated_at, d.ack_revision_at, d.ack_version_id,
              d.ack_last_reminded_at, d.ack_edit_default,
              d.ack_retired_at, d.ack_retired_by_name, d.ack_retired_reason, d.ack_superseded_by, r.title,
              d.ack_recert_months, d.ack_next_recert_at, d.ack_effective_at, ps.document_id
     ORDER BY (d.ack_retired_at IS NOT NULL), (d.status <> 'published'),
              (COUNT(u.id) - COUNT(u.id) FILTER (WHERE a.acknowledged_at IS NOT NULL)) DESC, d.title`,
    [workspaceDays, workspaceGrace]
  );
  if (docs.length === 0) return [];
  const ids = docs.map((d) => d.id);
  const retiredIds = docs.filter((d) => d.ack_retired_at !== null).map((d) => d.id);
  // Five set-based reads instead of five per policy: the newest decision,
  // the newest reset, the kept edits since the marker with the drift they
  // left (from the rows, no document text crosses the wire), for the
  // retired rows the 'retired' ledger row whose counts and version are the
  // final standing (G3), and the rows opened this week (D1: over every open
  // row, exempt ones included, so the count says who joined the audience
  // rather than who owes it today).
  const briefCols = "x.document_id, x.decided_at, x.decided_by_name, x.reason, x.outcome, x.source";
  const [latest, resets, driftBy, retiredRows, enrolled] = await Promise.all([
    q<AckDecisionBrief & { document_id: number }>(
      `SELECT DISTINCT ON (x.document_id) ${briefCols} FROM ack_decisions x
       WHERE x.document_id = ANY($1) ORDER BY x.document_id, x.decided_at DESC, x.id DESC`,
      [ids]
    ),
    q<AckDecisionBrief & { document_id: number }>(
      `SELECT DISTINCT ON (x.document_id) ${briefCols} FROM ack_decisions x
       WHERE x.document_id = ANY($1) AND x.outcome = 'reset' AND x.scope = 'all'
       ORDER BY x.document_id, x.decided_at DESC, x.id DESC`,
      [ids]
    ),
    keptSinceMarker(ids),
    retiredIds.length === 0
      ? Promise.resolve([] as { document_id: number; confirmations_affected: number | null; eligible: number | null; rev: number | null }[])
      : q<{ document_id: number; confirmations_affected: number | null; eligible: number | null; rev: number | null }>(
          `SELECT DISTINCT ON (x.document_id) x.document_id, x.confirmations_affected, x.eligible,
                  ${VERSION_REV("x.version_id")} AS rev
           FROM ack_decisions x
           WHERE x.document_id = ANY($1) AND x.outcome = 'retired'
           ORDER BY x.document_id, x.decided_at DESC, x.id DESC`,
          [retiredIds]
        ),
    q<{ document_id: number; n: number }>(
      `SELECT document_id, COUNT(*)::int AS n FROM policy_assignments
       WHERE document_id = ANY($1) AND removed_at IS NULL AND assigned_at > now() - interval '7 days'
       GROUP BY document_id`,
      [ids]
    ),
  ]);
  const brief = (r: AckDecisionBrief & { document_id: number }): AckDecisionBrief => ({
    decided_at: r.decided_at,
    decided_by_name: r.decided_by_name,
    reason: r.reason,
    outcome: r.outcome,
    source: r.source,
  });
  const latestBy = new Map(latest.map((r) => [r.document_id, brief(r)]));
  const resetBy = new Map(resets.map((r) => [r.document_id, brief(r)]));
  const retiredBy = new Map(retiredRows.map((r) => [r.document_id, r]));
  const enrolledBy = new Map(enrolled.map((r) => [r.document_id, r.n]));
  return docs.map((d) => {
    const frozen = d.ack_retired_at !== null ? retiredBy.get(d.id) : undefined;
    return {
      ...d,
      // A retired policy answers with the standing frozen on its ledger row
      // (a row written by hand before 1.12.0 has none: the live counts stand in).
      required: frozen?.eligible ?? d.required,
      acked: frozen?.confirmations_affected ?? d.acked,
      retired_rev: frozen ? (frozen.rev ?? d.ack_rev) : null,
      last_decision: latestBy.get(d.id) ?? null,
      last_reset: resetBy.get(d.id) ?? null,
      kept_since_reset: driftBy.get(d.id)?.n ?? 0,
      drift_pct: driftBy.get(d.id)?.pct ?? 0,
      enrolled_week: enrolledBy.get(d.id) ?? 0,
    };
  });
}

/** People the policy asks (open assignment rows of active accounts) who have NOT confirmed its current ask. */
export async function compliancePendingUsers(
  docId: number
): Promise<{ id: number; name: string; username: string; email: string }[]> {
  return q(
    `SELECT u.id, u.name, u.username, u.email
     FROM policy_assignments pa
     JOIN users u ON u.id = pa.user_id
     JOIN documents d ON d.id = pa.document_id
     WHERE pa.document_id = $1 AND ${PA_OWES}
       AND NOT EXISTS (
         SELECT 1 FROM acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = u.id AND ${ACK_CURRENT_PA}
       )
     ORDER BY u.name`,
    [docId]
  );
}

/**
 * Per-user compliance: how many required policies each active user has
 * left, and how many of those are overdue (E1, 1.13.0: the open row's due
 * date plus the grace has passed with no current confirmation; the space's
 * grace, else the workspace's, else none). Published policies only: a
 * paused (unpublished) policy is not owed by anyone while it is down, and a
 * draft branch is never a policy.
 */
export async function complianceUserSummary(): Promise<
  { id: number; name: string; username: string; role: string; required: number; acked: number; overdue: number }[]
> {
  const workspaceGrace = await workspaceOverdueGraceDays();
  return q(
    `SELECT u.id, u.name, u.username, u.role,
            COUNT(d.id)::int AS required,
            COUNT(d.id) FILTER (WHERE a.acknowledged_at IS NOT NULL)::int AS acked,
            COUNT(d.id) FILTER (WHERE ${PA_OVERDUE("$1")})::int AS overdue
     FROM users u
     LEFT JOIN policy_assignments pa ON pa.user_id = u.id AND ${PA_OPEN}
     LEFT JOIN documents d
       ON d.id = pa.document_id
      AND d.ack_required = 1 AND d.status = 'published' AND d.deleted_at IS NULL AND d.branch_of IS NULL
     LEFT JOIN spaces s ON s.id = d.space_id
     LEFT JOIN LATERAL (
       SELECT a.acknowledged_at FROM acknowledgements a
       WHERE a.document_id = d.id AND a.user_id = u.id AND ${ACK_CURRENT_PA}
       ORDER BY a.acknowledged_at DESC LIMIT 1
     ) a ON true
     WHERE u.status = 'active'
     GROUP BY u.id, u.name, u.username, u.role
     ORDER BY (COUNT(d.id) - COUNT(d.id) FILTER (WHERE a.acknowledged_at IS NOT NULL)) DESC, u.name`,
    [workspaceGrace]
  );
}

/**
 * Published docs not yet requiring acknowledgement (request-ack picker). A
 * retired policy is left out (G3): "Request read confirmation" must never
 * silently re-require one; un-retire is the named way back.
 */
export async function ackCandidateDocs(): Promise<
  { id: number; title: string; space_name: string; space_icon: string }[]
> {
  return q(
    `SELECT d.id, d.title, s.name AS space_name, s.icon AS space_icon
     FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE d.ack_required = 0 AND d.status = 'published' AND d.deleted_at IS NULL
       AND d.branch_of IS NULL AND d.ack_retired_at IS NULL
     ORDER BY s.name, d.title`
  );
}

export async function setAckLastReminded(docId: number): Promise<void> {
  await q("UPDATE documents SET ack_last_reminded_at = now() WHERE id = $1", [docId]);
}

// --- Audiences (D1, 1.13.0) ------------------------------------------------------
//
// Who must confirm a policy is a row of policy_assignments, materialised
// from the policy's audience (policy_settings.audience_mode and the rows of
// policy_audience_rules; the predicates in lib/audience) by
// reconcilePolicyAssignments and read by every count above. Rows are never
// deleted: a person who leaves the audience keeps their row with removed_at
// and a reason, and the same row re-opens when they return, their exemption
// and reminder history with it. Nothing here touches the acknowledgements
// ledger: a row says who owes a confirmation, never who gave one.
//
// The target of a policy = the people its rules admit who are active and
// can see its space (ACK_VISIBILITY, the ceiling the ack route and the
// document page enforce), so a rule narrows and never widens. Rows of a
// policy that stopped asking (requirement off, retired, trashed) are left
// as they are: ack_required = 0 takes the policy out of every sum, and
// un-retiring reconciles. The doc-scoped reconcile serves a save, a switch-on
// and the group, space and hourly hooks; the user-scoped one serves a new
// account and a status flip, so provisioning five thousand people does not
// rebuild every policy five thousand times.
//
// "Enrol new joiners automatically" (policy_settings.assign_new_members)
// gates the automatic paths only: a new account, a group or space change, a
// status flip and the hourly sweep add nobody to a policy that has it off
// (they still close rows that no longer belong). A manager's save of the
// audience and the switch-on always enrol everyone the target names.

export interface ReconcileResult {
  added: number;
  closed: number;
  reopened: number;
}

/** The workspace layer the reconcile needs: the two day counts of ack_defaults (null = built-in) and the zone a fixed date's day ends in. */
export interface AudienceDefaults {
  due_days: number | null;
  new_joiner_days: number | null;
  timeZone: string;
}

/**
 * Read raw from the settings table: lib/compliance-settings is server-only
 * and imports this module. A value outside 1..365, or an unreadable row,
 * reads as null and the SQL falls through to the built-in 14; a blank zone
 * is UTC (what the app shows when none is set).
 */
export async function workspaceAudienceDefaults(): Promise<AudienceDefaults> {
  let due_days: number | null = null;
  let new_joiner_days: number | null = null;
  let timeZone = "UTC";
  try {
    const raw = await getSetting("ack_defaults");
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const pick = (k: string): number | null => {
      const v = o?.[k];
      return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 365 ? v : null;
    };
    due_days = pick("due_days");
    new_joiner_days = pick("new_joiner_days");
  } catch {
    /* built-in */
  }
  try {
    timeZone = (await getSetting("timezone"))?.trim() || "UTC";
  } catch {
    /* UTC */
  }
  return { due_days, new_joiner_days, timeZone };
}

/** The author and approvers of a policy (aliases d, s, u): what "Exempt the document's author and approvers" takes out. */
const ACK_STEWARD = `(
    u.name = d.author
    OR EXISTS (SELECT 1 FROM doc_versions v WHERE v.document_id = d.id AND v.published_by = u.id)
    OR ${HOLDS_GLOBALLY("change_request.read", "u.id")}
    OR ${HOLDS_ON_SPACE("change_request.read", "s.id", "u.id")}
  )`;

const audienceSql = (rules: string, mode: string, excludeStewards: string): AudienceSqlAliases => ({
  doc: "d",
  user: "u",
  rules,
  mode,
  excludeStewards,
  visible: ACK_VISIBILITY,
  steward: ACK_STEWARD,
});

/** The policy's saved audience, over the aliases d, s, ps (LEFT JOINed: a missing row reads as space mode) and u. */
const SAVED_AUDIENCE = audienceSql(
  audienceRulesFromTable("d.id"),
  "COALESCE(ps.audience_mode, 'space')",
  "COALESCE(ps.exclude_stewards, 0) = 1"
);
/** A policy whose audience is kept: the requirement on, live, not a branch, not retired (paused ones included: they resume with the audience they had). */
const AUDIENCE_POLICY = `d.ack_required = 1 AND d.deleted_at IS NULL AND d.branch_of IS NULL AND d.ack_retired_at IS NULL`;
/** In the audience: an active account that can see the space and the rules admit. */
const IN_AUDIENCE = `u.status = 'active' AND ${ACK_VISIBILITY} AND ${audienceAdmitsSql(SAVED_AUDIENCE)}`;
/** The FROM list the audience statements share: the policy, its space and its settings row. */
const AUDIENCE_FROM = `documents d
       JOIN spaces s ON s.id = d.space_id
       LEFT JOIN policy_settings ps ON ps.document_id = d.id`;
/** The upsert's conflict arm: a closed row of a returning person re-opens with a fresh cycle and deadline; an open row is left alone. */
const AUDIENCE_REOPEN = `ON CONFLICT (document_id, user_id) DO UPDATE
       SET removed_at = NULL, removed_reason = '', cycle_started_at = now(),
           due_at = EXCLUDED.due_at, source = EXCLUDED.source
       WHERE policy_assignments.removed_at IS NOT NULL`;

const NO_CHANGE: ReconcileResult = { added: 0, closed: 0, reopened: 0 };

/**
 * Bring one policy's rows in line with its audience: close the open rows
 * of people the target no longer names (removed_at = now() and why), insert
 * a row for each person it names who has none, and re-open the closed row
 * of a person who is back. Returns the three counts. `client` runs it
 * inside the caller's transaction (a save of the rules); null runs it in
 * one of its own. `auto` marks the automatic paths (see the header):
 * nothing is added to a policy with assign_new_members off. `defaults` is
 * the workspace layer; a sweep loads it once and passes it in.
 */
export async function reconcilePolicyAssignments(
  client: Queryable | null,
  docId: number,
  opts: { defaults?: AudienceDefaults; auto?: boolean; narrowing?: AudienceNarrowing } = {}
): Promise<ReconcileResult> {
  if (client) return reconcilePolicyOn(client, docId, opts);
  await ready();
  const own = await pool().connect();
  try {
    await own.query("BEGIN");
    const r = await reconcilePolicyOn(own, docId, opts);
    await own.query("COMMIT");
    return r;
  } catch (e) {
    await own.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    own.release();
  }
}

async function reconcilePolicyOn(
  client: Queryable,
  docId: number,
  opts: { defaults?: AudienceDefaults; auto?: boolean; narrowing?: AudienceNarrowing }
): Promise<ReconcileResult> {
  const defaults = opts.defaults ?? (await workspaceAudienceDefaults());
  // Self-healing: a policy switched on by a 1.12.0 binary during a rolling
  // deploy has no settings row; it gets one here, in space mode.
  await client.query(
    "INSERT INTO policy_settings (document_id) SELECT id FROM documents WHERE id = $1 ON CONFLICT (document_id) DO NOTHING",
    [docId]
  );
  // The settings row is the lock: two reconciles of one policy (a group
  // sync and a save at once) run one after the other and neither doubles.
  const head = await client.query<{ live: boolean; auto_on: boolean }>(
    `SELECT (${AUDIENCE_POLICY}) AS live, (ps.assign_new_members = 1) AS auto_on
     FROM documents d JOIN policy_settings ps ON ps.document_id = d.id
     WHERE d.id = $1 FOR UPDATE OF ps`,
    [docId]
  );
  const h = head.rows[0];
  if (!h || !h.live) return { ...NO_CHANGE };
  const closed = await client.query(
    `UPDATE policy_assignments pa
     SET removed_at = now(), removed_reason = ${audienceRemovedReasonSql(SAVED_AUDIENCE, opts.narrowing)}
     FROM ${AUDIENCE_FROM}, users u
     WHERE pa.document_id = $1 AND d.id = pa.document_id AND u.id = pa.user_id
       AND pa.removed_at IS NULL
       AND NOT (${IN_AUDIENCE})`,
    [docId]
  );
  if (opts.auto && !h.auto_on) return { added: 0, closed: closed.rowCount ?? 0, reopened: 0 };
  const opened = await client.query<{ inserted: boolean }>(
    `INSERT INTO policy_assignments (document_id, user_id, source, due_at)
     SELECT d.id, u.id, ${audienceSourceSql(SAVED_AUDIENCE)},
            ${dueAtSql({ from: "now()", workspace: "$2", timeZone: "$3" })}
     FROM ${AUDIENCE_FROM}, users u
     WHERE d.id = $1 AND ${IN_AUDIENCE}
     ${AUDIENCE_REOPEN}
     RETURNING (xmax = 0) AS inserted`,
    [docId, defaults.due_days, defaults.timeZone]
  );
  let added = 0;
  let reopened = 0;
  for (const r of opened.rows) {
    if (r.inserted) added++;
    else reopened++;
  }
  return { added, closed: closed.rowCount ?? 0, reopened };
}

/** One policy a user-scoped reconcile opened or re-opened, for the welcome notice and the audit row. */
export interface EnrolledPolicy {
  id: number;
  title: string;
  due_at: string | null;
}

/**
 * The user-scoped form: the same predicates over every live policy for one
 * person. Closes their rows where the target no longer names them (when
 * `close` is set: a status flip), opens or re-opens rows where it does.
 * 'new_member' rows take the new-joiner days from the cascade (the space,
 * the workspace, the built-in) instead of the policy's deadline rule.
 */
async function reconcileUserOn(
  client: Queryable,
  userId: number,
  opts: { defaults: AudienceDefaults; source: "rules" | "new_member"; auto: boolean; close: boolean }
): Promise<ReconcileResult & { opened: EnrolledPolicy[] }> {
  let closed = 0;
  if (opts.close) {
    const c = await client.query(
      `UPDATE policy_assignments pa
       SET removed_at = now(), removed_reason = ${audienceRemovedReasonSql(SAVED_AUDIENCE)}
       FROM ${AUDIENCE_FROM}, users u
       WHERE pa.user_id = $1 AND u.id = pa.user_id AND d.id = pa.document_id
         AND pa.removed_at IS NULL AND ${AUDIENCE_POLICY}
         AND NOT (${IN_AUDIENCE})`,
      [userId]
    );
    closed = c.rowCount ?? 0;
  }
  const joiner = opts.source === "new_member";
  const source = joiner ? "'new_member'" : audienceSourceSql(SAVED_AUDIENCE);
  const due = dueAtSql({ from: "now()", workspace: "$2", timeZone: "$3", key: joiner ? "new_joiner_days" : "due_days" });
  const opened = await client.query<{ document_id: number; due_at: string | null; inserted: boolean }>(
    `INSERT INTO policy_assignments (document_id, user_id, source, due_at)
     SELECT d.id, u.id, ${source}, ${due}
     FROM ${AUDIENCE_FROM}, users u
     WHERE u.id = $1 AND ${AUDIENCE_POLICY}
       AND ($4::boolean = false OR COALESCE(ps.assign_new_members, 1) = 1)
       AND ${IN_AUDIENCE}
     ${AUDIENCE_REOPEN}
     RETURNING document_id, due_at, (xmax = 0) AS inserted`,
    [userId, joiner ? opts.defaults.new_joiner_days : opts.defaults.due_days, opts.defaults.timeZone, opts.auto]
  );
  let added = 0;
  let reopened = 0;
  for (const r of opened.rows) {
    if (r.inserted) added++;
    else reopened++;
  }
  const ids = opened.rows.map((r) => r.document_id);
  const titles =
    ids.length === 0
      ? []
      : (await client.query<{ id: number; title: string }>("SELECT id, title FROM documents WHERE id = ANY($1)", [ids])).rows;
  const titleOf = new Map(titles.map((t) => [t.id, t.title]));
  const rows = opened.rows
    .map((r) => ({ id: r.document_id, title: titleOf.get(r.document_id) ?? "", due_at: r.due_at }))
    .sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9") || a.title.localeCompare(b.title));
  return { added, closed, reopened, opened: rows };
}

/** The audit row for a policy whose audience moved (ack.audience_reconciled), written only when something did. A dynamic import: lib/audit imports this module. */
async function auditAudienceMoved(doc: { id: number; title: string }, r: ReconcileResult): Promise<void> {
  if (r.added + r.closed + r.reopened === 0) return;
  try {
    const { audit } = await import("./audit");
    await audit({
      actor: { id: null, name: "system" },
      action: "ack.audience_reconciled",
      targetType: "document",
      targetId: doc.id,
      targetLabel: doc.title,
      details: { doc_id: doc.id, added: r.added, closed: r.closed, reopened: r.reopened },
    });
  } catch (e) {
    console.error("[ack] could not audit the audience change:", e);
  }
}

async function reconcileEach(
  docs: { id: number; title: string }[],
  opts: { defaults: AudienceDefaults; auto: boolean; narrowing?: AudienceNarrowing }
): Promise<ReconcileResult> {
  const total: ReconcileResult = { added: 0, closed: 0, reopened: 0 };
  for (const d of docs) {
    const r = await reconcilePolicyAssignments(null, d.id, opts);
    total.added += r.added;
    total.closed += r.closed;
    total.reopened += r.reopened;
    await auditAudienceMoved(d, r);
  }
  return total;
}

/**
 * The hourly safety net (first in lib/compliance's complianceHourly):
 * every live policy against its audience, so a role granted or revoked in
 * Roles & permissions (not hooked: too many writers) takes effect within
 * the hour, and a settings row missing after a rolling deploy heals. One
 * ack.audience_reconciled row per policy whose rows moved.
 */
export async function reconcileAllPolicies(
  opts: { documentIds?: number[] } = {}
): Promise<ReconcileResult & { policies: number }> {
  await ready();
  const defaults = await workspaceAudienceDefaults();
  // `documentIds` limits the sweep (tests sharing a database); the tick passes nothing.
  const docs = await q<{ id: number; title: string }>(
    `SELECT d.id, d.title FROM documents d
     WHERE ${AUDIENCE_POLICY} AND ($1::int[] IS NULL OR d.id = ANY($1::int[]))
     ORDER BY d.id`,
    [opts.documentIds ?? null]
  );
  const total = await reconcileEach(docs, { defaults, auto: true });
  return { ...total, policies: docs.length };
}

/** What the group hooks moved since the last drain: the directory sync report's "Policy audiences updated: +12 / −3". */
const audienceSyncTally = { added: 0, closed: 0 };

/** Read and reset the tally. The scheduled sync drains it before and after a run; a manual group edit in between is counted with the run, which is the truth of what the hour changed. */
export function drainAudienceSyncTally(): { added: number; closed: number } {
  const out = { ...audienceSyncTally };
  audienceSyncTally.added = 0;
  audienceSyncTally.closed = 0;
  return out;
}

/**
 * A group's membership changed (a manual edit, an Entra or Google sync):
 * the policies with a rule naming the group, and every policy in a private
 * space (membership there reaches people through space.member and
 * space.read_all grants to groups, whichever role carries them).
 */
export async function reconcilePoliciesForGroup(groupId: number): Promise<ReconcileResult> {
  await ready();
  const defaults = await workspaceAudienceDefaults();
  const docs = await q<{ id: number; title: string }>(
    `SELECT d.id, d.title FROM documents d JOIN spaces s ON s.id = d.space_id
     WHERE ${AUDIENCE_POLICY}
       AND (s.visibility = 'private'
            OR EXISTS (SELECT 1 FROM policy_audience_rules r
                       WHERE r.document_id = d.id AND r.kind = 'group' AND r.ref = $1::text))
     ORDER BY d.id`,
    [String(groupId)]
  );
  const total = await reconcileEach(docs, { defaults, auto: true, narrowing: "left_group" });
  audienceSyncTally.added += total.added + total.reopened;
  audienceSyncTally.closed += total.closed;
  return total;
}

/** A space's visibility or its member grants changed: every live policy in it. */
export async function reconcilePoliciesForSpace(spaceId: number): Promise<ReconcileResult> {
  await ready();
  const defaults = await workspaceAudienceDefaults();
  const docs = await q<{ id: number; title: string }>(
    `SELECT d.id, d.title FROM documents d WHERE d.space_id = $1 AND ${AUDIENCE_POLICY} ORDER BY d.id`,
    [spaceId]
  );
  return reconcileEach(docs, { defaults, auto: true });
}

/**
 * An account's status flipped (updateUser, scimUpdateUser): disabling
 * closes every open row with 'disabled'; re-enabling re-opens them with a
 * fresh cycle and deadline, and opens rows for policies that admit the
 * person now. User-scoped, so it costs two statements whatever the
 * workspace's size.
 */
export async function reconcilePoliciesForUser(userId: number): Promise<ReconcileResult> {
  await ready();
  const defaults = await workspaceAudienceDefaults();
  const r = await reconcileUserOn(pool(), userId, { defaults, source: "rules", auto: true, close: true });
  if (r.added + r.closed + r.reopened > 0) {
    try {
      const { audit } = await import("./audit");
      const who = await getUserById(userId);
      await audit({
        actor: { id: null, name: "system" },
        action: "ack.audience_reconciled",
        targetType: "user",
        targetId: userId,
        targetLabel: who?.name || who?.username || String(userId),
        details: { user_id: userId, added: r.added, closed: r.closed, reopened: r.reopened, policies: r.opened.map((p) => p.id) },
      });
    } catch (e) {
      console.error("[ack] could not audit the audience change:", e);
    }
  }
  return { added: r.added, closed: r.closed, reopened: r.reopened };
}

/**
 * A new account (createUser, scimCreateUser, createSsoUser, beside
 * autoAssignTraining): a row for every policy whose audience admits them
 * and enrols new joiners, source 'new_member', due the new-joiner days from
 * now, never a past date; then one welcome notice listing them through the
 * outbox (lib/compliance notifyWelcome; a single policy goes as the usual
 * request) and ack.auto_enrolled {user_id, policies}. A disabled account
 * (a SCIM push with active: false) gets nothing: the target is active
 * people, and the status flip enrols them later.
 */
export async function autoAssignPolicies(
  userId: number
): Promise<{ policies: EnrolledPolicy[]; outbox_id: number | null }> {
  await ready();
  const defaults = await workspaceAudienceDefaults();
  const r = await reconcileUserOn(pool(), userId, { defaults, source: "new_member", auto: true, close: false });
  if (r.opened.length === 0) return { policies: [], outbox_id: null };
  try {
    const { audit } = await import("./audit");
    const who = await getUserById(userId);
    await audit({
      actor: { id: null, name: "system" },
      action: "ack.auto_enrolled",
      targetType: "user",
      targetId: userId,
      targetLabel: who?.name || who?.username || String(userId),
      details: { user_id: userId, policies: r.opened.map((p) => p.id), titles: r.opened.map((p) => p.title) },
    });
  } catch (e) {
    console.error("[ack] could not audit the enrolment:", e);
  }
  let outboxId: number | null = null;
  try {
    const { notifyWelcome } = await import("./compliance");
    outboxId = await notifyWelcome(userId, r.opened);
  } catch (e) {
    console.error("[ack] could not queue the welcome notice:", e);
  }
  return { policies: r.opened, outbox_id: outboxId };
}

/** The audience half of policy_settings with its rules, as the Settings tab and GET /ack-settings read it. */
export interface PolicyAudience {
  audience_mode: AudienceMode;
  rules: AudienceRule[];
  exclude_stewards: boolean;
  assign_new_members: boolean;
}

/** What saveAudienceRules accepts: any subset; `rules` replaces the whole list. */
export interface PolicyAudiencePatch {
  audience_mode?: AudienceMode;
  rules?: AudienceRule[];
  exclude_stewards?: boolean;
  assign_new_members?: boolean;
}

/** The saved rules of a policy, in the order they were written. */
export async function listAudienceRules(docId: number): Promise<AudienceRule[]> {
  return q<AudienceRule>(
    "SELECT kind, ref, effect FROM policy_audience_rules WHERE document_id = $1 ORDER BY id",
    [docId]
  );
}

async function policyAudienceOn(client: Queryable, docId: number): Promise<PolicyAudience | null> {
  const s = await client.query<{ audience_mode: string; exclude_stewards: number; assign_new_members: number }>(
    "SELECT audience_mode, exclude_stewards, assign_new_members FROM policy_settings WHERE document_id = $1",
    [docId]
  );
  const row = s.rows[0];
  if (!row) return null;
  const rules = await client.query<AudienceRule>(
    "SELECT kind, ref, effect FROM policy_audience_rules WHERE document_id = $1 ORDER BY id",
    [docId]
  );
  return {
    audience_mode: row.audience_mode === "targeted" ? "targeted" : "space",
    rules: rules.rows,
    exclude_stewards: row.exclude_stewards === 1,
    assign_new_members: row.assign_new_members === 1,
  };
}

/** The policy's audience; null when it has no settings row yet (then it is in space mode with the defaults). */
export async function getPolicyAudience(docId: number): Promise<PolicyAudience | null> {
  await ready();
  return policyAudienceOn(pool(), docId);
}

/** The whole policy_settings row (the deadline and reminder numbers are the E1/E2 agents' to write); null without one. */
export async function getPolicySettings(docId: number): Promise<PolicySettings | null> {
  const r = await q<PolicySettings>(
    `SELECT document_id, audience_mode, assign_new_members, exclude_stewards, owner_user_id,
            due_days, due_at::text AS due_at, remind_before_days, remind_every_days, escalate_after_days,
            nudge_every_days, requested_by, requested_at
     FROM policy_settings WHERE document_id = $1`,
    [docId]
  );
  return r[0] ?? null;
}

/** The deadline (E1) and reminder (E2) columns of policy_settings a PATCH /ack-settings may set: null = inherit; a key absent = untouched. */
export interface PolicySettingsNumbersPatch {
  due_days?: number | null;
  /** A fixed deadline as 'YYYY-MM-DD'. */
  due_at?: string | null;
  remind_before_days?: number | null;
  remind_every_days?: number | null;
  escalate_after_days?: number | null;
  nudge_every_days?: number | null;
  owner_user_id?: number | null;
}

/**
 * Write a policy's own deadline rule, reminder cadence and owner (the
 * Settings tab's Deadline and Reminders cards, wave 2 of 1.13.0). The row is
 * created when the policy has none yet (a 1.12.0 switch-on), only the keys
 * present are touched, and the row is answered as stored. Null when the
 * document is gone. The caller moves deadlines (movePolicyDeadlines) and
 * audits; nothing here reconciles or notifies.
 */
export async function updatePolicySettings(
  docId: number,
  patch: PolicySettingsNumbersPatch
): Promise<PolicySettings | null> {
  const exists = await q("SELECT 1 FROM documents WHERE id = $1", [docId]);
  if (exists.length === 0) return null;
  await q("INSERT INTO policy_settings (document_id) VALUES ($1) ON CONFLICT (document_id) DO NOTHING", [docId]);
  const has = (key: keyof PolicySettingsNumbersPatch) => Object.prototype.hasOwnProperty.call(patch, key);
  await q(
    `UPDATE policy_settings
        SET due_days = CASE WHEN $2::boolean THEN $3::int ELSE due_days END,
            due_at = CASE WHEN $4::boolean THEN $5::date ELSE due_at END,
            remind_before_days = CASE WHEN $6::boolean THEN $7::int ELSE remind_before_days END,
            remind_every_days = CASE WHEN $8::boolean THEN $9::int ELSE remind_every_days END,
            escalate_after_days = CASE WHEN $10::boolean THEN $11::int ELSE escalate_after_days END,
            nudge_every_days = CASE WHEN $12::boolean THEN $13::int ELSE nudge_every_days END,
            owner_user_id = CASE WHEN $14::boolean THEN $15::int ELSE owner_user_id END
      WHERE document_id = $1`,
    [
      docId,
      has("due_days"),
      patch.due_days ?? null,
      has("due_at"),
      patch.due_at ?? null,
      has("remind_before_days"),
      patch.remind_before_days ?? null,
      has("remind_every_days"),
      patch.remind_every_days ?? null,
      has("escalate_after_days"),
      patch.escalate_after_days ?? null,
      has("nudge_every_days"),
      patch.nudge_every_days ?? null,
      has("owner_user_id"),
      patch.owner_user_id ?? null,
    ]
  );
  return getPolicySettings(docId);
}

/**
 * Save a policy's audience (PATCH /ack-settings with audience_mode, rules,
 * exclude_stewards, assign_new_members) and reconcile its rows in the same
 * transaction, so the toast's counts are what the save did. `rules` must
 * already be sanitizeRules' output. Answers the audience as stored with the
 * counts, or null when the document is gone. The caller audits
 * ack.audience_set {mode, rules, added, closed}.
 */
export async function saveAudienceRules(
  docId: number,
  patch: PolicyAudiencePatch
): Promise<(PolicyAudience & ReconcileResult) | null> {
  await ready();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const exists = await client.query("SELECT 1 FROM documents WHERE id = $1", [docId]);
    if (exists.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      "INSERT INTO policy_settings (document_id) VALUES ($1) ON CONFLICT (document_id) DO NOTHING",
      [docId]
    );
    await client.query(
      `UPDATE policy_settings
       SET audience_mode = COALESCE($2::text, audience_mode),
           exclude_stewards = COALESCE($3::int, exclude_stewards),
           assign_new_members = COALESCE($4::int, assign_new_members)
       WHERE document_id = $1`,
      [
        docId,
        patch.audience_mode ?? null,
        patch.exclude_stewards === undefined ? null : patch.exclude_stewards ? 1 : 0,
        patch.assign_new_members === undefined ? null : patch.assign_new_members ? 1 : 0,
      ]
    );
    if (patch.rules) {
      await client.query("DELETE FROM policy_audience_rules WHERE document_id = $1", [docId]);
      if (patch.rules.length > 0) {
        await client.query(
          `INSERT INTO policy_audience_rules (document_id, kind, ref, effect)
           SELECT $1, r.kind, r.ref, r.effect
           FROM jsonb_to_recordset($2::jsonb) AS r(kind text, ref text, effect text)
           ON CONFLICT DO NOTHING`,
          [docId, JSON.stringify(patch.rules)]
        );
      }
    }
    const counts = await reconcilePolicyOn(client, docId, { auto: false });
    const state = await policyAudienceOn(client, docId);
    await client.query("COMMIT");
    return { ...(state as PolicyAudience), ...counts };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** What GET /ack-settings?preview=1 answers: the audience a draft of the rules would reach. */
export interface AudiencePreview {
  /** Active people the rules name who can see the space: the rows a save would hold open. */
  count: number;
  /** Active people a targeted rule names who cannot see the space (0 in space mode): shown as "No access", not enrolled. */
  no_access: number;
  /** The first five names, alphabetically. */
  sample: string[];
}

/**
 * Count an audience without writing it: the Settings tab's live line
 * "Applies to 412 people · 3 without access". The same predicates as the
 * reconcile over rules from the request (sanitizeRules first), so the
 * preview and the save cannot disagree.
 */
export async function previewAudience(
  docId: number,
  input: { audience_mode: AudienceMode; rules: AudienceRule[]; exclude_stewards: boolean }
): Promise<AudiencePreview> {
  await ready();
  const a = audienceSql(audienceRulesFromJson("$2"), "$3::text", "$4::boolean");
  const r = await q<{ count: number; no_access: number; sample: string[] | null }>(
    `WITH cand AS (
       SELECT u.name, (${ACK_VISIBILITY}) AS visible
       FROM documents d JOIN spaces s ON s.id = d.space_id, users u
       WHERE d.id = $1 AND u.status = 'active' AND ${audienceAdmitsSql(a)}
     )
     SELECT COUNT(*) FILTER (WHERE visible)::int AS count,
            COUNT(*) FILTER (WHERE NOT visible AND $3::text = 'targeted')::int AS no_access,
            (SELECT array_agg(x.name) FROM (SELECT c.name FROM cand c WHERE c.visible ORDER BY c.name LIMIT 5) x) AS sample
     FROM cand`,
    [docId, JSON.stringify(input.rules), input.audience_mode, input.exclude_stewards]
  );
  const row = r[0];
  return { count: row?.count ?? 0, no_access: row?.no_access ?? 0, sample: row?.sample ?? [] };
}

/** Does this policy ask this person right now (an open row)? The ack route's and the document page's gate. */
export async function hasOpenAssignment(docId: number, userId: number): Promise<boolean> {
  const r = await q<{ one: number }>(
    `SELECT 1 AS one FROM policy_assignments pa WHERE pa.document_id = $1 AND pa.user_id = $2 AND ${PA_OPEN}`,
    [docId, userId]
  );
  return r.length > 0;
}

/**
 * The policies a person owes right now: open rows of an active account on
 * published, required, unretired policies with no current confirmation,
 * earliest deadline first. The welcome notice lists these at delivery, so
 * a policy confirmed or retired between enqueue and the tick is not named.
 */
export async function listOwedPoliciesFor(userId: number): Promise<EnrolledPolicy[]> {
  return q<EnrolledPolicy>(
    `SELECT d.id, d.title, pa.due_at
     FROM policy_assignments pa
     JOIN users u ON u.id = pa.user_id
     JOIN documents d ON d.id = pa.document_id
     WHERE pa.user_id = $1 AND ${PA_OWES}
       AND d.ack_required = 1 AND d.status = 'published' AND d.deleted_at IS NULL
       AND d.branch_of IS NULL AND d.ack_retired_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = pa.user_id AND ${ACK_CURRENT_PA}
       )
     ORDER BY pa.due_at NULLS LAST, d.title, d.id`,
    [userId]
  );
}

/** The notice rows one outbox row wrote for one person (a welcome writes one per policy): a retry adds its channel to each. */
export async function ackNoticeIdsFor(outboxId: number, userId: number): Promise<number[]> {
  const rows = await q<{ id: number }>("SELECT id FROM ack_notices WHERE outbox_id = $1 AND user_id = $2 ORDER BY id", [
    outboxId,
    userId,
  ]);
  return rows.map((r) => r.id);
}

// --- Retire a policy (G3, 1.12.0) -------------------------------------------------
//
// An end-of-life state beside `status`, not inside it: a retired policy keeps
// every confirmation, its marker and its ledger, stops asking anyone, and
// says when, by whom, why and which policy replaced it. The requirement is
// switched off in the same UPDATE that stamps the retirement, so nothing
// between the two can ask a reader to confirm a policy that is ending.
// Un-retire is the one way back: setAckRequired and the portal's Request
// never touch a retired policy (ackCandidateDocs leaves it out, PATCH /ack
// answers 409).

/** The error a cancelled outbox row carries (done_at set, nothing sent). */
export const ACK_OUTBOX_CANCELLED_RETIRED = "cancelled: policy retired";

/** What retirePolicy answers: the standing frozen on the ledger row. */
export interface RetireResult {
  title: string;
  /** documents.ack_retired_at, also the ledger row's decided_at. */
  retired_at: string;
  /** The marker at retirement: the version people had been asked to confirm, and its number. */
  version_id: number | null;
  rev: number | null;
  /** Confirmations current at that moment, of the audience then (the ledger row's confirmations_affected / eligible). */
  acked: number;
  required: number;
  decision_id: number;
  /** Queued notices for this policy (not yet claimed by a drain) that were cancelled. */
  cancelled: number;
  /** documents.ack_superseded_by as it stood (set beforehand through setSupersededBy). */
  superseded_by: number | null;
}

/**
 * Retire a policy: one UPDATE switches the requirement off and stamps the
 * retirement, guarded on `ack_retired_at IS NULL`, so a second call (two
 * tabs, two managers) gets no row and answers null (the route's 409).
 * ack_revision_at and ack_version_id are left as they are, so the final
 * roster stays reproducible from the append-only ledger. In the same
 * transaction: the policy's queued notices are cancelled (done_at set with
 * ACK_OUTBOX_CANCELLED_RETIRED as the error, the column the drain treats as
 * finished, so a reminder queued an hour ago never reaches anyone about a
 * policy that has ended; a row a drain has already claimed finishes under
 * its own rules, and the drain's deliverable check skips it), and the
 * 'retired' ledger row is written with the counts taken BEFORE the update
 * (afterwards the policy asks nobody and the number would mean nothing),
 * carrying the retirement stamp as its decided_at. Returns null when the
 * document is gone or already retired.
 */
export async function retirePolicy(docId: number, actor: AckActor, reason: string): Promise<RetireResult | null> {
  await ready();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    // Counted before the flip: the final standing, as of the moment the
    // policy stopped asking.
    const counts = await ackCounts(client, docId);
    const moved = await client.query<{
      title: string;
      retired_at: string;
      ack_version_id: number | null;
      ack_superseded_by: number | null;
      rev: number | null;
    }>(
      `UPDATE documents
         SET ack_required = 0, ack_retired_at = now(),
             ack_retired_by = $2, ack_retired_by_name = $3, ack_retired_reason = $4
       WHERE id = $1 AND ack_retired_at IS NULL
       RETURNING title, ack_retired_at::text AS retired_at, ack_version_id, ack_superseded_by,
                 ${VERSION_REV("documents.ack_version_id")} AS rev`,
      [docId, actor.id, actor.name, reason]
    );
    if (moved.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = moved.rows[0];
    const cancelled = await client.query(
      `UPDATE ack_outbox SET done_at = now(), error = $2
       WHERE document_id = $1 AND done_at IS NULL AND claimed_at IS NULL`,
      [docId, ACK_OUTBOX_CANCELLED_RETIRED]
    );
    const decisionId = await recordAckDecision(client, {
      ...decisionColumns(
        docId,
        row.title,
        "retired",
        { versionId: row.ack_version_id, actor, source: "manual", reason },
        counts
      ),
      decided_at: row.retired_at,
    });
    await client.query("COMMIT");
    return {
      title: row.title,
      retired_at: row.retired_at,
      version_id: row.ack_version_id,
      rev: row.rev,
      acked: counts.current,
      required: counts.eligible,
      decision_id: decisionId,
      cancelled: cancelled.rowCount ?? 0,
      superseded_by: row.ack_superseded_by,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Resume a retired policy: the five retirement columns are cleared (the
 * replacement too: a policy that is live again is not replaced by anything)
 * and the requirement switches back on. The marker is untouched, so every
 * confirmation made before it was retired is current again unless the text
 * changed while it was retired (a save with the requirement off advances
 * the marker silently, A2 rule 3, so those people are asked again rather
 * than shown as 100% for words they never read). An unpublished document
 * resumes as Paused (G2). Answers the standing after the switch, or null
 * when the document is gone or not retired (the route's 409).
 */
export async function unretirePolicy(docId: number): Promise<{ title: string; current: number; eligible: number } | null> {
  await ready();
  const r = await q<{ title: string }>(
    `UPDATE documents
       SET ack_required = 1, ack_retired_at = NULL, ack_retired_by = NULL,
           ack_retired_by_name = '', ack_retired_reason = '', ack_superseded_by = NULL,
           ${RECERT_NEXT_ON_RESUME}
     WHERE id = $1 AND ack_retired_at IS NOT NULL AND deleted_at IS NULL
     RETURNING title`,
    [docId]
  );
  if (!r[0]) return null;
  // The audience (D1): retiring left the rows as they were; people who
  // joined or left while the policy was retired are brought in line now.
  await reconcilePolicyAssignments(null, docId, { auto: false });
  const counts = await ackCounts(pool(), docId);
  return { title: r[0].title, current: counts.current, eligible: counts.eligible };
}

/**
 * Name the policy that replaces this one (the Lifecycle card's "Replaced
 * by", PATCH /ack-settings { superseded_by }), or clear it with null. The
 * target must be a published, live, non-branch document other than this
 * one, inside `scope` when the caller passes theirs (spaceScopeFor), so a
 * manager cannot point readers at a document they may not see. Answers
 * the value before and after for the audit row, with the target's title,
 * or the first problem in a sentence the route can return as its 400.
 */
export async function setSupersededBy(
  docId: number,
  supersededBy: number | null,
  scope?: SpaceScope
): Promise<{ ok: true; from: number | null; to: number | null; to_title: string | null } | { ok: false; error: string }> {
  await ready();
  let toTitle: string | null = null;
  if (supersededBy !== null) {
    if (!Number.isInteger(supersededBy) || supersededBy <= 0) {
      return { ok: false, error: "'superseded_by' must be a document id or null." };
    }
    if (supersededBy === docId) return { ok: false, error: "A policy cannot be replaced by itself." };
    const scoped = scope !== undefined && Array.isArray(scope);
    const target = await q<{ title: string }>(
      `SELECT d.title FROM documents d
       WHERE d.id = $1 AND d.status = 'published' AND d.deleted_at IS NULL AND d.branch_of IS NULL
         ${scoped ? "AND d.space_id = ANY($2)" : ""}`,
      scoped ? [supersededBy, scope] : [supersededBy]
    );
    if (!target[0]) return { ok: false, error: "The replacement must be a published document you can see." };
    toTitle = target[0].title;
  }
  const r = await q<{ before: number | null; after: number | null }>(
    `UPDATE documents d SET ack_superseded_by = $2
     FROM (SELECT id, ack_superseded_by AS before FROM documents WHERE id = $1 AND deleted_at IS NULL) o
     WHERE d.id = o.id
     RETURNING o.before, d.ack_superseded_by AS after`,
    [docId, supersededBy]
  );
  if (!r[0]) return { ok: false, error: "Document not found." };
  return { ok: true, from: r[0].before, to: r[0].after, to_title: toTitle };
}

/** The portal's Retired group: every retired policy, as complianceDocs lists it (counts frozen at retirement). */
export async function listRetiredPolicies(): Promise<ComplianceDocRow[]> {
  return (await complianceDocs()).filter((d) => d.ack_retired_at !== null);
}

/**
 * Record a read confirmation (append-only). The reader declares the version
 * they read; the row is inserted only when that is still the document's
 * latest version and the marker has not moved past it — otherwise `stale`
 * and the caller answers 409 so the page reloads into what changed. The hash
 * is taken from that doc_versions row's text, never from documents.content,
 * so a row can never cite words the person did not see. The name, email and
 * title snapshots are written on every insert (C5).
 *
 * The checks and the insert run in one transaction that first locks the
 * document row. A save that is resetting the marker holds the same lock for
 * the length of its own transaction, so this either runs before it (and the
 * reset then stamps a wall-clock marker later than this row, which goes
 * stale) or after it (and the checks see the committed new version and
 * marker, so the old version is refused). Without the lock a confirmation
 * could land inside the reset's window citing the old text while counting
 * as current. The row's own stamp is the wall clock at insert, not the
 * transaction start, for the same reason.
 *
 * A second row is accepted when the person's current confirmation cites an
 * older version than the latest (a kept edit): the ledger keeps both, and
 * the newer one is what the record shows.
 *
 * `evidence` (C3, 1.11.0) is what the row records beside the version: the
 * read time the caller summed on the server (readSecondsSince; null when no
 * view was recorded) and the reader's own reached-the-end report. The
 * route derives the first and parses the second; this function stores
 * them as given, whole seconds and a 1/0 flag.
 *
 * The attestation fields (C2, 1.12.0) ride in the same object: the
 * statement the server served (never the client's text), the typed name
 * and identity proof when the policy required a signature, and the
 * browser's User-Agent. A caller shaped like 1.11.x passes none and the
 * row takes the column defaults ('' / NULL), which is also what a 1.11.2
 * binary writes during a rollback.
 */
export interface AckEvidence {
  /** Seconds the document was open on screen for this person since everyone was last asked; null when unknown. */
  readSeconds?: number | null;
  /** The card's self-reported latch: the end of the text was on screen (or focus entered the card). */
  reachedEnd?: boolean;
  /** The confirmation statement the server served for this document (the policy's own, else the workspace default). */
  statementText?: string;
  /** The typed name when the policy required a signature; null (the default) on an unsigned row. */
  signedName?: string | null;
  /** How the signer was identified (lib/attestation's IdentityProof); '' on an unsigned row. */
  identityProof?: AckIdentityProof | "";
  /** The browser's User-Agent header, first 300 characters; '' when unknown. */
  userAgent?: string;
}

/** How a signed confirmation's identity was asserted (lib/attestation). */
export type AckIdentityProof = "password" | "sso_session" | "typed_name_only";

export async function recordAcknowledgement(
  docId: number,
  userId: number,
  ip: string,
  versionId: number,
  evidence: AckEvidence = {}
): Promise<{ recorded: boolean; stale: boolean }> {
  await ready();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const doc = (
      await client.query<{ ack_version_id: number | null }>(
        "SELECT ack_version_id FROM documents WHERE id = $1 FOR UPDATE",
        [docId]
      )
    ).rows[0];
    if (!doc) {
      await client.query("ROLLBACK");
      return { recorded: false, stale: true };
    }
    const current = await currentAckRow(client, docId, userId);
    if (current && current.version_id === versionId) {
      await client.query("ROLLBACK");
      return { recorded: false, stale: false };
    }
    const latest =
      (
        await client.query<{ id: number | null }>(
          "SELECT MAX(id) AS id FROM doc_versions WHERE document_id = $1",
          [docId]
        )
      ).rows[0]?.id ?? null;
    const version = (
      await client.query<{ content: string }>(
        "SELECT content FROM doc_versions WHERE id = $1 AND document_id = $2",
        [versionId, docId]
      )
    ).rows[0];
    if (!version || latest !== versionId || (doc.ack_version_id !== null && doc.ack_version_id > versionId)) {
      await client.query("ROLLBACK");
      return { recorded: false, stale: true };
    }
    const sha = createHash("sha256").update(version.content).digest("hex");
    const readSeconds = storedReadSeconds(evidence.readSeconds);
    const reachedEnd = evidence.reachedEnd === true ? 1 : 0;
    // The attestation fields (C2): stored as given, bounded like the ip.
    const statementText = typeof evidence.statementText === "string" ? evidence.statementText : "";
    const signedName =
      typeof evidence.signedName === "string" && evidence.signedName.trim() ? evidence.signedName.trim().slice(0, 200) : null;
    const identityProof = signedName ? (evidence.identityProof ?? "") : "";
    const userAgent = typeof evidence.userAgent === "string" ? evidence.userAgent.slice(0, 300) : "";
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO acknowledgements
         (document_id, user_id, ip, version_id, content_sha256, user_name, user_email, document_title, acknowledged_at,
          read_seconds, reached_end, statement_text, signed_name, identity_proof, user_agent)
       SELECT d.id, u.id, $3, $4, $5, u.name, u.email, d.title, clock_timestamp(), $6, $7, $8, $9, $10, $11
       FROM documents d
       JOIN users u ON u.id = $2
       WHERE d.id = $1
       RETURNING id`,
      [docId, userId, ip.slice(0, 100), versionId, sha, readSeconds, reachedEnd, statementText, signedName, identityProof, userAgent]
    );
    if (inserted.rowCount === 0) {
      await client.query("ROLLBACK");
      return { recorded: false, stale: true };
    }
    await client.query("COMMIT");
    return { recorded: true, stale: false };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface CurrentAck {
  acknowledged_at: string;
  /** The version confirmed; null only on a pre-1.10 row no version could be inferred for. */
  version_id: number | null;
  /** 1-based position of that version in Version history ("v12"); null when version_id is null or the version is gone. */
  rev: number | null;
  /** SHA-256 of the version text at confirmation; null on inferred rows. */
  content_sha256: string | null;
  /** The typed name on a signed confirmation (C2); null on an unsigned row. */
  signed_name: string | null;
}

/** The user's confirmation that is current against the doc's marker, if any. */
export async function getCurrentAck(docId: number, userId: number): Promise<CurrentAck | undefined> {
  await ready();
  return currentAckRow(pool(), docId, userId);
}

/**
 * getCurrentAck on a given client (recordAcknowledgement asks inside its own
 * transaction). Current against the later of the document marker and the
 * person's own cycle start (D1/D4, 1.13.0) when they have an assignment row
 * (LEFT JOIN: a person with no row, or a closed one, is measured against
 * the marker alone), so the card and the roster agree after a per-person
 * re-ask or a return to the audience.
 */
async function currentAckRow(client: Queryable, docId: number, userId: number): Promise<CurrentAck | undefined> {
  const r = await client.query<CurrentAck>(
    `SELECT a.acknowledged_at, a.version_id, a.content_sha256, a.signed_name,
            ${VERSION_REV("a.version_id")} AS rev
     FROM acknowledgements a
     JOIN documents d ON d.id = a.document_id
     LEFT JOIN policy_assignments pa ON pa.document_id = a.document_id AND pa.user_id = a.user_id AND pa.removed_at IS NULL
     WHERE a.document_id = $1 AND a.user_id = $2 AND ${ACK_CURRENT_PA}
     ORDER BY a.acknowledged_at DESC, a.id DESC LIMIT 1`,
    [docId, userId]
  );
  return r.rows[0];
}

export interface LatestAck extends CurrentAck {
  /**
   * True when the row carries no version and the version was worked out
   * from the confirmation time (a confirmation from before 1.10.0, or one
   * made on 1.9.x during a rollback): the newest version that existed when
   * the person confirmed. Surfaces say "(version inferred)".
   */
  version_inferred: boolean;
  /** True while the row counts against the marker (the row getCurrentAck returns); false once everyone was asked again. */
  current: boolean;
}

/**
 * The person's newest confirmation of a document, current or lapsed (B3,
 * 1.11.0): what "This document changed since you confirmed it on 3 Mar"
 * compares against. getCurrentAck answers "does a confirmation count";
 * this answers "what did they last confirm", so the page can diff the
 * live text against that version. Served by idx_ack_doc (document_id,
 * user_id, acknowledged_at DESC).
 */
export async function getLatestAck(docId: number, userId: number): Promise<LatestAck | undefined> {
  await ready();
  const r = await pool().query<LatestAck>(
    `SELECT a.acknowledged_at,
            COALESCE(a.version_id, inf.id) AS version_id,
            (a.version_id IS NULL AND inf.id IS NOT NULL) AS version_inferred,
            a.content_sha256, a.signed_name,
            ${VERSION_REV("COALESCE(a.version_id, inf.id)")} AS rev,
            (${ACK_CURRENT_PA}) AS current
     FROM acknowledgements a
     JOIN documents d ON d.id = a.document_id
     LEFT JOIN policy_assignments pa ON pa.document_id = a.document_id AND pa.user_id = a.user_id AND pa.removed_at IS NULL
     LEFT JOIN LATERAL (
       SELECT MAX(x.id) AS id FROM doc_versions x
       WHERE x.document_id = a.document_id AND x.created_at <= a.acknowledged_at
     ) inf ON true
     WHERE a.document_id = $1 AND a.user_id = $2
     ORDER BY a.acknowledged_at DESC, a.id DESC LIMIT 1`,
    [docId, userId]
  );
  return r.rows[0];
}

export interface AckVersionInfo {
  /** The version everyone is asked to confirm (documents.ack_version_id; the latest version when unset). */
  version_id: number | null;
  rev: number | null;
  created_at: string | null;
  author: string;
  /** The document's newest version: what POST /ack must cite. Equal to version_id except after a kept edit. */
  latest_version_id: number | null;
  latest_rev: number | null;
  /** When and by whom the newest version was written (the card's meta line follows the text on screen). */
  latest_created_at: string | null;
  latest_author: string;
  /**
   * Provenance of the marker's version (C6): who published it (the author
   * byline when the version predates the stamp) and who approved it ('' when
   * it did not come through a change request, or predates 1.10.1 without a
   * legacy approval note).
   */
  published_by_name: string;
  approved_by_name: string;
  /** The same for the newest version. */
  latest_published_by_name: string;
  latest_approved_by_name: string;
}

/** The marker's version for a document, with its Version-history number, and the newest version beside it. */
export async function getAckVersionInfo(docId: number): Promise<AckVersionInfo> {
  const row = (
    await q<AckVersionInfo>(
      `SELECT COALESCE(d.ack_version_id, l.latest) AS version_id,
              ${VERSION_REV("COALESCE(d.ack_version_id, l.latest)")} AS rev,
              v.created_at, COALESCE(v.author, '') AS author,
              l.latest AS latest_version_id,
              ${VERSION_REV("l.latest")} AS latest_rev,
              lv.created_at AS latest_created_at, COALESCE(lv.author, '') AS latest_author,
              COALESCE(NULLIF(v.published_by_name, ''), v.author, '') AS published_by_name,
              COALESCE(v.approved_by_name, '') AS approved_by_name,
              COALESCE(NULLIF(lv.published_by_name, ''), lv.author, '') AS latest_published_by_name,
              COALESCE(lv.approved_by_name, '') AS latest_approved_by_name
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT MAX(x.id) AS latest FROM doc_versions x WHERE x.document_id = d.id
       ) l ON true
       LEFT JOIN doc_versions v ON v.id = COALESCE(d.ack_version_id, l.latest)
       LEFT JOIN doc_versions lv ON lv.id = l.latest
       WHERE d.id = $1`,
      [docId]
    )
  )[0];
  return (
    row ?? {
      version_id: null,
      rev: null,
      created_at: null,
      author: "",
      latest_version_id: null,
      latest_rev: null,
      latest_created_at: null,
      latest_author: "",
      published_by_name: "",
      approved_by_name: "",
      latest_published_by_name: "",
      latest_approved_by_name: "",
    }
  );
}

export interface AckStatusRow {
  id: number;
  name: string;
  username: string;
  email: string;
  role: string;
  acknowledged_at: string | null;
  version_id: number | null;
  rev: number | null;
  content_sha256: string | null;
  version_source: AckVersionSource | null;
  /**
   * Reading evidence (C3): seconds the document was open on screen for this
   * person since everyone was last asked, summed on the server when they
   * confirmed. null while pending, when no view was recorded, and on rows
   * from before 1.11.0.
   */
  read_seconds: number | null;
  /** The reader's own report that the end of the text was on screen. null while pending. */
  reached_end: boolean | null;
  /**
   * The attestation (C2, 1.12.0): the statement the person agreed to as the
   * server served it ('' on rows from before 1.12.0), the typed name when
   * the policy required a signature, and how the signer was identified
   * ('password' | 'sso_session' | 'typed_name_only'; '' unsigned). All
   * three null while pending.
   */
  statement_text: string | null;
  signed_name: string | null;
  identity_proof: string | null;
  /**
   * The person's assignment row (D1/D2, 1.13.0): its id (what the roster's
   * actions send), the deadline (null when the policy sets none), whether
   * the row is exempt (then it is in no count) with the reason, who recorded
   * it, when and until when ('' / null when not exempt), when a snooze ends
   * (null when not snoozed), and the per-person cycle start when it is later
   * than both the document marker and the row's own assignment (a per-person
   * re-ask, D4, or a row re-opened when the person returned; null on a row
   * first assigned after the marker, whose cycle simply began then).
   */
  assignment_id: number | null;
  due_at: string | null;
  exempt: boolean;
  exempt_reason: string;
  exempt_by_name: string;
  exempt_at: string | null;
  exempt_until: string | null;
  snoozed_until: string | null;
  asked_again_at: string | null;
  /**
   * The per-person re-ask behind asked_again_at (D4): the reason the manager
   * gave and their name, from the ledger row the claim wrote at the same
   * instant (ack_decisions, outcome 'reset', scope 'users', decided_at =
   * the row's cycle_started_at). '' when the cycle restarted for another
   * reason (the person re-joined the audience) or asked_again_at is null.
   */
  asked_again_reason: string;
  asked_again_by: string;
}

/**
 * Compliance status: everyone who is expected to confirm the doc (active
 * accounts that can see its space) with their current confirmation, if any,
 * and their assignment row beside it (exempt rows last). A confirmation is
 * current against the later of the document marker and the person's own
 * cycle start (D4), so a per-person re-ask shows that person pending and
 * nobody else. The re-ask's reason rides along from the ledger: the claim
 * stamps the rows and its decision row with one clock_timestamp(), so the
 * equality join is exact (handoff-reask.md).
 */
export async function ackStatusForDocument(docId: number): Promise<AckStatusRow[]> {
  return q(
    `SELECT u.id, u.name, u.username, u.email, u.role,
            a.acknowledged_at, a.version_id, a.content_sha256,
            ${VERSION_REV("a.version_id")} AS rev,
            CASE WHEN a.acknowledged_at IS NULL THEN NULL
                 ELSE ${VERSION_SOURCE("a.content_sha256")} END AS version_source,
            a.read_seconds,
            CASE WHEN a.acknowledged_at IS NULL THEN NULL ELSE (a.reached_end = 1) END AS reached_end,
            a.statement_text, a.signed_name, a.identity_proof,
            pa.id AS assignment_id, pa.due_at,
            (pa.exempt_at IS NOT NULL) AS exempt,
            COALESCE(pa.exempt_reason, '') AS exempt_reason,
            COALESCE(pa.exempt_by_name, '') AS exempt_by_name,
            pa.exempt_at, pa.exempt_until, pa.snoozed_until,
            CASE WHEN pa.cycle_started_at > d.ack_revision_at AND pa.cycle_started_at > pa.assigned_at
                 THEN pa.cycle_started_at END AS asked_again_at,
            CASE WHEN pa.cycle_started_at > d.ack_revision_at AND pa.cycle_started_at > pa.assigned_at
                 THEN COALESCE(reask.reason, '') ELSE '' END AS asked_again_reason,
            CASE WHEN pa.cycle_started_at > d.ack_revision_at AND pa.cycle_started_at > pa.assigned_at
                 THEN COALESCE(reask.decided_by_name, '') ELSE '' END AS asked_again_by
     FROM policy_assignments pa
     JOIN users u ON u.id = pa.user_id
     JOIN documents d ON d.id = pa.document_id
     LEFT JOIN LATERAL (
       SELECT a.acknowledged_at, a.version_id, a.content_sha256, a.read_seconds, a.reached_end,
              a.statement_text, a.signed_name, a.identity_proof
       FROM acknowledgements a
       WHERE a.document_id = d.id AND a.user_id = u.id AND ${ACK_CURRENT_PA}
       ORDER BY a.acknowledged_at DESC, a.id DESC LIMIT 1
     ) a ON true
     LEFT JOIN LATERAL (
       SELECT x.reason, x.decided_by_name FROM ack_decisions x
       WHERE x.document_id = d.id AND x.outcome = 'reset' AND x.scope = 'users'
         AND x.decided_at = pa.cycle_started_at
       ORDER BY x.id DESC LIMIT 1
     ) reask ON true
     WHERE pa.document_id = $1 AND pa.removed_at IS NULL AND u.status = 'active'
     ORDER BY (pa.exempt_at IS NOT NULL), (a.acknowledged_at IS NULL) DESC, u.name`,
    [docId]
  );
}

export interface AckFormerStaffRow {
  /** The newest confirmation row for this person. */
  id: number;
  user_id: number | null;
  name: string;
  email: string;
  username: string;
  role: string;
  /** 'left' = the account is gone (user_id NULL); 'disabled' = the account exists but is disabled. */
  reason: "left" | "disabled";
  acknowledged_at: string;
  /** Whether that confirmation is current against the marker (for the record; never counted). */
  current: boolean;
  version_id: number | null;
  rev: number | null;
  content_sha256: string | null;
  version_source: AckVersionSource;
  /** Reading evidence (C3), as on AckStatusRow; null when no view was recorded or the row predates 1.11.0. */
  read_seconds: number | null;
  /** The reader's own report that the end of the text was on screen. */
  reached_end: boolean;
  /** The attestation (C2), as on AckStatusRow: the statement served ('' before 1.12.0), the typed name (null unsigned) and the identity proof ('' unsigned). */
  statement_text: string;
  signed_name: string | null;
  identity_proof: string;
}

/**
 * Confirmations by people who are no longer in the audience: deleted
 * accounts (user_id NULL, shown from the name snapshot) and disabled ones.
 * One row per person, their newest confirmation. Read separately so the
 * eligible-user joins above stay simple; never part of the denominator.
 */
export async function ackFormerStaffRows(docId: number): Promise<AckFormerStaffRow[]> {
  return q(
    `SELECT DISTINCT ON (x.grp)
            x.id, x.user_id,
            COALESCE(NULLIF(x.user_name, ''), NULLIF(u.name, ''), u.username, '') AS name,
            COALESCE(NULLIF(x.user_email, ''), u.email, '') AS email,
            COALESCE(u.username, '') AS username,
            COALESCE(u.role, '') AS role,
            CASE WHEN x.user_id IS NULL THEN 'left' ELSE 'disabled' END AS reason,
            x.acknowledged_at,
            (x.acknowledged_at >= d.ack_revision_at) AS current,
            x.version_id, x.content_sha256,
            ${VERSION_REV("x.version_id")} AS rev,
            ${VERSION_SOURCE("x.content_sha256")} AS version_source,
            x.read_seconds, (x.reached_end = 1) AS reached_end,
            x.statement_text, x.signed_name, x.identity_proof
     FROM (
       SELECT a.*, COALESCE(a.user_id::text, 'gone:' || a.user_name || '|' || a.user_email) AS grp
       FROM acknowledgements a WHERE a.document_id = $1
     ) x
     JOIN documents d ON d.id = x.document_id
     LEFT JOIN users u ON u.id = x.user_id
     WHERE x.user_id IS NULL OR u.status <> 'active'
     ORDER BY x.grp, x.acknowledged_at DESC, x.id DESC`,
    [docId]
  );
}

// --- Per-policy confirmation settings (C2, 1.12.0) ---------------------------
//
// The Settings tab of the Read confirmation page edits two columns on the
// document: its own confirmation statement (NULL = the workspace default,
// compliance_statement_default) and whether readers sign with a typed name.
// Wave 2 adds the re-confirmation interval and the lifecycle fields through
// their own setters (setAckRecert, setSupersededBy); this pair stays what
// the statement card needs. Neither touches updated_at: a settings change
// is not an edit of the text, so it must not read as a conflict.

export interface AckSettings {
  /** The policy's own confirmation statement; null = the workspace default. */
  statement: string | null;
  /** Whether the reader types their full name (and a local account its password) to confirm. */
  signature: boolean;
}

// --- Exemptions, extensions and snooze (D2, 1.13.0) ---------------------------
//
// Per-assignment levers on policy_assignments. Each is one UPDATE bounded
// by the ids given and, when a document is named (`docId`, the space-scoped
// twin route), by `pa.document_id = $docId` as well, so a steward of one
// space can never move another space's rows by guessing ids; every call
// answers which ids it skipped. Nothing here deletes a row, and nothing
// here touches the acknowledgements ledger: who confirmed what stays as
// recorded whatever happens to the assignment.
//
// Exempt rows leave every denominator: PA_OPEN (the open-row predicate the
// compliance queries share) excludes them, so the portal, the record, My
// policies and the sweeps stop counting the person the moment the row is
// stamped, and the roster shows the row with status 'exempt' and the
// reason, who recorded it and until when, in plain text.
//
// The invariant (printed on the roster and in the docs): snooze never
// changes a person's status, the KPIs, the rosters, the exports or the
// snapshot. It only pauses automatic reminders (claimAckReminders skips a
// snoozed row) and, once the needs-attention queue ships, hides the row
// from it. Overdue is a function of due_at and the confirmation alone.

/** One row a lever changed: enough for the audit row without a second read. */
export interface AssignmentChange {
  id: number;
  document_id: number;
  user_id: number;
  /** The policy's title, for the audit row's target label. */
  title: string;
}

/** What every lever answers: the rows it changed and the ids it did not. */
export interface AssignmentResult<T extends AssignmentChange = AssignmentChange> {
  changed: T[];
  /**
   * Ids given that no row answered: unknown, another document than the one
   * named, removed, or already in the state asked for (exempting an exempt
   * row, unsnoozing a row that is not snoozed, undoing with nothing to undo).
   */
  skipped: number[];
}

/** A due-date change on a row, for ack.due_extended / ack.due_extension_undone. */
export interface AssignmentDueChange extends AssignmentChange {
  from_at: string | null;
  to_at: string | null;
}

/** One entry of policy_assignments.due_history, newest last; the last 10 are kept. */
export interface DueHistoryEntry {
  /** 'extend' for the roster's Extend (undoExtension pops only these); other writers name their own kind. */
  kind?: string;
  from: string | null;
  to: string | null;
  /** Who moved it (the actor's name) and when. */
  by: string;
  by_id?: number | null;
  at: string;
  reason: string;
}

/** An assignment row as the roster and the levers read it (open and exempt rows; removed rows are history). */
export interface PolicyAssignmentRow {
  id: number;
  document_id: number;
  user_id: number;
  source: string;
  assigned_at: string;
  cycle_started_at: string;
  due_at: string | null;
  due_history: DueHistoryEntry[];
  reminded_at: string | null;
  reminder_count: number;
  escalated_at: string | null;
  snoozed_until: string | null;
  snoozed_by: number | null;
  exempt_at: string | null;
  exempt_by: number | null;
  exempt_by_name: string;
  exempt_reason: string;
  exempt_until: string | null;
}

/** The longest exemption reason the record keeps (the roster's dialog bounds it the same). */
export const EXEMPT_REASON_MAX = 300;
/** A snooze pauses reminders for at most this many days. */
export const SNOOZE_DAYS_MAX = 30;
/** An extension pushes a deadline out by at most this many days. */
export const EXTEND_DAYS_MAX = 365;
/** due_history keeps this many entries per row, newest last. */
export const DUE_HISTORY_KEEP = 10;

/** Positive integer ids, deduped, in the order given. */
function uniqueIds(ids: readonly unknown[]): number[] {
  const out: number[] = [];
  for (const v of ids) {
    if (typeof v === "number" && Number.isSafeInteger(v) && v > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The ids of `wanted` that no changed row answers. */
function skippedOf(wanted: number[], changed: { id: number }[]): number[] {
  const done = new Set(changed.map((r) => r.id));
  return wanted.filter((id) => !done.has(id));
}

/** A day count clamped to 1..max, whole days. */
const clampDays = (days: number, max: number) => Math.min(max, Math.max(1, Math.floor(days)));

/**
 * The workspace's default deadline in days (ack_defaults.due_days, E1), or
 * null when unset or unreadable so the SQL falls through to the built-in
 * 14. Read raw here because this module owns the settings table and the
 * typed reader (lib/compliance-settings) is server-only.
 */
async function workspaceDueDays(): Promise<number | null> {
  try {
    const raw = await getSetting("ack_defaults");
    const v = raw ? (JSON.parse(raw) as { due_days?: unknown }).due_days : undefined;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 365 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The deadline a row gets back when its exemption ends (unexemptAssignments,
 * expireExemptions): the policy's fixed date while it is still ahead, else
 * now plus the days of the defaults cascade (E1): policy_settings.due_days,
 * the space's policy_defaults, the workspace ack_defaults (the parameter),
 * then the built-in 14. dueAtFor applies the same rule in TypeScript; it is
 * SQL here so one UPDATE re-arms every row it clears. Needs `ps`
 * (policy_settings, LEFT JOINed) and `s` (spaces) in the FROM list.
 */
const PA_REARM_DUE = (workspaceParam: string) => `CASE
      WHEN ps.due_at IS NOT NULL AND ps.due_at > CURRENT_DATE THEN ps.due_at::timestamptz
      ELSE now() + make_interval(days => COALESCE(ps.due_days, (s.policy_defaults->>'due_days')::int, ${workspaceParam}::int, 14))
    END`;

/** The FROM list the re-arming statements share: the policy, its space and its settings row. */
const PA_REARM_FROM = `FROM documents d
    JOIN spaces s ON s.id = d.space_id
    LEFT JOIN policy_settings ps ON ps.document_id = d.id`;

/** The assignment rows of a policy the roster shows: open and exempt, removed rows left out. */
export async function listAssignmentsForDocument(docId: number): Promise<PolicyAssignmentRow[]> {
  return q(
    `SELECT id, document_id, user_id, source, assigned_at, cycle_started_at, due_at, due_history,
            reminded_at, reminder_count, escalated_at, snoozed_until, snoozed_by,
            exempt_at, exempt_by, exempt_by_name, exempt_reason, exempt_until
     FROM policy_assignments
     WHERE document_id = $1 AND removed_at IS NULL
     ORDER BY id`,
    [docId]
  );
}

export interface ExemptResult extends AssignmentResult {
  /**
   * Ids among the request that are the actor's own row. When any is, the
   * whole call is refused and nothing is written (the route answers 400:
   * "Ask another compliance manager to record your exemption.").
   */
  self: number[];
}

/**
 * Exempt open rows: the person leaves every denominator until the exemption
 * is removed or expires. `reason` is required by the routes and kept to
 * EXEMPT_REASON_MAX; `until` is a date (YYYY-MM-DD) or null for a standing
 * exemption. A snooze or an escalation on the row is moot while it is
 * exempt, so both are cleared. A manager cannot exempt their own row.
 */
export async function exemptAssignments(
  docId: number | null,
  ids: number[],
  actor: AckActor,
  opts: { reason: string; until: string | null }
): Promise<ExemptResult> {
  const wanted = uniqueIds(ids);
  if (!wanted.length) return { changed: [], skipped: [], self: [] };
  await ready();
  if (actor.id != null) {
    const own = await q<{ id: number }>(
      `SELECT id FROM policy_assignments
       WHERE id = ANY($1) AND user_id = $2 AND ($3::int IS NULL OR document_id = $3)`,
      [wanted, actor.id, docId]
    );
    if (own.length) return { changed: [], skipped: wanted, self: own.map((r) => r.id) };
  }
  const changed = await q<AssignmentChange>(
    `UPDATE policy_assignments pa
        SET exempt_at = now(), exempt_by = $3, exempt_by_name = $4, exempt_reason = $5,
            exempt_until = $6::timestamptz,
            snoozed_until = NULL, snoozed_by = NULL, escalated_at = NULL
       FROM documents d
      WHERE d.id = pa.document_id AND pa.id = ANY($1) AND ($2::int IS NULL OR pa.document_id = $2)
        AND pa.removed_at IS NULL AND pa.exempt_at IS NULL
      RETURNING pa.id, pa.document_id, pa.user_id, d.title`,
    [wanted, docId, actor.id, actor.name.slice(0, 200), opts.reason.trim().slice(0, EXEMPT_REASON_MAX), opts.until || null]
  );
  return { changed, skipped: skippedOf(wanted, changed), self: [] };
}

/**
 * Remove exemptions: the rows return to pending with a fresh deadline from
 * the cascade (PA_REARM_DUE), and the reminder and escalation stamps are
 * cleared so the new deadline gets its own reminders. The exemption's
 * history stays in the audit log; the row itself carries only its current
 * state.
 */
export async function unexemptAssignments(docId: number | null, ids: number[]): Promise<AssignmentResult<AssignmentDueChange>> {
  const wanted = uniqueIds(ids);
  if (!wanted.length) return { changed: [], skipped: [] };
  const workspace = await workspaceDueDays();
  const changed = await q<AssignmentDueChange>(
    `UPDATE policy_assignments pa
        SET exempt_at = NULL, exempt_by = NULL, exempt_by_name = '', exempt_reason = '', exempt_until = NULL,
            due_at = ${PA_REARM_DUE("$3")},
            reminded_at = NULL, escalated_at = NULL
       ${PA_REARM_FROM}
      WHERE d.id = pa.document_id AND pa.id = ANY($1) AND ($2::int IS NULL OR pa.document_id = $2)
        AND pa.removed_at IS NULL AND pa.exempt_at IS NOT NULL
      RETURNING pa.id, pa.document_id, pa.user_id, d.title, NULL::text AS from_at, pa.due_at AS to_at`,
    [wanted, docId, workspace]
  );
  return { changed, skipped: skippedOf(wanted, changed) };
}

/**
 * Push open rows' deadlines out by `days` (1..EXTEND_DAYS_MAX): due_at =
 * GREATEST(COALESCE(due_at, now()), now()) + days, so an overdue row counts
 * from today and a row still ahead keeps its lead. Clears the escalation
 * and any snooze (the new date starts clean) and appends {kind: 'extend',
 * from, to, by, at, reason} to due_history, keeping the last
 * DUE_HISTORY_KEEP. Exempt rows are skipped: they have no deadline to move.
 */
export async function extendAssignments(
  docId: number | null,
  ids: number[],
  days: number,
  reason: string,
  actor: AckActor
): Promise<AssignmentResult<AssignmentDueChange>> {
  const wanted = uniqueIds(ids);
  if (!wanted.length) return { changed: [], skipped: [] };
  const by = clampDays(days, EXTEND_DAYS_MAX);
  const changed = await q<AssignmentDueChange>(
    `UPDATE policy_assignments pa
        SET due_at = GREATEST(COALESCE(pa.due_at, now()), now()) + make_interval(days => $3),
            escalated_at = NULL, snoozed_until = NULL, snoozed_by = NULL,
            due_history = (CASE WHEN jsonb_typeof(pa.due_history) = 'array' AND jsonb_array_length(pa.due_history) >= $7
                                THEN pa.due_history - 0
                                WHEN jsonb_typeof(pa.due_history) = 'array' THEN pa.due_history
                                ELSE '[]'::jsonb END)
              || jsonb_build_array(jsonb_build_object(
                   'kind', 'extend',
                   'from', pa.due_at,
                   'to', GREATEST(COALESCE(pa.due_at, now()), now()) + make_interval(days => $3),
                   'by', $5::text, 'by_id', $6::int, 'at', now(), 'reason', $4::text))
       FROM documents d
      WHERE d.id = pa.document_id AND pa.id = ANY($1) AND ($2::int IS NULL OR pa.document_id = $2)
        AND pa.removed_at IS NULL AND pa.exempt_at IS NULL
      RETURNING pa.id, pa.document_id, pa.user_id, d.title,
                pa.due_history -> -1 ->> 'from' AS from_at, pa.due_at AS to_at`,
    [wanted, docId, by, reason.trim().slice(0, ACK_REASON_MAX), actor.name.slice(0, 200), actor.id, DUE_HISTORY_KEEP]
  );
  return { changed, skipped: skippedOf(wanted, changed) };
}

/**
 * The inverse of extendAssignments (the toast's Undo): the newest
 * due_history entry, when it is an 'extend', is popped and its `from` is
 * the deadline again. A row whose newest entry is not an extension (a
 * deadline moved by the policy's rule, E1) is skipped rather than guessed
 * at. `from_at` on the answer is the date undone, `to_at` the one restored.
 */
export async function undoExtension(docId: number | null, ids: number[]): Promise<AssignmentResult<AssignmentDueChange>> {
  const wanted = uniqueIds(ids);
  if (!wanted.length) return { changed: [], skipped: [] };
  const changed = await q<AssignmentDueChange>(
    `WITH last AS (
       SELECT id, due_history -> -1 AS entry FROM policy_assignments WHERE id = ANY($1)
     )
     UPDATE policy_assignments pa
        SET due_at = (pa.due_history -> -1 ->> 'from')::timestamptz,
            due_history = pa.due_history - (-1)
       FROM last l, documents d
      WHERE pa.id = l.id AND d.id = pa.document_id AND ($2::int IS NULL OR pa.document_id = $2)
        AND pa.removed_at IS NULL AND pa.exempt_at IS NULL
        AND jsonb_typeof(pa.due_history) = 'array' AND jsonb_array_length(pa.due_history) > 0
        AND pa.due_history -> -1 ->> 'kind' = 'extend'
      RETURNING pa.id, pa.document_id, pa.user_id, d.title,
                l.entry ->> 'to' AS from_at, pa.due_at AS to_at`,
    [wanted, docId]
  );
  return { changed, skipped: skippedOf(wanted, changed) };
}

/**
 * Pause automatic reminders on open rows for `days` (1..SNOOZE_DAYS_MAX).
 * Nothing else changes: the status, the counts, the record and the exports
 * read exactly as before (the invariant above). An exempt row is skipped:
 * it gets no reminders to pause.
 */
export async function snoozeAssignments(
  docId: number | null,
  ids: number[],
  days: number,
  actor: AckActor
): Promise<AssignmentResult<AssignmentChange & { snoozed_until: string }>> {
  const wanted = uniqueIds(ids);
  if (!wanted.length) return { changed: [], skipped: [] };
  const changed = await q<AssignmentChange & { snoozed_until: string }>(
    `UPDATE policy_assignments pa
        SET snoozed_until = now() + make_interval(days => $3), snoozed_by = $4
       FROM documents d
      WHERE d.id = pa.document_id AND pa.id = ANY($1) AND ($2::int IS NULL OR pa.document_id = $2)
        AND pa.removed_at IS NULL AND pa.exempt_at IS NULL
      RETURNING pa.id, pa.document_id, pa.user_id, d.title, pa.snoozed_until`,
    [wanted, docId, clampDays(days, SNOOZE_DAYS_MAX), actor.id]
  );
  return { changed, skipped: skippedOf(wanted, changed) };
}

/** Resume automatic reminders on snoozed rows (the inverse of snoozeAssignments). */
export async function unsnoozeAssignments(docId: number | null, ids: number[]): Promise<AssignmentResult> {
  const wanted = uniqueIds(ids);
  if (!wanted.length) return { changed: [], skipped: [] };
  const changed = await q<AssignmentChange>(
    `UPDATE policy_assignments pa
        SET snoozed_until = NULL, snoozed_by = NULL
       FROM documents d
      WHERE d.id = pa.document_id AND pa.id = ANY($1) AND ($2::int IS NULL OR pa.document_id = $2)
        AND pa.removed_at IS NULL AND pa.snoozed_until IS NOT NULL
      RETURNING pa.id, pa.document_id, pa.user_id, d.title`,
    [wanted, docId]
  );
  return { changed, skipped: skippedOf(wanted, changed) };
}

/**
 * The hourly sweep's half (complianceHourly runs it after reconciling):
 * exemptions whose `until` has passed are cleared and the rows re-armed
 * exactly as unexemptAssignments re-arms them. One UPDATE: a second
 * instance's statement re-reads each row after the lock, finds exempt_at
 * already NULL and matches nothing. Returns the rows it cleared so the
 * caller can audit each (ack.exemption_revoked by the system); standing
 * exemptions (no `until`) are never touched here.
 */
export async function expireExemptions(): Promise<AssignmentDueChange[]> {
  const workspace = await workspaceDueDays();
  return q<AssignmentDueChange>(
    `UPDATE policy_assignments pa
        SET exempt_at = NULL, exempt_by = NULL, exempt_by_name = '', exempt_reason = '', exempt_until = NULL,
            due_at = ${PA_REARM_DUE("$1")},
            reminded_at = NULL, escalated_at = NULL
       ${PA_REARM_FROM}
      WHERE d.id = pa.document_id
        AND pa.exempt_at IS NOT NULL AND pa.exempt_until IS NOT NULL AND pa.exempt_until < now()
        AND pa.removed_at IS NULL
      RETURNING pa.id, pa.document_id, pa.user_id, d.title, NULL::text AS from_at, pa.due_at AS to_at`,
    [workspace]
  );
}

/**
 * The rows a per-person re-ask may reach (the assignments routes' 'reask'):
 * open rows on live policies (published, required, not retired), bounded by
 * the document when one is named. The routes group them by policy and hand
 * each group to claimReconfirmation's userIds branch (D4), which moves the
 * people's cycle marker, writes the ledger row and queues their notice.
 */
export async function reaskableAssignments(docId: number | null, ids: number[]): Promise<AssignmentChange[]> {
  const wanted = uniqueIds(ids);
  if (!wanted.length) return [];
  return q<AssignmentChange>(
    `SELECT pa.id, pa.document_id, pa.user_id, d.title
       FROM policy_assignments pa
       JOIN documents d ON d.id = pa.document_id
      WHERE pa.id = ANY($1) AND ($2::int IS NULL OR pa.document_id = $2)
        AND pa.removed_at IS NULL AND pa.exempt_at IS NULL
        AND d.status = 'published' AND d.ack_required = 1 AND d.deleted_at IS NULL AND d.ack_retired_at IS NULL
      ORDER BY pa.document_id, pa.id`,
    [wanted, docId]
  );
}

/** What updateAckSettings accepts: any subset; `statement: null` clears the override. */
export interface AckSettingsPatch {
  statement?: string | null;
  signature?: boolean;
}

/** The two per-policy settings; undefined when the document does not exist. */
export async function getAckSettings(docId: number): Promise<AckSettings | undefined> {
  await ready();
  const row = (
    await q<{ ack_statement: string | null; ack_signature: number }>(
      "SELECT ack_statement, ack_signature FROM documents WHERE id = $1",
      [docId]
    )
  )[0];
  return row ? { statement: row.ack_statement, signature: row.ack_signature === 1 } : undefined;
}

/**
 * Write the given fields and answer what the document now holds. The
 * statement is stored as given (the route trims and bounds it; an empty
 * string is stored as NULL so it can never shadow the default with nothing).
 */
export async function updateAckSettings(docId: number, patch: AckSettingsPatch): Promise<AckSettings | undefined> {
  await ready();
  const sets: string[] = [];
  const params: unknown[] = [docId];
  if (patch.statement !== undefined) {
    params.push(patch.statement === null || patch.statement === "" ? null : patch.statement);
    sets.push(`ack_statement = $${params.length}`);
  }
  if (patch.signature !== undefined) {
    params.push(patch.signature ? 1 : 0);
    sets.push(`ack_signature = $${params.length}`);
  }
  if (sets.length === 0) return getAckSettings(docId);
  const row = (
    await q<{ ack_statement: string | null; ack_signature: number }>(
      `UPDATE documents SET ${sets.join(", ")} WHERE id = $1 RETURNING ack_statement, ack_signature`,
      params
    )
  )[0];
  return row ? { statement: row.ack_statement, signature: row.ack_signature === 1 } : undefined;
}

/**
 * One row of the confirmation ledger (C4, 1.12.0): an acknowledgements row
 * as recorded, with the person as they are today. The current view
 * (ackStatusForDocument) shows one row per person, their newest
 * confirmation that counts against the marker; the ledger shows every row
 * ever written for the document, newest first, including the ones the
 * current view no longer shows (`superseded`) and rows whose account or
 * document is gone (shown from the row's own snapshot).
 */
export interface AckLedgerRow {
  /** The acknowledgements row. */
  id: number;
  /** NULL once the document was purged (the title snapshot still names it). */
  document_id: number | null;
  /** The live title, or the row's snapshot when the document is gone. */
  document_title: string;
  space_name: string;
  user_id: number | null;
  /** The account's live name (its username when the name is blank), or the row's snapshot once the account is gone. */
  name: string;
  username: string;
  /** The live email, or the row's snapshot once the account is gone. */
  email: string;
  role: string;
  /** True when the account is gone (user_id NULL): name and email are the row's snapshot. */
  account_removed: boolean;
  acknowledged_at: string;
  /** True while the row counts against the document's marker (false once the document is gone). */
  current: boolean;
  /**
   * True when the current view does not show this row: a later confirmation
   * by the same person exists (a re-confirmation after a kept edit, or after
   * the marker moved), or the marker moved past it. A purged document's rows
   * are superseded only by a later row of the same person.
   */
  superseded: boolean;
  version_id: number | null;
  rev: number | null;
  content_sha256: string | null;
  version_source: AckVersionSource;
  /** The confirmation statement the person saw (C2); '' on rows from before 1.12.0. */
  statement_text: string;
  /** The name they typed when the policy required a signature (C2); null otherwise. */
  signed_name: string | null;
  /** How the signer was identified (C2): 'password', 'sso_session', 'typed_name_only'; '' when unsigned. */
  identity_proof: string;
  read_seconds: number | null;
  reached_end: boolean;
  /** Personal data: the routes blank both unless the caller holds compliance.export. */
  ip: string;
  user_agent: string;
}

/**
 * The ledger SELECT shared by the one-document and the every-document
 * reads. `where` filters the inner scan (the row number that marks a
 * superseded row is taken per document and person, so the filter must not
 * split a person's rows); `order` closes the statement. Served by
 * idx_ack_doc for one document; the every-document read is an export and
 * scans the table.
 */
function ackLedgerSql(where: string, order: string): string {
  return `SELECT x.id, x.document_id,
            COALESCE(d.title, x.document_title, '') AS document_title,
            COALESCE(s.name, '') AS space_name,
            x.user_id,
            COALESCE(NULLIF(u.name, ''), u.username, NULLIF(x.user_name, ''), '') AS name,
            COALESCE(u.username, '') AS username,
            COALESCE(u.email, x.user_email, '') AS email,
            COALESCE(u.role, '') AS role,
            (x.user_id IS NULL) AS account_removed,
            x.acknowledged_at,
            (d.id IS NOT NULL AND x.acknowledged_at >= d.ack_revision_at) AS current,
            (x.rn > 1 OR (d.id IS NOT NULL AND x.acknowledged_at < d.ack_revision_at)) AS superseded,
            x.version_id, x.content_sha256,
            ${VERSION_REV("x.version_id")} AS rev,
            ${VERSION_SOURCE("x.content_sha256")} AS version_source,
            x.statement_text, x.signed_name, x.identity_proof,
            x.read_seconds, (x.reached_end = 1) AS reached_end,
            x.ip, x.user_agent
     FROM (
       SELECT a.*,
              ROW_NUMBER() OVER (
                PARTITION BY a.document_id, COALESCE(a.user_id::text, 'gone:' || a.user_name || '|' || a.user_email)
                ORDER BY a.acknowledged_at DESC, a.id DESC
              ) AS rn
       FROM acknowledgements a${where}
     ) x
     LEFT JOIN documents d ON d.id = x.document_id
     LEFT JOIN spaces s ON s.id = d.space_id
     LEFT JOIN users u ON u.id = x.user_id
     ORDER BY ${order}`;
}

/** Every confirmation ever recorded for one document, newest first (the All confirmations view and the per-document ledger CSV). */
export async function listAckLedger(docId: number): Promise<AckLedgerRow[]> {
  return q(ackLedgerSql(" WHERE a.document_id = $1", "x.acknowledged_at DESC, x.id DESC"), [docId]);
}

/**
 * Every confirmation ever recorded, over every document including purged
 * ones (the workspace ledger CSV): grouped by document title, newest first
 * within each.
 */
export async function listAckLedgerAll(): Promise<AckLedgerRow[]> {
  return q(
    ackLedgerSql("", "COALESCE(d.title, x.document_title, ''), x.document_id NULLS LAST, x.acknowledged_at DESC, x.id DESC")
  );
}

// ── My policies (B4, 1.12.0) ────────────────────────────────────────────────
// What one person is asked to confirm, read four ways: the dashboard row and
// the sidebar badge (the pending ones), the My policies page and its API (every
// policy in scope with where the person stands), and the nav gate (is there a
// policy to see at all). One document predicate feeds all four so they cannot
// disagree: published, requiring confirmation, not a working copy, not in the
// trash and not retired. The retired test reads the column rather than relying
// on retirePolicy's `ack_required = 0`, the way the recert sweep's WHERE does. A
// paused policy (G2) is unpublished and so never owed; a retired one (G3) keeps
// its record but asks nobody. Alias `d`.

const MY_POLICY_DOC = `d.ack_required = 1 AND d.status = 'published' AND d.deleted_at IS NULL
       AND d.branch_of IS NULL AND d.ack_retired_at IS NULL`;

/** `AND d.space_id = ANY($n)` for a list scope; nothing for "all". */
function myPolicyScope(scope: SpaceScope, param: number): string {
  return Array.isArray(scope) ? ` AND d.space_id = ANY($${param})` : "";
}

/**
 * The workspace's overdue grace (ack_defaults.overdue_grace_days, 0..90) as
 * stored, or null for the built-in; read raw the way workspaceDueDays reads
 * due_days, because the typed reader (lib/compliance-settings) is
 * server-only and this file is not.
 */
async function workspaceOverdueGraceDays(): Promise<number | null> {
  try {
    const raw = await getSetting("ack_defaults");
    const v = raw ? (JSON.parse(raw) as { overdue_grace_days?: unknown }).overdue_grace_days : undefined;
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 90 ? v : null;
  } catch {
    return null;
  }
}

/**
 * One open row's overdue test (E1, 1.13.0): its due date plus the policy's
 * grace has passed. The grace resolves the cascade's way (lib/ack-due
 * resolveDefaults; policy_settings carries no grace column, so the policy
 * layer never sets it): the space's policy_defaults, else the workspace's
 * ack_defaults (the parameter), else the built-in 0; a space value that is
 * not a whole number of days in range reads as unset, as sanitizeLayer
 * reads it. Needs `pa` and `s` (spaces) in scope; the caller adds "and no
 * current confirmation".
 */
function paOverdueSql(workspaceParam: string): string {
  return `pa.due_at IS NOT NULL AND pa.due_at + make_interval(days => COALESCE(
      CASE WHEN s.policy_defaults->>'overdue_grace_days' ~ '^\\d{1,2}$'
            AND (s.policy_defaults->>'overdue_grace_days')::int <= 90
           THEN (s.policy_defaults->>'overdue_grace_days')::int END,
      ${workspaceParam}::int, 0)) < now()`;
}

/** The parameters of a My policies query: the person, the scope when it is a list, and the workspace grace last. */
function myPolicyParams(userId: number, scope: SpaceScope, grace: number | null): { params: unknown[]; graceParam: string } {
  const params: unknown[] = Array.isArray(scope) ? [userId, scope, grace] : [userId, grace];
  return { params, graceParam: `$${params.length}` };
}

/** The dashboard's row (listPendingAcksFor): one policy the person has not confirmed the current ask of. */
export interface PendingAckRow {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
  /** The person's deadline on this policy (their open row, E1); null without one. */
  due_at: string | null;
  /** The deadline plus the policy's grace has passed (E1). */
  overdue: boolean;
}

/**
 * Published ack-required docs in the user's scope they haven't confirmed
 * yet (the dashboard row), in the person's own priority: overdue first,
 * then the soonest deadline, then the most recently changed (the order My
 * policies uses for its To confirm group, so the dashboard's three titles
 * are the page's first three). Unlimited since 1.12.0: the dashboard shows
 * the count, and the count must be the truth.
 */
export async function listPendingAcksFor(userId: number, scope: SpaceScope): Promise<PendingAckRow[]> {
  const { params, graceParam } = myPolicyParams(userId, scope, await workspaceOverdueGraceDays());
  return q(
    `SELECT d.id, d.title, s.name AS space_name, s.icon AS space_icon, pa.due_at,
            (${paOverdueSql(graceParam)}) AS overdue
     FROM policy_assignments pa
     JOIN documents d ON d.id = pa.document_id
     JOIN spaces s ON s.id = d.space_id
     WHERE pa.user_id = $1 AND ${PA_OPEN} AND ${MY_POLICY_DOC}${myPolicyScope(scope, 2)}
       AND NOT EXISTS (
         SELECT 1 FROM acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = $1 AND ${ACK_CURRENT_PA}
       )
     ORDER BY (${paOverdueSql(graceParam)}) DESC, pa.due_at ASC NULLS LAST, d.updated_at DESC, d.id DESC`,
    params
  );
}

/**
 * Where a person stands on one policy. 'pending': never confirmed the current
 * ask; 'reconfirm': confirmed before, and the marker moved since (an edit, a
 * manual re-ask or the annual cycle); 'overdue' (E1, 1.13.0): either of
 * those once the deadline plus the policy's grace has passed; 'confirmed': a
 * confirmation on or after the marker (never overdue, however old the date).
 */
export type MyPolicyState = "pending" | "reconfirm" | "overdue" | "confirmed";

export interface MyPolicyRow {
  id: number;
  title: string;
  space_icon: string;
  space_name: string;
  state: MyPolicyState;
  /** The current confirmation's time; null unless 'confirmed'. */
  acknowledged_at: string | null;
  /** The newest confirmation from before the marker moved (the one that lapsed, or the previous cycle's); null when there is none. */
  prior_acknowledged_at: string | null;
  /** The version number the current confirmation cites ("v12"); null unless 'confirmed'. */
  rev: number | null;
  /** The person's deadline on this policy (their open row, E1); null without one. */
  due_at: string | null;
  updated_at: string;
}

/**
 * The My policies page (B4): every policy in the person's scope with their
 * current confirmation and their latest earlier one. To-confirm rows first,
 * in the person's priority (E1): overdue ones, then the soonest deadline,
 * then the most recently changed (updated_at, the date each row prints);
 * the confirmed ones follow, most recently changed first. Both confirmations
 * come from one indexed probe each (idx_ack_doc / idx_ack_user), so the page
 * costs two index lookups per policy, not a scan of the person's history.
 */
export async function listMyPolicies(userId: number, scope: SpaceScope): Promise<MyPolicyRow[]> {
  const { params, graceParam } = myPolicyParams(userId, scope, await workspaceOverdueGraceDays());
  return q(
    `SELECT d.id, d.title, s.icon AS space_icon, s.name AS space_name,
            CASE WHEN cur.acknowledged_at IS NOT NULL THEN 'confirmed'
                 WHEN ov.overdue THEN 'overdue'
                 WHEN prior.acknowledged_at IS NOT NULL THEN 'reconfirm'
                 ELSE 'pending' END AS state,
            cur.acknowledged_at,
            prior.acknowledged_at AS prior_acknowledged_at,
            ${VERSION_REV("cur.version_id")} AS rev,
            pa.due_at,
            d.updated_at
     FROM policy_assignments pa
     JOIN documents d ON d.id = pa.document_id
     JOIN spaces s ON s.id = d.space_id
     LEFT JOIN LATERAL (
       SELECT a.acknowledged_at, a.version_id FROM acknowledgements a
       WHERE a.document_id = d.id AND a.user_id = $1 AND ${ACK_CURRENT_PA}
       ORDER BY a.acknowledged_at DESC, a.id DESC LIMIT 1
     ) cur ON true
     LEFT JOIN LATERAL (
       SELECT a.acknowledged_at FROM acknowledgements a
       WHERE a.document_id = d.id AND a.user_id = $1
         AND a.acknowledged_at < GREATEST(d.ack_revision_at, pa.cycle_started_at)
       ORDER BY a.acknowledged_at DESC, a.id DESC LIMIT 1
     ) prior ON true
     CROSS JOIN LATERAL (SELECT (${paOverdueSql(graceParam)}) AS overdue) ov
     WHERE pa.user_id = $1 AND ${PA_OPEN} AND ${MY_POLICY_DOC}${myPolicyScope(scope, 2)}
     ORDER BY (cur.acknowledged_at IS NOT NULL),
              CASE WHEN cur.acknowledged_at IS NULL THEN ov.overdue END DESC NULLS LAST,
              CASE WHEN cur.acknowledged_at IS NULL THEN pa.due_at END ASC NULLS LAST,
              d.updated_at DESC, d.id DESC`,
    params
  );
}

/** The sidebar badge: how many policies in scope the person has not confirmed the current ask of. Equals listPendingAcksFor's length. */
export async function countPendingAcksFor(userId: number, scope: SpaceScope): Promise<number> {
  const r = await q<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM policy_assignments pa
     JOIN documents d ON d.id = pa.document_id
     WHERE pa.user_id = $1 AND ${PA_OPEN} AND ${MY_POLICY_DOC}${myPolicyScope(scope, 2)}
       AND NOT EXISTS (
         SELECT 1 FROM acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = $1 AND ${ACK_CURRENT_PA}
       )`,
    Array.isArray(scope) ? [userId, scope] : [userId]
  );
  return r[0]?.n ?? 0;
}

/**
 * The dashboard's "· 2 overdue" (E1, 1.13.0): how many of the policies
 * countPendingAcksFor counts are past their deadline and the policy's
 * grace. Equals the overdue rows of listPendingAcksFor and the 'overdue'
 * rows of listMyPolicies.
 */
export async function countOverdueAcksFor(userId: number, scope: SpaceScope): Promise<number> {
  const { params, graceParam } = myPolicyParams(userId, scope, await workspaceOverdueGraceDays());
  const r = await q<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM policy_assignments pa
     JOIN documents d ON d.id = pa.document_id
     JOIN spaces s ON s.id = d.space_id
     WHERE pa.user_id = $1 AND ${PA_OPEN} AND ${MY_POLICY_DOC}${myPolicyScope(scope, 2)}
       AND ${paOverdueSql(graceParam)}
       AND NOT EXISTS (
         SELECT 1 FROM acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = $1 AND ${ACK_CURRENT_PA}
       )`,
    params
  );
  return r[0]?.n ?? 0;
}

/**
 * The nav gate: does any policy in this person's scope ask them? One
 * EXISTS over their open assignment rows (D1, 1.13.0: being in scope no
 * longer means being asked), so a workspace whose policies all live in
 * spaces the person cannot see, or whose audiences leave them out, never
 * shows them the item, and the item does not flicker off once everything
 * is confirmed (a confirmed row is still open).
 */
export async function hasPolicyInScope(userId: number, scope: SpaceScope): Promise<boolean> {
  if (scope !== "all" && scope.length === 0) return false;
  const r = await q<{ some: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM policy_assignments pa
       JOIN documents d ON d.id = pa.document_id
       WHERE pa.user_id = $1 AND ${PA_OPEN} AND ${MY_POLICY_DOC}${myPolicyScope(scope, 2)}
     ) AS some`,
    Array.isArray(scope) ? [userId, scope] : [userId]
  );
  return r[0]?.some === true;
}

/** The reader's own open row on one policy (D1, E1, D4): what the document page needs beside their confirmation. */
export interface MyAssignment {
  /** The person's deadline; null without one. */
  due_at: string | null;
  /** When this row's cycle started: enrolment, or the per-person re-ask / return that restarted it. */
  cycle_started_at: string;
  /**
   * The per-person re-ask that restarted the cycle (D4): the ledger row
   * (outcome 'reset', scope 'users') stamped at the same instant as the
   * row, which the claim writes from one clock reading. Null when the cycle
   * started otherwise (enrolment, a return to the audience).
   */
  asked_again: { decided_at: string; decided_by_name: string; reason: string } | null;
}

/**
 * Does this policy ask this person right now, and on what terms: their open
 * row (not removed, not exempt) with its deadline and cycle, or null (no
 * card, no strip row, no sticky control; POST /ack answers 400). The
 * document page reads this instead of hasOpenAssignment so one probe serves
 * the gate, the due cues and the reason for a lapse.
 */
export async function getMyAssignment(docId: number, userId: number): Promise<MyAssignment | null> {
  const r = await q<{
    due_at: string | null;
    cycle_started_at: string;
    decided_at: string | null;
    decided_by_name: string | null;
    reason: string | null;
  }>(
    `SELECT pa.due_at, pa.cycle_started_at, reask.decided_at, reask.decided_by_name, reask.reason
     FROM policy_assignments pa
     LEFT JOIN LATERAL (
       SELECT x.decided_at, x.decided_by_name, x.reason FROM ack_decisions x
       WHERE x.document_id = pa.document_id AND x.outcome = 'reset' AND x.scope = 'users'
         AND x.decided_at = pa.cycle_started_at
       ORDER BY x.id DESC LIMIT 1
     ) reask ON true
     WHERE pa.document_id = $1 AND pa.user_id = $2 AND ${PA_OPEN}`,
    [docId, userId]
  );
  const row = r[0];
  if (!row) return null;
  return {
    due_at: row.due_at,
    cycle_started_at: row.cycle_started_at,
    asked_again: row.decided_at
      ? { decided_at: row.decided_at, decided_by_name: row.decided_by_name ?? "", reason: row.reason ?? "" }
      : null,
  };
}

export interface AttestedVersion {
  version_id: number;
  document_id: number | null;
  document_title: string;
  title: string;
  content: string;
  content_sha256: string;
  author: string;
  created_at: string | null;
  /** 'live' from doc_versions; 'archived' from attested_texts after the policy was purged. */
  source: "live" | "archived";
}

/**
 * The text behind a version id: the doc_versions row while the policy
 * exists, else the copy archived when it was purged. Every surface that
 * shows or verifies attested text reads through here, so a hash stays
 * checkable after the policy is gone.
 */
export async function getAttestedVersion(versionId: number): Promise<AttestedVersion | undefined> {
  const live = (
    await q<Omit<AttestedVersion, "content_sha256" | "source">>(
      `SELECT v.id AS version_id, v.document_id, d.title AS document_title, v.title, v.content,
              v.author, v.created_at
       FROM doc_versions v JOIN documents d ON d.id = v.document_id
       WHERE v.id = $1`,
      [versionId]
    )
  )[0];
  if (live) {
    return {
      ...live,
      content_sha256: createHash("sha256").update(live.content).digest("hex"),
      source: "live",
    };
  }
  const archived = (
    await q<Omit<AttestedVersion, "source">>(
      `SELECT version_id, document_id, document_title, title, content, content_sha256, author,
              version_created_at AS created_at
       FROM attested_texts WHERE version_id = $1`,
      [versionId]
    )
  )[0];
  return archived ? { ...archived, source: "archived" } : undefined;
}

/**
 * Erasure (C5): replace the person's name, email and IP on every attestation
 * record with "Former staff #id". Counts, dates, versions and hashes stay,
 * and the user_id link stays while the account exists so standing still
 * computes; deleting the account afterwards leaves rows that name nobody.
 * Decision rows (C1) that name the person as decider or submitter are
 * rewritten the same way; `rows` counts both tables. F2 extends this to
 * stored snapshots.
 */
export async function anonymiseComplianceRecord(
  userId: number
): Promise<{ rows: number; snapshots_rewritten: number }> {
  await ready();
  const alias = `Former staff #${userId}`;
  // One transaction: an erasure that renamed the confirmations but not the
  // decisions (or the reverse) would be half a promise.
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `UPDATE acknowledgements
       SET user_name = $2, user_email = '', ip = ''
       WHERE user_id = $1`,
      [userId, alias]
    );
    const decisions = await client.query(
      `UPDATE ack_decisions
       SET decided_by_name = CASE WHEN decided_by = $1 THEN $2 ELSE decided_by_name END,
           submitted_by_name = CASE WHEN submitted_by = $1 THEN $2 ELSE submitted_by_name END
       WHERE decided_by = $1 OR submitted_by = $1`,
      [userId, alias]
    );
    // The notice log (E3) names the person twice: as the recipient and as
    // the one who asked. Both snapshots follow the same rule.
    const notices = await client.query(
      `UPDATE ack_notices
       SET user_name = CASE WHEN user_id = $1 THEN $2 ELSE user_name END,
           user_email = CASE WHEN user_id = $1 THEN '' ELSE user_email END,
           by_name = CASE WHEN by_user_id = $1 THEN $2 ELSE by_name END
       WHERE user_id = $1 OR by_user_id = $1`,
      [userId, alias]
    );
    // The outbox names the person as the one who asked (actor_name, no FK
    // on actor_id); its error column never carries an address (the drain
    // writes "Email to user #id"), so the name is all there is to rewrite.
    const outbox = await client.query(`UPDATE ack_outbox SET actor_name = $2 WHERE actor_id = $1`, [
      userId,
      alias,
    ]);
    await client.query("COMMIT");
    return {
      rows: (res.rowCount ?? 0) + (decisions.rowCount ?? 0) + (notices.rowCount ?? 0) + (outbox.rowCount ?? 0),
      snapshots_rewritten: 0,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Attestation counts by user id (the Users page shows the erasure action only where there is a record). */
export async function attestationCountsByUser(): Promise<Map<number, number>> {
  const rows = await q<{ user_id: number; n: number }>(
    "SELECT user_id, COUNT(*)::int AS n FROM acknowledgements WHERE user_id IS NOT NULL GROUP BY user_id"
  );
  return new Map(rows.map((r) => [r.user_id, r.n]));
}

// --- Decision ledger (ack_decisions, C1) --------------------------------------
//
// Every keep and every reset of a confirmed document's confirmations, by whom,
// why and how many it touched. Two writers only: resetAcknowledgements (the
// one piece of code that moves documents.ack_revision_at / ack_version_id)
// and keepAcknowledgements. Both take the caller's client so a rolled-back
// save leaves no row and no moved marker.

/** Anything with pg's query(text, values): a PoolClient inside a transaction, or the pool. */
export type Queryable = {
  query<T extends import("pg").QueryResultRow = any>(
    text: string,
    values?: any[]
  ): Promise<import("pg").QueryResult<T>>;
};

/** One ledger row as the writers insert it (ids and timestamps come from the table). */
export interface AckDecisionRow {
  document_id: number;
  document_title: string;
  version_id: number | null;
  outcome: AckOutcome;
  source: AckSource;
  scope?: "all" | "users";
  decided_by: number | null;
  decided_by_name: string;
  submitted_policy?: "keep" | "reset" | "";
  submitted_by?: number | null;
  submitted_by_name?: string;
  reason: string;
  suggested?: "keep" | "reset" | "";
  overrode_suggestion?: boolean;
  change_pct?: number | null;
  change_json?: string | null;
  confirmations_affected?: number | null;
  eligible?: number | null;
  notified_at?: string | null;
  /**
   * When the decision was taken; the wall clock at insert when absent.
   * resetAcknowledgements passes the marker it just wrote, so the row and
   * the marker carry one stamp. Never the transaction's start time: a
   * confirmation that took the row lock first commits later than that.
   */
  decided_at?: string | null;
}

/** Insert one decision row; returns its id. Called by the two writers only. */
export async function recordAckDecision(client: Queryable, row: AckDecisionRow): Promise<number> {
  const r = await client.query<{ id: number }>(
    `INSERT INTO ack_decisions
       (document_id, document_title, version_id, outcome, source, scope,
        decided_by, decided_by_name, submitted_policy, submitted_by, submitted_by_name,
        reason, suggested, overrode_suggestion, change_pct, change_json,
        confirmations_affected, eligible, notified_at, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             COALESCE($20::timestamptz, clock_timestamp()))
     RETURNING id`,
    [
      row.document_id,
      row.document_title,
      row.version_id,
      row.outcome,
      row.source,
      row.scope ?? "all",
      row.decided_by,
      row.decided_by_name,
      row.submitted_policy ?? "",
      row.submitted_by ?? null,
      row.submitted_by_name ?? "",
      row.reason,
      row.suggested ?? "",
      row.overrode_suggestion ? 1 : 0,
      row.change_pct ?? null,
      row.change_json ?? null,
      row.confirmations_affected ?? null,
      row.eligible ?? null,
      row.notified_at ?? null,
      row.decided_at ?? null,
    ]
  );
  return r.rows[0].id;
}

/** What the two writers need to know about a decision. */
export interface AckDecisionInput {
  /** The version the decision is about (the new text); null only when the document has no versions. */
  versionId: number | null;
  actor: AckActor;
  source: AckSource;
  reason: string;
  /** The change-size measurement against the confirmed text (A4); stored as change_pct and change_json. */
  summary?: ChangeSummary;
  suggested?: "keep" | "reset" | "";
  overrodeSuggestion?: boolean;
  /** On an approval: what the submitter proposed, and who they were (the approver is `actor`). */
  submittedPolicy?: "keep" | "reset" | "";
  submittedBy?: AckActor | null;
  scope?: "all" | "users";
  /** The sending request's origin, stored on the outbox row a reset queues (1.10.1); '' when there is no request. */
  origin?: string;
}

/** People the policy asks (open assignment rows of active accounts) and their current confirmations (the same joins as complianceDocs). */
async function ackCounts(client: Queryable, docId: number): Promise<{ eligible: number; current: number }> {
  const r = await client.query<{ eligible: number; current: number }>(
    `SELECT COUNT(u.id)::int AS eligible,
            COUNT(u.id) FILTER (WHERE a.acknowledged_at IS NOT NULL)::int AS current
     FROM documents d
     LEFT JOIN policy_assignments pa ON pa.document_id = d.id AND ${PA_OPEN}
     LEFT JOIN users u ON u.id = pa.user_id AND u.status = 'active'
     LEFT JOIN LATERAL (
       SELECT a.acknowledged_at FROM acknowledgements a
       WHERE a.document_id = d.id AND a.user_id = u.id AND ${ACK_CURRENT_PA}
       ORDER BY a.acknowledged_at DESC LIMIT 1
     ) a ON true
     WHERE d.id = $1`,
    [docId]
  );
  return r.rows[0] ?? { eligible: 0, current: 0 };
}

function decisionColumns(docId: number, title: string, outcome: AckOutcome, opts: AckDecisionInput, counts: { eligible: number; current: number }): AckDecisionRow {
  return {
    document_id: docId,
    document_title: title,
    version_id: opts.versionId,
    outcome,
    source: opts.source,
    scope: opts.scope ?? "all",
    decided_by: opts.actor.id,
    decided_by_name: opts.actor.name,
    submitted_policy: opts.submittedPolicy ?? "",
    submitted_by: opts.submittedBy?.id ?? null,
    submitted_by_name: opts.submittedBy?.name ?? "",
    reason: opts.reason,
    suggested: opts.suggested ?? "",
    overrode_suggestion: opts.overrodeSuggestion ?? false,
    change_pct: opts.summary ? opts.summary.pct : null,
    change_json: opts.summary ? JSON.stringify(opts.summary) : null,
    confirmations_affected: counts.current,
    eligible: counts.eligible,
    notified_at: null,
  };
}

/**
 * The SET clause every marker move carries (G1, 1.12.0): a policy with a
 * re-confirmation cycle restarts its interval from the move, so a material
 * change or a manual re-ask pushes the next scheduled cycle out; a policy
 * without one is untouched. The sweep's own claim writes the same column
 * without the CASE (its WHERE already requires an interval).
 */
const RECERT_NEXT_ON_RESET = `ack_next_recert_at = CASE
           WHEN ack_recert_months IS NOT NULL THEN clock_timestamp() + make_interval(months => ack_recert_months)
           ELSE ack_next_recert_at
         END`;

/**
 * Ask everyone to re-confirm: move the confirmation marker to `versionId`
 * (every confirmation made before now goes stale) and write the 'reset'
 * decision row, in the caller's transaction. This is the ONLY code that
 * writes documents.ack_revision_at / ack_version_id.
 *
 * `silent` is rule 3 of updateDocument: the requirement is off, nobody is
 * being asked, the marker simply follows the text. No row is written and
 * the audience is not counted (that join runs on every text save of every
 * document whose requirement is off, for a number nobody reads).
 *
 * The marker is the wall clock at the moment it moves (clock_timestamp()),
 * not the transaction's start (now()): a confirmation whose transaction took
 * the document's row lock first commits with a stamp later than our start,
 * and would otherwise count as current for text it predates. The decision
 * row carries the same stamp as the marker.
 *
 * The notice (H1/H4, 1.10.1): a reset that takes a decision also queues one
 * outbox row of mode 'updated' in the same transaction, so a rolled-back
 * approval or merge tells nobody and a committed one tells everyone within
 * a minute or two. Sources that come from a text save (edit, merge,
 * restore, approval, schedule, and the API-shaped ones) wait two minutes so
 * three saves in an afternoon collapse into one notice; manual and
 * recurrence go out at once. The drain (lib/compliance deliverAckNotices)
 * resolves the recipients at delivery and stamps notified_at on this row
 * when it has.
 */
export async function resetAcknowledgements(
  client: Queryable,
  docId: number,
  opts: AckDecisionInput & { silent?: boolean }
): Promise<{ decision_id: number | null; confirmations_reset: number; eligible: number; outbox_id: number | null }> {
  // Counted before the marker moves: afterwards nothing is current.
  const counts = opts.silent ? null : await ackCounts(client, docId);
  const moved = await client.query<{ title: string; marker: string }>(
    `UPDATE documents SET ack_revision_at = clock_timestamp(), ack_version_id = $2,
         ${RECERT_NEXT_ON_RESET}
     WHERE id = $1 RETURNING title, ack_revision_at::text AS marker`,
    [docId, opts.versionId]
  );
  if (!counts || moved.rowCount === 0) {
    return {
      decision_id: null,
      confirmations_reset: counts?.current ?? 0,
      eligible: counts?.eligible ?? 0,
      outbox_id: null,
    };
  }
  const decisionId = await recordAckDecision(client, {
    ...decisionColumns(docId, moved.rows[0].title, "reset", opts, counts),
    decided_at: moved.rows[0].marker,
  });
  const outboxId = await insertAckOutbox(client, {
    document_id: docId,
    mode: "updated",
    source: opts.source,
    reason: opts.reason,
    actor: opts.actor,
    user_ids: null,
    delay_minutes: ackNoticeDelayMinutes(opts.source),
    origin: opts.origin ?? "",
  });
  return { decision_id: decisionId, confirmations_reset: counts.current, eligible: counts.eligible, outbox_id: outboxId };
}

// --- Notice outbox and per-person notice log (ack_outbox / ack_notices, H4 + E3) --
//
// The SQL behind lib/compliance's enqueueAckNotice, deliverAckNotices and
// recordNotices. Nothing here sends anything: the outbox is a queue, the
// notice log is the record, and compliance.ts is the only module that turns
// one into the other.

/** Sources whose notices wait two minutes and coalesce per person per day; the rest (manual, recurrence) go out at once and always deliver. */
export const ACK_NOTICE_DELAY_MINUTES = 2;
export function ackNoticeDelayMinutes(source: AckSource | "" | null | undefined): number {
  return source === "manual" || source === "recurrence" ? 0 : ACK_NOTICE_DELAY_MINUTES;
}

/** True for a source whose 'updated' notices coalesce (24h per person and document); manual and recurrence always deliver. */
export function ackNoticeCoalesces(source: AckSource | "" | null | undefined): boolean {
  return source !== "manual" && source !== "recurrence";
}

export interface AckOutboxInput {
  document_id: number;
  mode: AckNoticeMode;
  source?: AckSource | "";
  reason?: string;
  actor?: AckActor | null;
  /** Null (the default) = everyone pending at delivery time. */
  user_ids?: number[] | null;
  /** Deliver no earlier than this; `delay_minutes` from now when absent (0 = at once). */
  not_before?: Date | string | null;
  delay_minutes?: number;
  /**
   * The sending request's origin (requestOrigin(req)), kept on the row for
   * the links in the email and webhook when the workspace has no
   * custom_domain; '' when nothing sent it (an import, a sweep). Only an
   * http(s) origin is stored; the drain never remembers one across rows.
   */
  origin?: string | null;
  /**
   * What a sweep hands the drain beside the recipient list (E2, 1.13.0): a
   * 'due' row carries `{ rows: [{ user_id, due_at, overdue }] }`, an
   * 'escalation' row `{ days, overdue: [{ user_id, name, due_at }],
   * recipients: [{ id, via }] }`. Stored as JSON; absent on every other row.
   */
  payload?: unknown;
}

/** An http(s) origin without its trailing slash, or '' for anything else (a path, a header that is not a URL). */
export function ackOutboxOrigin(origin: string | null | undefined): string {
  const o = (origin ?? "").trim();
  return /^https?:\/\/[^\s/?#]+$/i.test(o.replace(/\/+$/, "")) ? o.replace(/\/+$/, "").slice(0, 300) : "";
}

/** Queue one fan-out on the given client (inside the caller's transaction) or the pool. Returns the row id. */
export async function insertAckOutbox(client: Queryable | null, row: AckOutboxInput): Promise<number> {
  if (!client) await ready();
  const r = await (client ?? pool()).query<{ id: number }>(
    `INSERT INTO ack_outbox (document_id, mode, source, reason, actor_id, actor_name, user_ids, not_before, origin, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
             COALESCE($8::timestamptz, now() + make_interval(mins => $9::int)), $10, $11::jsonb)
     RETURNING id`,
    [
      row.document_id,
      row.mode,
      row.source ?? "",
      (row.reason ?? "").slice(0, 1000),
      row.actor?.id ?? null,
      row.actor?.name || "system",
      row.user_ids ? JSON.stringify([...new Set(row.user_ids)]) : null,
      row.not_before instanceof Date ? row.not_before.toISOString() : (row.not_before ?? null),
      Math.max(0, row.delay_minutes ?? 0),
      ackOutboxOrigin(row.origin),
      row.payload === undefined || row.payload === null ? null : JSON.stringify(row.payload),
    ]
  );
  return r.rows[0].id;
}

/**
 * The portal's Remind, as one atomic claim: the one-hour stamp is set in
 * the same UPDATE whose WHERE tests it, so two clicks in the same second
 * (or two managers) take the cooldown once and the loser gets false. The
 * document must still take confirmations. The route keeps its early check
 * for the friendly 429 copy; this is the one that holds.
 */
export async function claimAckReminder(docId: number): Promise<boolean> {
  const rows = await q<{ id: number }>(
    `UPDATE documents SET ack_last_reminded_at = now()
     WHERE id = $1 AND ack_required = 1 AND status = 'published' AND deleted_at IS NULL
       AND (ack_last_reminded_at IS NULL OR ack_last_reminded_at < now() - interval '1 hour')
     RETURNING id`,
    [docId]
  );
  return rows.length > 0;
}

/** A claimed row: AckOutboxRow plus the origin column (RETURNING *). */
export type ClaimedAckOutboxRow = AckOutboxRow & { origin: string };

/**
 * Claim the next due rows for this instance: one UPDATE whose SET changes
 * the column its WHERE tests (claimed_at), with FOR UPDATE SKIP LOCKED in
 * the subquery, so two drains running at once never take the same row. A
 * row claimed more than ten minutes ago by an instance that died is taken
 * again (a live delivery keeps its claim fresh with touchAckOutbox, so an
 * old claim means a dead instance); a row that failed three times is
 * closed and never claimed again.
 */
export async function claimAckOutbox(limit = 20, documentIds?: number[]): Promise<ClaimedAckOutboxRow[]> {
  const rows = await q<ClaimedAckOutboxRow>(
    `UPDATE ack_outbox SET claimed_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM ack_outbox
       WHERE done_at IS NULL AND not_before <= now()
         AND (claimed_at IS NULL OR claimed_at < now() - interval '10 minutes')
         AND attempts < 3
         AND ($2::int[] IS NULL OR document_id = ANY($2::int[]))
       ORDER BY id LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [Math.max(1, Math.min(200, limit)), documentIds ?? null]
  );
  return rows.sort((a, b) => a.id - b.id);
}

/**
 * The lease heartbeat: a delivery that outlives the ten-minute reclaim
 * window (hundreds of recipients on a slow relay) would otherwise be taken
 * by the next tick and sent again. The drain calls this before each group
 * and every few recipients inside the mail and webhook loops, for every
 * row of its batch that is still open.
 */
export async function touchAckOutbox(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await q("UPDATE ack_outbox SET claimed_at = now() WHERE id = ANY($1) AND done_at IS NULL", [ids]);
}

/**
 * Close rows abandoned on their last attempt: claimed a third time by an
 * instance that died before it could fail or complete them (attempts
 * reached the limit, nothing closed the row, the claim is stale). Nobody
 * would ever claim, audit or sweep them otherwise. Returns the rows closed
 * so the drain can write ack.notice_failed for each. The error keeps what
 * the earlier attempt said, after the fact that this one never reported.
 */
export async function retireAbandonedAckOutbox(documentIds?: number[]): Promise<ClaimedAckOutboxRow[]> {
  const rows = await q<ClaimedAckOutboxRow>(
    `UPDATE ack_outbox
     SET done_at = now(),
         error = 'instance died on the last attempt' || COALESCE('; earlier: ' || NULLIF(error, ''), ''),
         noticed = (SELECT COUNT(*)::int FROM ack_notices n WHERE n.outbox_id = ack_outbox.id),
         emailed = (SELECT COUNT(*)::int FROM ack_notices n WHERE n.outbox_id = ack_outbox.id AND n.channels ? 'email')
     WHERE done_at IS NULL AND attempts >= 3
       AND claimed_at < now() - interval '10 minutes'
       AND ($1::int[] IS NULL OR document_id = ANY($1::int[]))
     RETURNING *`,
    [documentIds ?? null]
  );
  return rows.sort((a, b) => a.id - b.id);
}

/** Mark rows delivered; the counts come from the notice log so a resumed retry reports the whole delivery. */
export async function completeAckOutbox(ids: number[]): Promise<{ emailed: number; noticed: number }> {
  if (ids.length === 0) return { emailed: 0, noticed: 0 };
  const rows = await q<{ emailed: number; noticed: number }>(
    `UPDATE ack_outbox SET done_at = now(), error = NULL,
       noticed = (SELECT COUNT(*)::int FROM ack_notices n WHERE n.outbox_id = ANY($1)),
       emailed = (SELECT COUNT(*)::int FROM ack_notices n WHERE n.outbox_id = ANY($1) AND n.channels ? 'email')
     WHERE id = ANY($1)
     RETURNING emailed, noticed`,
    [ids]
  );
  return rows[0] ?? { emailed: 0, noticed: 0 };
}

/**
 * Record a failed attempt: the row keeps its claim (the 10-minute reclaim
 * is the retry delay) and the error. With `retire` (the last attempt) the
 * row is closed as well, with its error: never claimed again, hidden from
 * the queue, swept with the delivered rows after a month, and told apart
 * from a row abandoned mid-attempt by its done_at.
 */
export async function failAckOutbox(ids: number[], error: string, opts: { retire?: boolean } = {}): Promise<void> {
  if (ids.length === 0) return;
  await q(
    `UPDATE ack_outbox SET error = $2,
       done_at = CASE WHEN $3::boolean THEN now() ELSE done_at END,
       noticed = (SELECT COUNT(*)::int FROM ack_notices n WHERE n.outbox_id = ANY($1)),
       emailed = (SELECT COUNT(*)::int FROM ack_notices n WHERE n.outbox_id = ANY($1) AND n.channels ? 'email')
     WHERE id = ANY($1)`,
    [ids, error.slice(0, 1000), Boolean(opts.retire)]
  );
}

export async function getAckOutboxRow(id: number): Promise<AckOutboxRow | undefined> {
  return (await q<AckOutboxRow>("SELECT * FROM ack_outbox WHERE id = $1", [id]))[0];
}

/** Queued (not yet delivered) rows for a document, oldest first: the portal's "queued" state. */
export async function pendingAckOutboxFor(docId: number): Promise<AckOutboxRow[]> {
  return q<AckOutboxRow>(
    "SELECT * FROM ack_outbox WHERE document_id = $1 AND done_at IS NULL AND attempts < 3 ORDER BY id",
    [docId]
  );
}

/** What the drain needs to know about the policy before it sends: gone, trashed, unpublished or no longer required means nobody is told. */
export async function ackNoticeDocument(
  docId: number
): Promise<{ id: number; title: string; deliverable: boolean } | undefined> {
  const r = await q<{ id: number; title: string; deliverable: boolean }>(
    `SELECT id, title,
            (ack_required = 1 AND status = 'published' AND deleted_at IS NULL) AS deliverable
     FROM documents WHERE id = $1`,
    [docId]
  );
  return r[0];
}

/**
 * Who a fan-out reaches, resolved at delivery: the explicit list (active
 * accounts only) when the row names one, else everyone pending for the
 * document right now (compliancePendingUsers' joins, so a person who
 * confirmed between enqueue and delivery is not told).
 */
export async function ackNoticeRecipients(
  docId: number,
  userIds: number[] | null
): Promise<{ id: number; name: string; email: string }[]> {
  if (userIds === null) return compliancePendingUsers(docId);
  if (userIds.length === 0) return [];
  return q(
    "SELECT id, name, email FROM users WHERE id = ANY($1) AND status = 'active' ORDER BY name",
    [userIds]
  );
}

/**
 * People who already have a notice of this kind for this document within
 * the window and have not acted on it since (H1's coalescing key). A
 * person told this morning who re-confirmed at noon and lapsed again on
 * an afternoon change is told again: the notice they got was answered.
 */
export async function recentAckNoticeUserIds(docId: number, kind: AckNoticeKind, hours: number): Promise<Set<number>> {
  const rows = await q<{ user_id: number }>(
    `SELECT DISTINCT n.user_id FROM ack_notices n
     WHERE n.document_id = $1 AND n.kind = $2 AND n.user_id IS NOT NULL
       AND n.sent_at > now() - make_interval(hours => $3::int)
       AND NOT EXISTS (
         SELECT 1 FROM acknowledgements a
         WHERE a.document_id = n.document_id AND a.user_id = n.user_id AND a.acknowledged_at > n.sent_at
       )`,
    [docId, kind, hours]
  );
  return new Set(rows.map((r) => r.user_id));
}

/** Notices an earlier attempt of these outbox rows already wrote, by person: a retry resumes instead of repeating. */
export async function ackNoticesForOutbox(
  outboxIds: number[]
): Promise<Map<number, { id: number; channels: AckNoticeChannel[] }>> {
  const map = new Map<number, { id: number; channels: AckNoticeChannel[] }>();
  if (outboxIds.length === 0) return map;
  const rows = await q<{ id: number; user_id: number | null; channels: AckNoticeChannel[] }>(
    "SELECT id, user_id, channels FROM ack_notices WHERE outbox_id = ANY($1) ORDER BY id",
    [outboxIds]
  );
  for (const r of rows) if (r.user_id != null) map.set(r.user_id, { id: r.id, channels: r.channels ?? [] });
  return map;
}

/**
 * Make a merged group's record follow the row that outlives the rest. The
 * rows of a group are claimed together but joined it at different times,
 * so the oldest has the most attempts and retires first; notices written
 * under its id would then be invisible to the younger row's next claim,
 * and everyone would be told again. Re-keying every notice of the group to
 * its newest row before each delivery keeps the record whole.
 */
export async function rekeyAckNotices(outboxIds: number[], toOutboxId: number): Promise<number> {
  if (outboxIds.length < 2) return 0;
  const r = await pool().query("UPDATE ack_notices SET outbox_id = $2 WHERE outbox_id = ANY($1) AND outbox_id <> $2", [
    outboxIds,
    toOutboxId,
  ]);
  return r.rowCount ?? 0;
}

export interface AckNoticeInput {
  user_id: number;
  user_name: string;
  user_email: string;
  document_id: number;
  document_title: string;
  kind: AckNoticeKind;
  channels: AckNoticeChannel[];
  by_user_id?: number | null;
  by_name?: string;
  outbox_id?: number | null;
}

/**
 * The single INSERT behind recordNotices (lib/compliance); returns the new
 * ids in input order. A person or policy deleted between resolving the
 * recipients and writing the record leaves the row with its snapshot and a
 * NULL id (what ON DELETE SET NULL would have done a moment later), rather
 * than failing the whole delivery on the foreign key.
 */
export async function insertAckNotices(rows: AckNoticeInput[]): Promise<number[]> {
  if (rows.length === 0) return [];
  // The subselects read the statement's snapshot; the foreign-key check
  // reads the latest commit. A deletion that lands between the two fails
  // the statement with 23503 once, and the second attempt sees it.
  for (let attempt = 0; ; attempt++) {
    try {
      return await insertAckNoticesOnce(rows);
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== "23503" || attempt >= 3) throw e;
    }
  }
}

async function insertAckNoticesOnce(rows: AckNoticeInput[]): Promise<number[]> {
  const out = await q<{ id: number }>(
    `INSERT INTO ack_notices
       (user_id, user_name, user_email, document_id, document_title, kind, channels, by_user_id, by_name, outbox_id)
     SELECT (SELECT u.id FROM users u WHERE u.id = r.user_id),
            COALESCE(r.user_name, ''), COALESCE(r.user_email, ''),
            (SELECT d.id FROM documents d WHERE d.id = r.document_id),
            COALESCE(r.document_title, ''), r.kind, COALESCE(r.channels, '[]'::jsonb),
            (SELECT b.id FROM users b WHERE b.id = r.by_user_id),
            COALESCE(NULLIF(r.by_name, ''), 'system'), r.outbox_id
     FROM jsonb_to_recordset($1::jsonb) AS r(
       user_id int, user_name text, user_email text, document_id int, document_title text,
       kind text, channels jsonb, by_user_id int, by_name text, outbox_id int)
     RETURNING id`,
    [
      JSON.stringify(
        rows.map((r) => ({
          user_id: r.user_id,
          user_name: r.user_name,
          user_email: r.user_email,
          document_id: r.document_id,
          document_title: r.document_title,
          kind: r.kind,
          channels: [...new Set(r.channels)],
          by_user_id: r.by_user_id ?? null,
          by_name: r.by_name || "system",
          outbox_id: r.outbox_id ?? null,
        }))
      ),
    ]
  );
  return out.map((r) => r.id);
}

/** A retry delivered a channel an earlier attempt could not (the email after an SMTP outage): add it to the row. */
export async function addAckNoticeChannel(id: number, channel: AckNoticeChannel): Promise<void> {
  await q(
    `UPDATE ack_notices SET channels = channels || $2::jsonb
     WHERE id = $1 AND NOT (channels ? $3)`,
    [id, JSON.stringify([channel]), channel]
  );
}

// --- Reminder and escalation claims (E2, 1.13.0) ----------------------------------
//
// The hourly sweep (lib/compliance complianceHourly) reminds the people
// whose confirmation is due or overdue and tells a policy's owner and the
// overdue people's group leads when someone is well past the date. Each
// claim is one statement: the subquery picks the rows under FOR UPDATE SKIP
// LOCKED and the UPDATE stamps the column its WHERE tests (reminded_at,
// escalated_at), so two instances never claim the same row and a crash
// between the claim and the notice drops that cycle's reminder, as the
// training sweep does. The cadence is resolved per policy inside the SQL:
// policy_settings, then the space's policy_defaults, then the workspace
// numbers the sweep passes in (already resolved over the built-ins).

/** The workspace-resolved numbers a sweep passes in as the COALESCE fallbacks. */
export interface AckSweepDefaults {
  remind_before_days: number;
  remind_every_days: number;
  escalate_after_days: number;
  nudge_every_days: number;
  overdue_grace_days: number;
}

/** A policy the sweeps act on: required, published, live, not retired. */
const SWEEP_POLICY = `d.ack_required = 1 AND d.status = 'published' AND d.deleted_at IS NULL
       AND d.branch_of IS NULL AND d.ack_retired_at IS NULL`;
/** An open row (not removed, not exempt) of an active account, not snoozed. */
const SWEEP_OPEN = `pa.removed_at IS NULL AND pa.exempt_at IS NULL AND u.status = 'active'
       AND (pa.snoozed_until IS NULL OR pa.snoozed_until <= now())`;
/** No confirmation current for this row (the document marker or the row's own cycle, whichever is later). */
const SWEEP_UNCONFIRMED = `NOT EXISTS (
         SELECT 1 FROM acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = pa.user_id
           AND a.acknowledged_at >= GREATEST(d.ack_revision_at, pa.cycle_started_at))`;
/** One number of the cadence: the policy's own, else the space's, else the parameter. */
const CADENCE = (col: string, param: string) => `COALESCE(ps.${col}, (s.policy_defaults->>'${col}')::int, ${param}::int)`;
/** The grace period has no per-policy column: the space's, else the parameter. */
const GRACE = (param: string) => `COALESCE((s.policy_defaults->>'overdue_grace_days')::int, ${param}::int)`;

export interface ClaimedAckReminder {
  assignment_id: number;
  user_id: number;
  name: string;
  email: string;
  document_id: number;
  title: string;
  space_id: number;
  due_at: string | null;
  /** The due date plus the grace period has passed. */
  overdue: boolean;
  /** After this claim. */
  reminder_count: number;
}

/**
 * Claim every row due a reminder, across all live policies, in one
 * statement: open row, active account, not snoozed, no current
 * confirmation; with a deadline, due within remind_before_days or past it
 * and the last reminder older than remind_every_days (or none yet); without
 * one, every nudge_every_days when that is above 0. SET reminded_at = now(),
 * reminder_count + 1. `documentIds` limits the claim (tests sharing a
 * database; the tick passes nothing).
 */
export async function claimAckReminders(
  defaults: AckSweepDefaults,
  opts: { documentIds?: number[] } = {}
): Promise<ClaimedAckReminder[]> {
  return q<ClaimedAckReminder>(
    `WITH due AS (
       SELECT pa.id, u.name, u.email, d.id AS document_id, d.title, d.space_id,
              (pa.due_at IS NOT NULL AND pa.due_at + make_interval(days => c.grace_days) < now()) AS overdue
       FROM policy_assignments pa
       JOIN documents d ON d.id = pa.document_id
       JOIN spaces s ON s.id = d.space_id
       JOIN users u ON u.id = pa.user_id
       LEFT JOIN policy_settings ps ON ps.document_id = d.id
       CROSS JOIN LATERAL (SELECT
           ${CADENCE("remind_before_days", "$1")} AS before_days,
           ${CADENCE("remind_every_days", "$2")} AS every_days,
           ${CADENCE("nudge_every_days", "$3")} AS nudge_days,
           ${GRACE("$4")} AS grace_days) c
       WHERE ${SWEEP_POLICY} AND ${SWEEP_OPEN} AND ${SWEEP_UNCONFIRMED}
         AND (
           (pa.due_at IS NOT NULL AND pa.due_at < now() + make_interval(days => c.before_days)
              AND (pa.reminded_at IS NULL OR pa.reminded_at < now() - make_interval(days => c.every_days)))
           OR (pa.due_at IS NULL AND c.nudge_days > 0
              AND (pa.reminded_at IS NULL OR pa.reminded_at < now() - make_interval(days => c.nudge_days)))
         )
         AND ($5::int[] IS NULL OR d.id = ANY($5::int[]))
       ORDER BY pa.id
       FOR UPDATE OF pa SKIP LOCKED
     )
     UPDATE policy_assignments pa
     SET reminded_at = now(), reminder_count = pa.reminder_count + 1
     FROM due WHERE pa.id = due.id
     RETURNING pa.id AS assignment_id, pa.user_id, due.name, due.email, due.document_id, due.title, due.space_id,
               pa.due_at, due.overdue, pa.reminder_count`,
    [
      defaults.remind_before_days,
      defaults.remind_every_days,
      defaults.nudge_every_days,
      defaults.overdue_grace_days,
      opts.documentIds ?? null,
    ]
  );
}

export interface ClaimedAckEscalation {
  assignment_id: number;
  user_id: number;
  name: string;
  document_id: number;
  title: string;
  space_id: number;
  due_at: string;
  /** The threshold crossed: overdue_grace_days + escalate_after_days as resolved for the policy. */
  days: number;
}

/**
 * Claim every row to escalate, in one statement: open, active, not
 * snoozed, no current confirmation, never escalated, and
 * due_at + overdue_grace_days + escalate_after_days < now(). SET
 * escalated_at = now(). Extending the due date clears escalated_at (the
 * exemptions agent's extendAssignments), so the row re-arms.
 */
export async function claimAckEscalations(
  defaults: AckSweepDefaults,
  opts: { documentIds?: number[] } = {}
): Promise<ClaimedAckEscalation[]> {
  return q<ClaimedAckEscalation>(
    `WITH over AS (
       SELECT pa.id, u.name, d.id AS document_id, d.title, d.space_id, (c.grace_days + c.esc_days) AS days
       FROM policy_assignments pa
       JOIN documents d ON d.id = pa.document_id
       JOIN spaces s ON s.id = d.space_id
       JOIN users u ON u.id = pa.user_id
       LEFT JOIN policy_settings ps ON ps.document_id = d.id
       CROSS JOIN LATERAL (SELECT
           ${CADENCE("escalate_after_days", "$1")} AS esc_days,
           ${GRACE("$2")} AS grace_days) c
       WHERE ${SWEEP_POLICY} AND ${SWEEP_OPEN} AND ${SWEEP_UNCONFIRMED}
         AND pa.escalated_at IS NULL AND pa.due_at IS NOT NULL
         AND pa.due_at + make_interval(days => c.grace_days + c.esc_days) < now()
         AND ($3::int[] IS NULL OR d.id = ANY($3::int[]))
       ORDER BY pa.id
       FOR UPDATE OF pa SKIP LOCKED
     )
     UPDATE policy_assignments pa
     SET escalated_at = now()
     FROM over WHERE pa.id = over.id
     RETURNING pa.id AS assignment_id, pa.user_id, over.name, over.document_id, over.title, over.space_id,
               pa.due_at, over.days`,
    [defaults.escalate_after_days, defaults.overdue_grace_days, opts.documentIds ?? null]
  );
}

/** How a person came to receive an escalation; a person reached two ways keeps the first. */
export type EscalationVia = "owner" | "requested_by" | "approver" | "lead";

export interface EscalationRecipient {
  id: number;
  name: string;
  email: string;
  via: EscalationVia;
}

/**
 * Who hears that people are overdue on a policy, resolved once per policy:
 * the policy's owner (policy_settings.owner_user_id) when that account is
 * active, else whoever switched the requirement on (requested_by), else
 * the space's approvers (listApproverIdsForSpace); plus the leads of every
 * group the overdue people belong to, in one join over group_leads and
 * group_members, kept to leads who can see the policy's space (the same
 * visibility rule the audience uses: public or internal space, space.read_all,
 * or a space.member grant), so a lead of a broad group gets nothing about a
 * private-space policy. Owners and approvers can see the space by
 * construction. Active accounts only.
 */
export async function escalationRecipients(
  policies: { document_id: number; space_id: number; user_ids: number[] }[]
): Promise<Map<number, EscalationRecipient[]>> {
  const out = new Map<number, EscalationRecipient[]>();
  for (const p of policies) {
    const chosen = new Map<number, EscalationVia>();
    const settings = (
      await q<{ owner: number | null; requester: number | null }>(
        `SELECT (SELECT o.id FROM users o WHERE o.id = ps.owner_user_id AND o.status = 'active') AS owner,
                (SELECT r.id FROM users r WHERE r.id = ps.requested_by AND r.status = 'active') AS requester
         FROM policy_settings ps WHERE ps.document_id = $1`,
        [p.document_id]
      )
    )[0];
    if (settings?.owner != null) chosen.set(settings.owner, "owner");
    else if (settings?.requester != null) chosen.set(settings.requester, "requested_by");
    else for (const id of await listApproverIdsForSpace(p.space_id, 0)) chosen.set(id, "approver");
    if (p.user_ids.length > 0) {
      const leads = await q<{ id: number }>(
        `SELECT DISTINCT u.id
         FROM group_leads gl
         JOIN group_members gm ON gm.group_id = gl.group_id AND gm.user_id = ANY($1::int[])
         JOIN users u ON u.id = gl.user_id AND u.status = 'active'
         JOIN spaces s ON s.id = $2
         WHERE s.visibility IN ('public', 'internal')
            OR ${HOLDS_GLOBALLY("space.read_all", "u.id")}
            OR ${HOLDS_ON_SPACE("space.member", "s.id", "u.id")}`,
        [p.user_ids, p.space_id]
      );
      for (const l of leads) if (!chosen.has(l.id)) chosen.set(l.id, "lead");
    }
    if (chosen.size === 0) {
      out.set(p.document_id, []);
      continue;
    }
    const people = await q<{ id: number; name: string; email: string }>(
      "SELECT id, name, email FROM users WHERE id = ANY($1::int[]) AND status = 'active' ORDER BY name",
      [[...chosen.keys()]]
    );
    out.set(
      p.document_id,
      people.map((u) => ({ id: u.id, name: u.name, email: u.email, via: chosen.get(u.id)! }))
    );
  }
  return out;
}

/**
 * The portal's manual Remind stamps the rows it reaches (reminded_at,
 * reminder_count), so the automatic cadence counts from it and the row
 * subtitle reads "last reminded today": every open row of an active
 * account with no current confirmation, or the named people among them.
 * Returns how many rows were stamped.
 */
export async function stampAckReminded(docId: number, userIds: number[] | null = null): Promise<number> {
  const rows = await q<{ id: number }>(
    `UPDATE policy_assignments pa
     SET reminded_at = now(), reminder_count = pa.reminder_count + 1
     FROM documents d, users u
     WHERE d.id = pa.document_id AND u.id = pa.user_id AND pa.document_id = $1
       AND ($2::int[] IS NULL OR pa.user_id = ANY($2::int[]))
       AND pa.removed_at IS NULL AND pa.exempt_at IS NULL AND u.status = 'active'
       AND ${SWEEP_UNCONFIRMED}
     RETURNING pa.id`,
    [docId, userIds]
  );
  return rows.length;
}

/** What the portal row's reminder subtitle reads (lib/ack-remind reminderSubtitle). */
export interface AckReminderSummary {
  document_id: number;
  /** The newest reminder stamp over the policy's open rows, or the manual Remind's, whichever is later. */
  last_reminded_at: string | null;
  /** The earliest next automatic reminder over the policy's open, unconfirmed rows (the same rule as the claim); null when none is scheduled. */
  next_reminder_at: string | null;
}

/**
 * Per policy, when people were last reminded and when the sweep will next
 * remind someone, with the cadence resolved as the claim resolves it. The
 * next date is "now" for a row the next tick will take; a snooze pushes a
 * row's date to its end.
 */
export async function ackReminderSummary(docIds: number[], defaults: AckSweepDefaults): Promise<Map<number, AckReminderSummary>> {
  const out = new Map<number, AckReminderSummary>();
  if (docIds.length === 0) return out;
  const rows = await q<AckReminderSummary>(
    `SELECT d.id AS document_id,
            GREATEST(d.ack_last_reminded_at, MAX(pa.reminded_at)) AS last_reminded_at,
            MIN(n.next) AS next_reminder_at
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     LEFT JOIN policy_settings ps ON ps.document_id = d.id
     LEFT JOIN policy_assignments pa ON pa.document_id = d.id AND pa.removed_at IS NULL AND pa.exempt_at IS NULL
     LEFT JOIN users u ON u.id = pa.user_id
     CROSS JOIN LATERAL (SELECT
         ${CADENCE("remind_before_days", "$2")} AS before_days,
         ${CADENCE("remind_every_days", "$3")} AS every_days,
         ${CADENCE("nudge_every_days", "$4")} AS nudge_days) c
     CROSS JOIN LATERAL (SELECT CASE
         WHEN pa.id IS NULL OR u.status <> 'active' OR NOT ${SWEEP_UNCONFIRMED} THEN NULL
         WHEN pa.due_at IS NOT NULL THEN GREATEST(now(), pa.due_at - make_interval(days => c.before_days),
                                                  pa.reminded_at + make_interval(days => c.every_days), pa.snoozed_until)
         WHEN c.nudge_days > 0 THEN GREATEST(now(), pa.reminded_at + make_interval(days => c.nudge_days), pa.snoozed_until)
         ELSE NULL END AS next) n
     WHERE d.id = ANY($1::int[])
     GROUP BY d.id`,
    [docIds, defaults.remind_before_days, defaults.remind_every_days, defaults.nudge_every_days]
  );
  for (const r of rows) out.set(r.document_id, r);
  return out;
}

/** The notice log, newest first, for a person and/or a document (the person record, the roster expand, notices.csv). */
export async function listAckNotices(opts: {
  userId?: number;
  documentId?: number;
  limit?: number;
}): Promise<AckNotice[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.userId != null) {
    params.push(opts.userId);
    where.push(`user_id = $${params.length}`);
  }
  if (opts.documentId != null) {
    params.push(opts.documentId);
    where.push(`document_id = $${params.length}`);
  }
  params.push(Math.min(500, Math.max(1, opts.limit ?? 100)));
  return q<AckNotice>(
    `SELECT id, user_id, user_name, user_email, document_id, document_title, kind, channels,
            sent_at, by_user_id, by_name, outbox_id
     FROM ack_notices ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY sent_at DESC, id DESC LIMIT $${params.length}`,
    params
  );
}

/** The newest notice per document for a set of documents. Unused in 1.10.1: intended for a "Last notified 3 Oct (reminder)" line on the portal's policy row, which no surface renders yet (the row shows `last reminded` from ack_last_reminded_at). */
export async function lastAckNoticeByDocument(
  docIds: number[]
): Promise<Map<number, { sent_at: string; kind: AckNoticeKind }>> {
  const map = new Map<number, { sent_at: string; kind: AckNoticeKind }>();
  if (docIds.length === 0) return map;
  const rows = await q<{ document_id: number; sent_at: string; kind: AckNoticeKind }>(
    `SELECT DISTINCT ON (document_id) document_id, sent_at, kind
     FROM ack_notices WHERE document_id = ANY($1)
     ORDER BY document_id, sent_at DESC, id DESC`,
    [docIds]
  );
  for (const r of rows) map.set(r.document_id, { sent_at: r.sent_at, kind: r.kind });
  return map;
}

/** Stamp notified_at on the reset decisions an 'updated' delivery covered (the rows queued since the group's earliest not_before, less the debounce). */
export async function stampAckDecisionsNotified(docId: number, since: string): Promise<number> {
  const r = await pool().query(
    `UPDATE ack_decisions SET notified_at = now()
     WHERE document_id = $1 AND outcome = 'reset' AND notified_at IS NULL
       AND decided_at >= $2::timestamptz - make_interval(mins => $3::int)`,
    [docId, since, ACK_NOTICE_DELAY_MINUTES]
  );
  return r.rowCount ?? 0;
}

/**
 * Leave confirmations standing after a text change and say so: the 'kept'
 * decision row with the reason, in the caller's transaction. The marker is
 * untouched; confirmations_affected is how many stayed current.
 */
export async function keepAcknowledgements(
  client: Queryable,
  docId: number,
  opts: AckDecisionInput
): Promise<{ decision_id: number | null; confirmations_kept: number; eligible: number }> {
  const counts = await ackCounts(client, docId);
  const doc = await client.query<{ title: string }>("SELECT title FROM documents WHERE id = $1", [docId]);
  if (doc.rowCount === 0) return { decision_id: null, confirmations_kept: counts.current, eligible: counts.eligible };
  const decisionId = await recordAckDecision(
    client,
    decisionColumns(docId, doc.rows[0].title, "kept", opts, counts)
  );
  return { decision_id: decisionId, confirmations_kept: counts.current, eligible: counts.eligible };
}

const DECISION_SELECT = `
  SELECT x.id, x.document_id, x.version_id, ${VERSION_REV("x.version_id")} AS rev,
         x.outcome, x.decided_at, x.source, x.scope,
         x.decided_by, x.decided_by_name, x.submitted_policy, x.submitted_by, x.submitted_by_name,
         x.reason, x.suggested, (x.overrode_suggestion = 1) AS overrode_suggestion,
         x.change_pct::float8 AS change_pct, x.confirmations_affected, x.eligible, x.notified_at
  FROM ack_decisions x`;

/** Every decision for a document, newest first. */
export async function listAckDecisions(docId: number): Promise<AckDecision[]> {
  return q<AckDecision>(
    `${DECISION_SELECT} WHERE x.document_id = $1 ORDER BY x.decided_at DESC, x.id DESC`,
    [docId]
  );
}

/**
 * The newest decision for a document (of one outcome, or one scope, when
 * asked), or null. `scope: "all"` skips the per-person re-asks (D4, scope
 * 'users'): a sentence about the whole audience ("asked 3 Mar by Matt")
 * must not date itself from a row that asked one person.
 */
export async function lastAckDecision(
  docId: number,
  opts: { outcome?: AckOutcome; scope?: "all" | "users" } = {}
): Promise<AckDecision | null> {
  const params: unknown[] = [docId];
  let where = "x.document_id = $1";
  if (opts.outcome) {
    params.push(opts.outcome);
    where += ` AND x.outcome = $${params.length}`;
  }
  if (opts.scope) {
    params.push(opts.scope);
    where += ` AND x.scope = $${params.length}`;
  }
  const rows = await q<AckDecision>(
    `${DECISION_SELECT} WHERE ${where} ORDER BY x.decided_at DESC, x.id DESC LIMIT 1`,
    params
  );
  return rows[0] ?? null;
}

/** One decision row by id: the audit echo reads the row a save just wrote, never "the newest". */
export async function getAckDecision(id: number): Promise<AckDecision | null> {
  const rows = await q<AckDecision>(`${DECISION_SELECT} WHERE x.id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Kept edits since everyone was last asked (decisions since the marker), and
 * how far the live text has drifted from the confirmed version, in % of
 * words: three edits to the same paragraph count once, because every
 * decision row measures the new text against the version at the marker
 * (updateDocument's baseline), never against the previous save, so the
 * newest kept row's change_pct is that drift and no document text has to
 * be read to answer. Only a row written without a measurement (a kept row
 * inserted by hand) falls back to measuring the texts.
 */
export async function keptSinceLastReset(docId: number): Promise<{ count: number; drift_pct: number }> {
  const kept = (await keptSinceMarker([docId])).get(docId);
  return kept ? { count: kept.n, drift_pct: kept.pct } : { count: 0, drift_pct: 0 };
}

/** keptSinceLastReset for many documents at once (the portal); documents with no kept edits are absent. */
async function keptSinceMarker(ids: number[]): Promise<Map<number, { n: number; pct: number }>> {
  const out = new Map<number, { n: number; pct: number }>();
  if (ids.length === 0) return out;
  const rows = await q<{ document_id: number; n: number; change_pct: number | null }>(
    `SELECT DISTINCT ON (x.document_id) x.document_id,
            COUNT(*) OVER (PARTITION BY x.document_id)::int AS n,
            x.change_pct::float8 AS change_pct
     FROM ack_decisions x
     JOIN documents d ON d.id = x.document_id
     WHERE x.document_id = ANY($1) AND x.outcome = 'kept' AND x.decided_at >= d.ack_revision_at
     ORDER BY x.document_id, x.decided_at DESC, x.id DESC`,
    [ids]
  );
  for (const r of rows) out.set(r.document_id, { n: r.n, pct: r.change_pct ?? 0 });
  const unmeasured = rows.filter((r) => r.change_pct == null).map((r) => r.document_id);
  if (unmeasured.length === 0) return out;
  const texts = await q<{ id: number; title: string; content: string; base_title: string | null; base_content: string | null }>(
    `SELECT d.id, d.title, d.content, v.title AS base_title, v.content AS base_content
     FROM documents d LEFT JOIN doc_versions v ON v.id = d.ack_version_id
     WHERE d.id = ANY($1)`,
    [unmeasured]
  );
  for (const t of texts) {
    if (t.base_content == null) continue;
    out.get(t.id)!.pct = changeSummary(t.base_content, t.content, { oldTitle: t.base_title, newTitle: t.title }).pct;
  }
  return out;
}

export interface AckSummary {
  required: boolean;
  eligible: number;
  current: number;
  pending: number;
  /** The confirmation marker: when everyone was last asked. */
  reset_at: string;
  /** The marker's version (what people confirmed). */
  version_id: number | null;
  rev: number | null;
  /** The newest version (the text on screen). */
  latest_version_id: number | null;
  latest_rev: number | null;
  /** The per-document default for text edits (documents.ack_edit_default, A5). */
  edit_default: AckEditDefault;
  /**
   * The workspace's value (E4), so the popover can mark the matching option
   * "(workspace default)". Filled by GET /api/documents/[id]/ack and the
   * document page from lib/compliance-settings, never here: that module is
   * server-only and imports this one.
   */
  workspace_edit_default?: AckEditDefault;
  /** The workspace's "Require a reason for editorial fixes too" (E4); filled by the route beside workspace_edit_default. */
  keep_reason_required?: boolean;
  /**
   * Periodic re-confirmation (G1, 1.12.0): the interval in months (null =
   * off), the stored next date and the effective date as 'YYYY-MM-DD', so
   * the shield popover's status line (recertStatusLine) reads from the
   * summary the document page already has.
   */
  ack_recert_months: number | null;
  ack_next_recert_at: string | null;
  ack_effective_at: string | null;
  last_decision: AckDecision | null;
  /** The confirmed text, when asked for (the editor's what-changed view). */
  baseline?: { version_id: number; rev: number | null; title: string; content: string };
}

/**
 * Everything the editor needs before it decides (A3) and the ledger pages
 * show at the top: counts, the marker, the newest version and the last
 * decision. Counts only; the names of pending people never leave the
 * roster endpoint. Throws when the document does not exist (callers check
 * getDocument first).
 */
export async function ackSummary(docId: number, opts: { baseline?: boolean } = {}): Promise<AckSummary> {
  await ready();
  const doc = (
    await q<{
      ack_required: number;
      ack_revision_at: string;
      ack_edit_default: string;
      ack_recert_months: number | null;
      ack_next_recert_at: string | null;
      ack_effective_at: string | null;
    }>(
      `SELECT ack_required, ack_revision_at, ack_edit_default,
              ack_recert_months, ack_next_recert_at, ack_effective_at::text AS ack_effective_at
       FROM documents WHERE id = $1`,
      [docId]
    )
  )[0];
  if (!doc) throw new Error(`Document ${docId} not found.`);
  const [counts, info, last] = await Promise.all([
    ackCounts(pool(), docId),
    getAckVersionInfo(docId),
    // The whole audience's newest decision: a per-person re-ask (D4) is a
    // ledger row, not the document's last ask.
    lastAckDecision(docId, { scope: "all" }),
  ]);
  const summary: AckSummary = {
    required: doc.ack_required === 1,
    eligible: counts.eligible,
    current: counts.current,
    pending: Math.max(0, counts.eligible - counts.current),
    reset_at: doc.ack_revision_at,
    version_id: info.version_id,
    rev: info.rev,
    latest_version_id: info.latest_version_id,
    latest_rev: info.latest_rev,
    edit_default: editDefaultOf(doc),
    ack_recert_months: doc.ack_recert_months,
    ack_next_recert_at: doc.ack_next_recert_at,
    ack_effective_at: doc.ack_effective_at,
    last_decision: last,
  };
  if (opts.baseline && info.version_id != null) {
    const v = await getVersion(docId, info.version_id);
    if (v) summary.baseline = { version_id: v.id, rev: info.rev, title: v.title, content: v.content };
  }
  return summary;
}

// --- Ask everyone to re-confirm without an edit (A7, 1.10.1) -------------------
//
// The third writer of the marker, beside resetAcknowledgements (a text
// change) and the silent advance: a manager's deliberate re-ask, and later
// the annual sweep (G1, source 'recurrence'). One statement, so two
// managers, two tabs or two instances cannot double-reset.

/** What a re-ask claim answers: the reset it made, or why it made none. */
export type ReconfirmClaim =
  | {
      claimed: true;
      /** 'all' moved the document marker (A7); 'users' restarted the named people's cycle and left the marker where it was (D4). */
      scope: "all" | "users";
      decision_id: number;
      outbox_id: number;
      /** The decision row's confirmations_affected: everyone current before the move ('all'), or the rows re-opened ('users'). */
      confirmations_reset: number;
      eligible: number;
      /** The marker after the move ('all') or as it stands ('users'): the version and its number. */
      version_id: number | null;
      rev: number | null;
      title: string;
      space_id: number;
      /** The marker (ack_revision_at): new for 'all', unchanged for 'users'. */
      marker: string;
      /** When the ask was made: the decision row's decided_at (the marker for 'all', the cycle stamp for 'users'). */
      asked_at: string;
      /** 'users': the people whose cycle restarted, the outbox row's list; [] for 'all'. */
      user_ids: number[];
      /** 'users': the ids named that had no open row (exempt, removed, never assigned); [] for 'all'. */
      skipped: number[];
    }
  | {
      claimed: false;
      /**
       * The stamp that refused the claim (a request, a reminder or a re-ask
       * inside the hour); null when the document no longer takes
       * confirmations (unpublished, trashed, requirement off) or is gone.
       */
      last_asked_at: string | null;
      /**
       * A per-person claim (D4) in which nobody named had an open row: the
       * ids, so the route can say so. Absent on every other refusal.
       */
      skipped?: number[];
    };

export interface ReconfirmInput {
  source: "manual" | "recurrence";
  reason: string;
  actor: AckActor;
  /**
   * D4: ask only these people again. Their open rows' cycle restarts
   * (policy_assignments.cycle_started_at) and the document marker stays, so
   * everyone else's currency is untouched. Null or absent = everyone (A7).
   */
  userIds?: number[] | null;
  /** The sending request's origin, stored on the outbox row (1.10.1); '' for the recurrence sweep. */
  origin?: string;
}

/**
 * Ask everyone to re-confirm without an edit (A7): one atomic claim moves
 * the confirmation marker to the newest version and stamps the reminder
 * cooldown, in a single UPDATE whose WHERE carries the one-hour guard on
 * the column its SET changes (ack_last_reminded_at), so a second claim
 * waits on the row lock, re-reads the stamp the first wrote and matches
 * nothing. The 'reset' decision row (the reason, the confirmations counted
 * before the marker moved) and the 'updated' outbox row (immediate: manual
 * and recurrence never wait or coalesce) are written in the same
 * transaction, so a rollback leaves no trace. No version row is written:
 * the text did not change. Prior confirmations stay in the ledger.
 *
 * `client` is the caller's transaction client (the recurrence sweep, the
 * tests); null opens one here. The marker is the wall clock when it moves
 * (clock_timestamp(), the 1.10.0 rule resetAcknowledgements explains) and
 * the decision row carries the same stamp; the guard compares against
 * now(). The count runs before the claim under the statement's own
 * snapshot, as resetAcknowledgements counts: a confirmation that commits
 * between the two goes stale with the rest and is not in the number.
 */
export async function claimReconfirmation(
  client: Queryable | null,
  docId: number,
  opts: ReconfirmInput
): Promise<ReconfirmClaim> {
  if (client) return claimReconfirmationOn(client, docId, opts);
  await ready();
  const own = await pool().connect();
  try {
    await own.query("BEGIN");
    const claim = await claimReconfirmationOn(own, docId, opts);
    await own.query("COMMIT");
    return claim;
  } catch (e) {
    await own.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    own.release();
  }
}

/** One row a marker claim's UPDATE returns: the document after the move. */
interface MovedMarker {
  id: number;
  title: string;
  space_id: number;
  ack_version_id: number | null;
  rev: number | null;
  /** The new marker (ack_revision_at), also the decision row's decided_at. */
  marker: string;
}

/**
 * The tail of a marker claim, shared by claimReconfirmationOn (A7) and
 * claimDueRecertifications (G1): the 'reset' decision row with the counts
 * taken before the move and the marker's stamp as decided_at, then the
 * 'updated' outbox row (immediate for manual and recurrence, see
 * ackNoticeDelayMinutes; neither coalesces, see ackNoticeCoalesces).
 * `reason` is what the ledger keeps; `noticeReason` is what people read on
 * the outbox row, the same sentence unless the caller separates them (the
 * sweep does: "Annual re-confirmation" on the record, the months-since
 * sentence in the notice).
 */
async function recordMarkerClaim(
  client: Queryable,
  row: MovedMarker,
  counts: { eligible: number; current: number },
  opts: { source: "manual" | "recurrence"; reason: string; noticeReason?: string; actor: AckActor; origin?: string }
): Promise<{ decision_id: number; outbox_id: number }> {
  const decisionId = await recordAckDecision(client, {
    ...decisionColumns(
      row.id,
      row.title,
      "reset",
      { versionId: row.ack_version_id, actor: opts.actor, source: opts.source, reason: opts.reason },
      counts
    ),
    decided_at: row.marker,
  });
  const outboxId = await insertAckOutbox(client, {
    document_id: row.id,
    mode: "updated",
    source: opts.source,
    reason: opts.noticeReason ?? opts.reason,
    actor: opts.actor,
    user_ids: null,
    delay_minutes: ackNoticeDelayMinutes(opts.source),
    origin: opts.origin ?? "",
  });
  return { decision_id: decisionId, outbox_id: outboxId };
}

async function claimReconfirmationOn(client: Queryable, docId: number, opts: ReconfirmInput): Promise<ReconfirmClaim> {
  // A named list is the per-person statement (D4): the marker stays.
  if (opts.userIds != null) return claimPersonalReconfirmationOn(client, docId, opts.userIds, opts);
  // Counted before the marker moves: afterwards nothing is current.
  const counts = await ackCounts(client, docId);
  const moved = await client.query<MovedMarker>(
    `UPDATE documents
       SET ack_revision_at = clock_timestamp(),
           ack_version_id = (SELECT MAX(v.id) FROM doc_versions v WHERE v.document_id = documents.id),
           ack_last_reminded_at = clock_timestamp(),
           ${RECERT_NEXT_ON_RESET}
     WHERE id = $1 AND ack_required = 1 AND status = 'published' AND deleted_at IS NULL
       AND (ack_last_reminded_at IS NULL OR ack_last_reminded_at < now() - interval '1 hour')
     RETURNING id, title, space_id, ack_version_id,
               ${VERSION_REV("documents.ack_version_id")} AS rev,
               ack_revision_at::text AS marker`,
    [docId]
  );
  if (moved.rowCount === 0) {
    // Refused: say when readers were last asked, or that the document no
    // longer takes confirmations. A fresh snapshot, so the stamp a parallel
    // claim just committed is the one reported.
    const stamp = await client.query<{ last: string | null }>(
      `SELECT ack_last_reminded_at::text AS last FROM documents
       WHERE id = $1 AND ack_required = 1 AND status = 'published' AND deleted_at IS NULL`,
      [docId]
    );
    return { claimed: false, last_asked_at: stamp.rows[0]?.last ?? null };
  }
  const row = moved.rows[0];
  const { decision_id, outbox_id } = await recordMarkerClaim(client, row, counts, opts);
  return {
    claimed: true,
    scope: "all",
    decision_id,
    outbox_id,
    confirmations_reset: counts.current,
    eligible: counts.eligible,
    version_id: row.ack_version_id,
    rev: row.rev,
    title: row.title,
    space_id: row.space_id,
    marker: row.marker,
    asked_at: row.marker,
    user_ids: [],
    skipped: [],
  };
}

// --- Ask one person to re-confirm (D4, 1.13.0) ---------------------------------
//
// The per-person marker is policy_assignments.cycle_started_at: a person's
// confirmation counts while it is on or after BOTH the document marker and
// their row's cycle stamp (the audience queries' GREATEST). Restarting one
// row's cycle therefore lapses that person alone; the document marker, the
// Remind cooldown and everyone else's currency are untouched, and the prior
// confirmation stays in the ledger. The same statement serves the roster's
// row action and bulk bar through the reconfirm route (user_ids) and the
// assignments endpoints' 'reask' action.

/**
 * The per-person re-ask statement: restart the confirmation cycle of these
 * people's OPEN rows for one policy in one UPDATE (cycle_started_at moves,
 * the reminder and escalation stamps clear so the E2 cadence starts over),
 * and answer the user ids it re-opened. Exempt and removed rows, and people
 * never assigned, are not touched and not returned: the caller reports them
 * as skipped. Never touches acknowledgements.
 *
 * `at` is the one wall-clock stamp every row takes (the caller's, so the
 * ledger row carries the same instant; clock_timestamp() when absent, for
 * the reason resetAcknowledgements gives: a confirmation whose transaction
 * took the document's row lock first commits later than this transaction's
 * start). `dueAt` re-arms due_at on the rows it re-opens: a cycle that
 * starts today gets today's deadline from the cascade, so a person asked
 * again is not overdue and escalated at the next tick on a date they already
 * met; undefined leaves due_at as it is.
 */
export async function reopenAssignmentsFor(
  client: Queryable | null,
  docId: number,
  userIds: number[],
  opts: { at?: string | null; dueAt?: "cascade" | Date | string | null } = {}
): Promise<number[]> {
  const ids = uniqueIds(userIds);
  if (ids.length === 0) return [];
  if (!client) await ready();
  const params: unknown[] = [docId, ids, opts.at ?? null];
  let dueSet = "";
  if (opts.dueAt === "cascade") {
    params.push(await workspaceDueDays());
    dueSet = `, due_at = ${PA_REARM_DUE("$4")}`;
  } else if (opts.dueAt !== undefined) {
    params.push(opts.dueAt instanceof Date ? opts.dueAt.toISOString() : opts.dueAt);
    dueSet = ", due_at = $4::timestamptz";
  }
  const r = await (client ?? pool()).query<{ user_id: number }>(
    `UPDATE policy_assignments pa
        SET cycle_started_at = t.at, reminded_at = NULL, escalated_at = NULL${dueSet}
       ${PA_REARM_FROM},
            (SELECT COALESCE($3::timestamptz, clock_timestamp()) AS at) t
      WHERE pa.document_id = d.id AND d.id = $1 AND pa.user_id = ANY($2::int[])
        AND pa.removed_at IS NULL AND pa.exempt_at IS NULL
      RETURNING pa.user_id`,
    params
  );
  return r.rows.map((x) => x.user_id);
}

/**
 * The per-person branch of claimReconfirmation (D4): the document row is
 * read and locked (a confirmation in flight takes the same lock in
 * recordAcknowledgement, so it commits before or after the stamp, never
 * astride it; a whole-audience claim waits its turn), one wall-clock stamp
 * is taken, the named people's open rows are re-opened with a fresh
 * deadline from the cascade, then the 'reset' ledger row (scope 'users',
 * confirmations_affected = the rows re-opened, eligible = the audience,
 * decided_at = the stamp) and the immediate 'updated' outbox row naming
 * only those people are written in the same transaction. No marker move,
 * no Remind stamp, no hour guard: asking one person again blocks nothing.
 *
 * Answers {claimed: false, last_asked_at: null} when the document does not
 * take confirmations, and the same with `skipped` (the ids) when nobody
 * named has an open row: nothing is written either way.
 */
async function claimPersonalReconfirmationOn(
  client: Queryable,
  docId: number,
  userIds: number[],
  opts: ReconfirmInput
): Promise<ReconfirmClaim> {
  const ids = uniqueIds(userIds);
  const doc = await client.query<MovedMarker>(
    `SELECT id, title, space_id, ack_version_id,
            ${VERSION_REV("documents.ack_version_id")} AS rev,
            ack_revision_at::text AS marker
       FROM documents
      WHERE id = $1 AND ack_required = 1 AND status = 'published' AND deleted_at IS NULL
      FOR UPDATE`,
    [docId]
  );
  if (doc.rowCount === 0) return { claimed: false, last_asked_at: null };
  if (ids.length === 0) return { claimed: false, last_asked_at: null, skipped: [] };
  const row = doc.rows[0];
  const at = (await client.query<{ at: string }>("SELECT clock_timestamp()::text AS at")).rows[0].at;
  const reopened = await reopenAssignmentsFor(client, docId, ids, { at, dueAt: "cascade" });
  if (reopened.length === 0) return { claimed: false, last_asked_at: null, skipped: ids };
  const done = new Set(reopened);
  const skipped = ids.filter((id) => !done.has(id));
  // The audience for the ledger row; the rows re-opened are what the ask touched.
  const counts = await ackCounts(client, docId);
  const decisionId = await recordAckDecision(client, {
    ...decisionColumns(
      row.id,
      row.title,
      "reset",
      { versionId: row.ack_version_id, actor: opts.actor, source: opts.source, reason: opts.reason, scope: "users" },
      { eligible: counts.eligible, current: reopened.length }
    ),
    decided_at: at,
  });
  const outboxId = await insertAckOutbox(client, {
    document_id: row.id,
    mode: "updated",
    source: opts.source,
    reason: opts.reason,
    actor: opts.actor,
    user_ids: reopened,
    delay_minutes: ackNoticeDelayMinutes(opts.source),
    origin: opts.origin ?? "",
  });
  return {
    claimed: true,
    scope: "users",
    decision_id: decisionId,
    outbox_id: outboxId,
    confirmations_reset: reopened.length,
    eligible: counts.eligible,
    version_id: row.ack_version_id,
    rev: row.rev,
    title: row.title,
    space_id: row.space_id,
    marker: row.marker,
    asked_at: at,
    user_ids: reopened,
    skipped,
  };
}

// --- Periodic re-confirmation (G1, 1.12.0) --------------------------------------
//
// The fourth writer of the marker: the hourly sweep. A policy with an
// interval (documents.ack_recert_months) carries a stored next date
// (ack_next_recert_at); when it passes, one atomic claim moves the marker,
// the next date and the reminder stamp for every due policy at once, and
// A7's tail writes the ledger row and the notice. The per-policy settings
// (getAckRecert / setAckRecert) feed the Settings tab and the ack-settings
// route; the pure rules and copy live in lib/ack-recert.

/** One cycle the sweep fired: what the audit row and the caller need. */
export interface RecertCycle {
  document_id: number;
  title: string;
  space_id: number;
  /** The marker after the move: the newest version and its number. */
  version_id: number | null;
  rev: number | null;
  marker: string;
  decision_id: number;
  outbox_id: number;
  /** Confirmations that went stale (the decision row's confirmations_affected). */
  confirmations_reset: number;
  eligible: number;
  recert_months: number;
  /** Open assignment rows whose due date restarted with the cycle (E1). */
  rearmed: number;
}

/** The ledger and outbox actor of a cycle: nobody clicked. */
export const RECERT_ACTOR: AckActor = { id: null, name: "Scheduler" };

/** What makes a policy due (alias d): the sweep's pre-count and its claim read the same predicate. */
const RECERT_DUE = `d.ack_required = 1 AND d.status = 'published' AND d.deleted_at IS NULL AND d.branch_of IS NULL
       AND d.ack_retired_at IS NULL AND d.ack_recert_months IS NOT NULL AND d.ack_next_recert_at <= now()`;

/**
 * Fire every cycle that is due: ONE UPDATE moves the marker to the newest
 * version, the next date to now + interval and the reminder stamp, for every
 * published, required, unretired policy with a cycle whose next date has
 * passed. The statement moves the column its WHERE tests
 * (ack_next_recert_at), so a second instance's UPDATE waits on the row lock,
 * re-evaluates the row the first wrote and matches nothing: each cycle fires
 * once however many instances tick. Per returned row the tail is A7's
 * (recordMarkerClaim): the 'reset' ledger row (source 'recurrence', reason
 * "Annual re-confirmation", by Scheduler, the counts taken before the move)
 * and one immediate 'updated' outbox row whose reason is the sentence people
 * read; the drain never coalesces a recurrence row (ackNoticeCoalesces).
 *
 * The counts: the due set is read first and counted per policy under the
 * current marker (ackCounts, as claimReconfirmationOn counts before its
 * UPDATE); the claim then names those ids and re-tests the whole predicate,
 * so a row another instance moved in between is not returned and its counts
 * are dropped. A policy that comes due between the read and the claim waits
 * for the next tick. A confirmation that commits between the count and the
 * move goes stale with the rest and is not in the number (A7's rule).
 *
 * `client` is the caller's transaction (the tests); null opens one here and
 * commits it, so a failure leaves no moved marker, no row and no notice.
 * `documentIds` limits the sweep (tests sharing a database; the tick passes
 * nothing).
 *
 * The people's clocks (E1): in the same transaction, every open assignment
 * row of a policy whose cycle fired gets a fresh due date from the cascade
 * (dueAtSql: the policy's fixed date while still ahead, else now plus
 * due_days from policy_settings, the space, the workspace defaults the
 * caller loaded once (`defaults`), or the built-in), and its reminder and
 * escalation stamps are cleared so the E2 cadence starts over. Exempt and
 * removed rows are left as they are. `timeZone` is the workspace's
 * (settings.timezone), the zone a fixed date ends in.
 */
export interface RecertSweepOptions {
  documentIds?: number[];
  /** The workspace layer of the cascade (ack_defaults' numbers, null = built-in), loaded once per sweep by the caller. */
  defaults?: PolicyDefaultsLayer | null;
  timeZone?: string;
}

export async function claimDueRecertifications(
  client: Queryable | null,
  opts: RecertSweepOptions = {}
): Promise<RecertCycle[]> {
  if (client) return claimDueRecertificationsOn(client, opts);
  await ready();
  const own = await pool().connect();
  try {
    await own.query("BEGIN");
    const cycles = await claimDueRecertificationsOn(own, opts);
    await own.query("COMMIT");
    return cycles;
  } catch (e) {
    await own.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    own.release();
  }
}

async function claimDueRecertificationsOn(client: Queryable, opts: RecertSweepOptions): Promise<RecertCycle[]> {
  const only = opts.documentIds ?? null;
  const due = await client.query<{ id: number }>(
    `SELECT d.id FROM documents d
     WHERE ${RECERT_DUE} AND ($1::int[] IS NULL OR d.id = ANY($1::int[]))
     ORDER BY d.id`,
    [only]
  );
  if (due.rowCount === 0) return [];
  const ids = due.rows.map((r) => r.id);
  // Counted before the marker moves: afterwards nothing is current.
  const counts = new Map<number, { eligible: number; current: number }>();
  for (const id of ids) counts.set(id, await ackCounts(client, id));
  const moved = await client.query<MovedMarker & { recert_months: number }>(
    `UPDATE documents d
       SET ack_revision_at = clock_timestamp(),
           ack_version_id = (SELECT MAX(v.id) FROM doc_versions v WHERE v.document_id = d.id),
           ack_next_recert_at = clock_timestamp() + make_interval(months => d.ack_recert_months),
           ack_last_reminded_at = clock_timestamp()
     WHERE d.id = ANY($1::int[]) AND ${RECERT_DUE}
     RETURNING d.id, d.title, d.space_id, d.ack_version_id, d.ack_recert_months AS recert_months,
               ${VERSION_REV("d.ack_version_id")} AS rev,
               d.ack_revision_at::text AS marker`,
    [ids]
  );
  // The people's clocks restart with the cycle (E1): a fresh due date from
  // the cascade on every open row of the policies that fired, the reminder
  // and escalation stamps cleared. Same transaction as the marker, so the
  // notice the drain delivers already carries the new dates.
  const rearmed = new Map<number, number>();
  if (moved.rows.length > 0) {
    const r = await client.query<{ document_id: number }>(
      `UPDATE policy_assignments pa
          SET ${dueRearmSql("pa", { from: "clock_timestamp()", workspace: "$2", timeZone: "$3" })},
              reminded_at = NULL,
              escalated_at = NULL
        WHERE pa.document_id = ANY($1::int[])
          AND pa.removed_at IS NULL AND pa.exempt_at IS NULL
        RETURNING pa.document_id`,
      [moved.rows.map((m) => m.id), opts.defaults?.due_days ?? null, opts.timeZone || "UTC"]
    );
    for (const row of r.rows) rearmed.set(row.document_id, (rearmed.get(row.document_id) ?? 0) + 1);
  }
  const cycles: RecertCycle[] = [];
  for (const row of moved.rows) {
    const c = counts.get(row.id) ?? { eligible: 0, current: 0 };
    const tail = await recordMarkerClaim(client, row, c, {
      source: "recurrence",
      reason: RECERT_LEDGER_REASON,
      noticeReason: recertNoticeSentence(row.recert_months, row.title),
      actor: RECERT_ACTOR,
    });
    cycles.push({
      document_id: row.id,
      title: row.title,
      space_id: row.space_id,
      version_id: row.ack_version_id,
      rev: row.rev,
      marker: row.marker,
      decision_id: tail.decision_id,
      outbox_id: tail.outbox_id,
      confirmations_reset: c.current,
      eligible: c.eligible,
      recert_months: row.recert_months,
      rearmed: rearmed.get(row.id) ?? 0,
    });
  }
  return cycles;
}

/**
 * The SET clause a resume carries (G1 + G3): a cycle that fell due while the
 * policy was retired (or otherwise not taking confirmations) would fire at
 * the next tick, asking everyone again the day the policy came back. When
 * there is an interval and the next date has passed, the next date moves to
 * now + interval; anything else is untouched. unretirePolicy writes it in
 * its own UPDATE so nothing can tick between the resume and the move;
 * recertAfterResume runs it alone for any other path that brings a policy
 * back with a stale date.
 */
const RECERT_NEXT_ON_RESUME = `ack_next_recert_at = CASE
           WHEN ack_recert_months IS NOT NULL AND ack_next_recert_at <= now()
           THEN now() + make_interval(months => ack_recert_months)
           ELSE ack_next_recert_at
         END`;

/** Apply RECERT_NEXT_ON_RESUME on its own; answers the next date after the call (null without a cycle, or when the document is gone). */
export async function recertAfterResume(docId: number): Promise<string | null> {
  const r = await q<{ next: string | null }>(
    `UPDATE documents SET ${RECERT_NEXT_ON_RESUME} WHERE id = $1 RETURNING ack_next_recert_at AS next`,
    [docId]
  );
  return r[0]?.next ?? null;
}

/** The re-confirmation settings of one policy, as the Settings tab's card and the ack-settings GET read them. */
export interface AckRecert extends RecertFields {
  /** The marker (ack_revision_at): the first cycle is dated from it, and the Settings tab's warn line compares it with the interval. */
  ack_revision_at: string;
}

export async function getAckRecert(docId: number): Promise<AckRecert | undefined> {
  const r = await q<AckRecert>(
    `SELECT ack_recert_months, ack_next_recert_at, ack_effective_at::text AS ack_effective_at, ack_revision_at
     FROM documents WHERE id = $1`,
    [docId]
  );
  return r[0];
}

/**
 * Apply a validated re-confirmation patch (validateRecertPatch in
 * lib/ack-recert): the interval, the next date and the effective date, any
 * subset. The next date follows the interval: clearing the interval clears
 * it; setting or changing the interval without a next date (or with it
 * cleared) schedules the first cycle from the marker (marker + N months, or
 * now + 14 days when that is already past); an explicit next date is kept
 * as sent; a next date on a policy with no interval is not stored, there
 * being nothing to fire. Returns the row after the change, or undefined
 * when the document is gone.
 */
export async function setAckRecert(docId: number, patch: RecertPatch): Promise<AckRecert | undefined> {
  const cur = await getAckRecert(docId);
  if (!cur) return undefined;
  const months = patch.recert_months === undefined ? cur.ack_recert_months : patch.recert_months;
  let next: string | null;
  if (months === null) {
    next = null;
  } else if (patch.next_recert_at != null) {
    next = patch.next_recert_at;
  } else if (patch.next_recert_at === null || cur.ack_next_recert_at === null || months !== cur.ack_recert_months) {
    next = nextRecertDate(new Date(cur.ack_revision_at), months).toISOString();
  } else {
    next = cur.ack_next_recert_at;
  }
  const effective = patch.effective_at === undefined ? cur.ack_effective_at : patch.effective_at;
  const r = await q<AckRecert>(
    `UPDATE documents SET ack_recert_months = $2, ack_next_recert_at = $3, ack_effective_at = $4::date
     WHERE id = $1
     RETURNING ack_recert_months, ack_next_recert_at, ack_effective_at::text AS ack_effective_at, ack_revision_at`,
    [docId, months, next, effective]
  );
  return r[0];
}

// --- Deadlines (E1, 1.13.0) ---------------------------------------------------------
//
// A person's due date is materialised on their policy_assignments row when
// the row's clock starts (enrolment, a re-confirmation cycle, a re-ask) and
// moved only by a manager (extend, "Also move existing deadlines") or a
// rule change; nothing derives it at read time. The rule is the same in SQL
// (dueAtSql, for the claims and the reconcile) and in JS (dueAtFor in
// lib/ack-due, for a route): the policy's fixed date while it is still
// ahead, else the start plus due_days resolved through the cascade
// policy_settings -> spaces.policy_defaults -> the workspace's ack_defaults
// -> the built-in. The workspace layer is a parameter: every sweep loads it
// once (lib/compliance workspaceDueDefaults) and passes it in.

/**
 * The due-date expression for one assignment row. Requires the aliases
 * `ps` (policy_settings, LEFT JOINed on the document) and `s` (spaces, the
 * document's space) in scope. `from` is the SQL for the clock's start
 * (now(), clock_timestamp(), pa.cycle_started_at); `workspace` the
 * placeholder holding the workspace's number for `key` (int or null);
 * `timeZone` the placeholder holding the workspace's IANA zone, in which
 * the fixed date's day ends. `key` is 'due_days' (default) or
 * 'new_joiner_days' (which policy_settings does not carry: the cascade
 * starts at the space).
 */
export function dueAtSql(opts: { from: string; workspace: string; timeZone: string; key?: "due_days" | "new_joiner_days" }): string {
  const key = opts.key ?? "due_days";
  const policy = key === "due_days" ? "ps.due_days, " : "";
  const dayEnd = `((ps.due_at + 1)::timestamp AT TIME ZONE ${opts.timeZone}::text)`;
  return `CASE
      WHEN ps.due_at IS NOT NULL AND ${dayEnd} > ${opts.from} THEN ${dayEnd} - interval '1 millisecond'
      ELSE ${opts.from} + make_interval(days => COALESCE(${policy}(s.policy_defaults->>'${key}')::int, ${opts.workspace}::int, ${BUILT_IN[key]}))
    END`;
}

/**
 * THE fragment every writer that restarts a row's clock uses: the
 * re-confirmation claim here, the exempt agent's un-exempt and
 * expireExemptions, the reask agent's re-open, a reconcile's re-open.
 * `due_at = (the cascade from \`from\`)`, as a correlated subquery on the
 * row's own document, so it drops into any `UPDATE policy_assignments <row>
 * SET …` or `INSERT … ON CONFLICT DO UPDATE SET …` without joins. `row` is
 * the alias of the policy_assignments row being written ('pa'; in an ON
 * CONFLICT clause the table name, 'policy_assignments').
 *
 * Parameters the caller binds: `workspace` is the placeholder holding the
 * workspace's due_days, an integer or null (`(await
 * workspaceDueDefaults()).due_days ?? null` in lib/compliance, loaded once
 * per sweep or request); `timeZone` the placeholder holding the workspace's
 * IANA zone (`(await getAppSettings()).timezone`, or 'UTC'), in which a
 * fixed date's day ends; `from` the SQL for the clock's start (now() by
 * default; clock_timestamp() where the caller stamps the rest of the row
 * with it). The rule is dueAtFor's (lib/ack-due): the policy's fixed date
 * while still ahead, else `from` plus due_days resolved policy ->
 * space -> workspace -> built-in 14.
 */
export function dueRearmSql(row: string, opts: { workspace: string; timeZone: string; from?: string }): string {
  return `due_at = (SELECT ${dueAtSql({ from: opts.from ?? "now()", workspace: opts.workspace, timeZone: opts.timeZone })}
      FROM documents d
      LEFT JOIN policy_settings ps ON ps.document_id = d.id
      LEFT JOIN spaces s ON s.id = d.space_id
     WHERE d.id = ${row}.document_id)`;
}

/** The layers of one policy's cascade as stored, for resolvePolicyDefaults (lib/compliance). */
export interface PolicyDefaultLayers {
  /** policy_settings' own numbers and owner (empty when the policy has no row yet). */
  policy: PolicyDefaultsLayer;
  /** The policy's deadline rule: due_days or a fixed 'YYYY-MM-DD', both null = inherit. */
  rule: DueRule;
  space: { id: number; name: string; defaults: PolicyDefaultsLayer };
}

export async function policyDefaultLayers(docId: number): Promise<PolicyDefaultLayers | undefined> {
  const r = await q<{
    space_id: number;
    space_name: string;
    policy_defaults: unknown;
    due_days: number | null;
    due_at: string | null;
    remind_before_days: number | null;
    remind_every_days: number | null;
    escalate_after_days: number | null;
    nudge_every_days: number | null;
    owner_user_id: number | null;
  }>(
    `SELECT s.id AS space_id, s.name AS space_name, s.policy_defaults,
            ps.due_days, ps.due_at::text AS due_at, ps.remind_before_days, ps.remind_every_days,
            ps.escalate_after_days, ps.nudge_every_days, ps.owner_user_id
       FROM documents d
       JOIN spaces s ON s.id = d.space_id
       LEFT JOIN policy_settings ps ON ps.document_id = d.id
      WHERE d.id = $1`,
    [docId]
  );
  const row = r[0];
  if (!row) return undefined;
  return {
    policy: sanitizeLayer({
      due_days: row.due_days,
      remind_before_days: row.remind_before_days,
      remind_every_days: row.remind_every_days,
      escalate_after_days: row.escalate_after_days,
      nudge_every_days: row.nudge_every_days,
      owner_user_id: row.owner_user_id,
    }),
    rule: { due_days: row.due_days, due_at: row.due_at },
    space: { id: row.space_id, name: row.space_name, defaults: sanitizeLayer(row.policy_defaults) },
  };
}

/**
 * The due dates of the open rows of a policy, by user id (null = no due
 * date), for the notices: the drain fills the email's due tags from each
 * recipient's own row. `userIds` null = every open row.
 */
export async function assignmentDueDates(docId: number, userIds: number[] | null): Promise<Map<number, string | null>> {
  const rows = await q<{ user_id: number; due_at: string | null }>(
    `SELECT user_id, due_at FROM policy_assignments
      WHERE document_id = $1 AND removed_at IS NULL AND exempt_at IS NULL
        AND ($2::int[] IS NULL OR user_id = ANY($2::int[]))`,
    [docId, userIds]
  );
  return new Map(rows.map((r) => [r.user_id, r.due_at]));
}

/**
 * "Also move existing deadlines" (E1): recompute the due date of every open
 * row of a policy from the rule as it now stands: the fixed date (its last
 * instant in the workspace zone) while it is still ahead, else each row's
 * cycle start plus the days (the rule's own, or `dueDays`, the number the
 * cascade resolves when the rule inherits). The old and new dates go onto
 * the row's due_history ({from, to, by, at, reason}, the last
 * DUE_HISTORY_MAX kept), an escalation stamp is cleared when the new date is
 * ahead so the escalation can fire again, and a row whose date would not
 * change is left alone (no history entry). Exempt and removed rows are not
 * touched. Returns the rows moved; the caller (movePolicyDeadlines in
 * lib/compliance) writes the audit row, and the toast's Undo is the exempt
 * agent's undoExtension over these ids.
 */
export async function moveDeadlines(
  docId: number,
  rule: DueRule,
  opts: { dueDays: number; timeZone?: string; actor: AckActor; reason?: string }
): Promise<{ moved: number; ids: number[] }> {
  const fixed = endOfDayIn(rule.due_at, opts.timeZone || "UTC");
  const fixedAhead = fixed && fixed.getTime() > Date.now() ? fixed.toISOString() : null;
  const days = rule.due_days ?? opts.dueDays;
  const reason = opts.reason ?? (fixedAhead ? "Deadline set to a fixed date" : `Deadline rule changed to ${days} days after assignment`);
  const rows = await q<{ id: number }>(
    `WITH target AS (
       SELECT pa.id, pa.due_at AS from_due,
              CASE WHEN $2::timestamptz IS NOT NULL THEN $2::timestamptz
                   ELSE pa.cycle_started_at + make_interval(days => $3::int) END AS to_due
         FROM policy_assignments pa
        WHERE pa.document_id = $1 AND pa.removed_at IS NULL AND pa.exempt_at IS NULL
     )
     UPDATE policy_assignments pa
        SET due_at = t.to_due,
            escalated_at = CASE WHEN t.to_due > now() THEN NULL ELSE pa.escalated_at END,
            due_history = (
              SELECT COALESCE(jsonb_agg(h.e ORDER BY h.i), '[]'::jsonb)
                FROM (SELECT e, i FROM jsonb_array_elements(pa.due_history) WITH ORDINALITY AS x(e, i)
                       ORDER BY i DESC LIMIT $6::int - 1) AS h
            ) || jsonb_build_array(jsonb_build_object('kind', 'moved', 'from', t.from_due, 'to', t.to_due, 'by', $4::int, 'at', now(), 'reason', $5::text))
       FROM target t
      WHERE pa.id = t.id AND pa.due_at IS DISTINCT FROM t.to_due
      RETURNING pa.id`,
    [docId, fixedAhead, days, opts.actor.id ?? null, reason, DUE_HISTORY_MAX]
  );
  return { moved: rows.length, ids: rows.map((r) => r.id) };
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

/** The submitter's recommendation as the request stores it (A6): 'keep' or 'reset' as given, 'auto' for anything else. */
export type ChangeRequestAckPolicy = "keep" | "reset" | "auto";

/** The longest reason a request or a decision keeps (the dialog's own limit, ReconfirmModal NOTE_MAX). */
export const ACK_REASON_MAX = 500;

/** Normalise a submitter's ack_policy: only the two real choices are kept; absent, 'auto' or anything else means "no recommendation". */
export function changeRequestAckPolicy(raw: unknown): ChangeRequestAckPolicy {
  return raw === "keep" || raw === "reset" ? raw : "auto";
}

/** Normalise a reason as every write path does: a string, trimmed, cut at ACK_REASON_MAX; anything else is ''. */
export function changeRequestAckReason(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, ACK_REASON_MAX) : "";
}

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
  /**
   * The submitter's recommendation for the readers of a confirmed document
   * (A6, 1.11.0): 'keep' (editorial fix) or 'reset' (material change), with
   * their reason. Anything else is stored as 'auto' (no recommendation);
   * the reason is cut at ACK_REASON_MAX. The approver decides at approval.
   */
  ack_policy?: unknown;
  ack_reason?: unknown;
}): Promise<number> {
  const r = await q<{ id: number }>(
    `INSERT INTO change_requests (document_id, kind, title, content, summary, tags, type, target_status, note, created_by, space_id, ack_policy, ack_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
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
      changeRequestAckPolicy(input.ack_policy),
      changeRequestAckReason(input.ack_reason),
    ]
  );
  return r[0].id;
}

// The review list carries only d.ack_required and d.ack_version_id of the
// target (A6): enough for the queue's chips. The live text is read with
// SELECT ... FOR UPDATE inside the approval transaction, never here.
const CR_SELECT = `
  SELECT cr.*, u.name AS author_name, d.title AS document_title,
         d.ack_required, d.ack_version_id,
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

/** What approving a change request did to the document and its confirmations. */
export interface ApproveChangeRequestResult {
  /** False when the proposed title and text equal the live row: no version row was written. */
  version_written: boolean;
  /** As updateDocument reports it; the route echoes it to the audit log through auditAckDecision. */
  ack_outcome: AckOutcomeWithDecision;
}

/** What the reviewer sends with an approval (A6). */
export interface ApproveChangeRequestOptions {
  /** The sending request's origin, carried on the notice a reset queues (1.10.1). */
  origin?: string;
  /**
   * The reviewer's own decision for a substantive change to a confirmed,
   * published document; absent = the submitter's stored recommendation when
   * it is 'keep' or 'reset', otherwise the document's edit default
   * (resolveAutoAckPolicy). Checked before any write: a reset needs a
   * reason of ACK_REASON_MIN characters; a keep follows
   * ackKeepReasonRequired (true when absent), as updateDocument does. The
   * reason, when given, is also the version note (the approve question's
   * change note), in place of the request's note.
   */
  ackPolicy?: "keep" | "reset";
  ackReason?: string;
  ackKeepReasonRequired?: boolean;
}

/**
 * Approve a change request: apply its proposed state to the document. An
 * approval is a text write like any other, so it takes updateDocument's
 * decisions (A2): no version row when the proposed title and text equal the
 * live row; `substantive` is measured against the version everyone was last
 * asked to confirm, on the live row locked inside this transaction; on a
 * confirmed, published document the reviewer's ackPolicy applies when given,
 * otherwise the submitter's recommendation stored on the request (A6,
 * 1.11.0), otherwise the document's edit default (A5). The decision row
 * records both sides (C1): submitted_policy and submitted_by are the
 * request's, decided_by is the reviewer, the reason is the reviewer's when
 * they gave one, else the submitter's, else the change note. With the
 * requirement off the marker follows the text silently (rule 3); into a
 * draft the marker waits for the publish. Everything runs in one transaction
 * on a locked document row. Returns false when the request is no longer
 * pending or its document is gone; throws AckReasonRequiredError, before any
 * write, when the reviewer's policy comes without a usable reason.
 */
export async function approveChangeRequest(
  id: number,
  reviewerId: number,
  reviewerName: string,
  note = "",
  opts: ApproveChangeRequestOptions = {}
): Promise<ApproveChangeRequestResult | false> {
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
    const live = (
      await client.query<{
        title: string;
        content: string;
        status: string;
        ack_required: number;
        ack_version_id: number | null;
        ack_edit_default: string;
      }>(
        "SELECT title, content, status, ack_required, ack_version_id, ack_edit_default FROM documents WHERE id = $1 FOR UPDATE",
        [cr.document_id]
      )
    ).rows[0];
    if (!live) {
      await client.query("ROLLBACK");
      return false;
    }

    // The same rules as updateDocument, on the proposed row.
    const versionWorthy = cr.title !== live.title || cr.content !== live.content;
    const baseline = live.ack_version_id
      ? (
          await client.query<{ title: string; content: string }>(
            "SELECT title, content FROM doc_versions WHERE id = $1 AND document_id = $2",
            [live.ack_version_id, cr.document_id]
          )
        ).rows[0]
      : undefined;
    const base = baseline ?? { title: live.title, content: live.content };
    const driftsFromBaseline = cr.content !== base.content || cr.title !== base.title;
    const publishing = live.status !== "published" && cr.target_status === "published";
    const substantive = driftsFromBaseline && (versionWorthy || publishing);
    const decides = substantive && live.ack_required === 1 && cr.target_status === "published";
    const silentAdvance = substantive && live.ack_required !== 1;

    // Who decides (A6): the reviewer when they said, else the submitter's
    // recommendation, else nobody ('auto', the edit default). The
    // reviewer's reason is checked before any write, so a refused approval
    // leaves the request pending and the document untouched; the
    // submitter's stored choice is applied with the reason as they gave it
    // (the route's pre-flight is where the API enforces its length).
    const submitted = changeRequestAckPolicy(cr.ack_policy);
    const reviewerReason = (opts.ackReason ?? "").trim().slice(0, ACK_REASON_MAX);
    const chosen: AckPolicy = opts.ackPolicy ?? submitted;
    // The version note: the reviewer's change note from the approve question
    // when they gave one (the dialog's note is the version note in every
    // mode, as a merge's and a restore's are), else the submitter's change
    // note; either way it records who approved it.
    const versionNote = reviewerReason
      ? `${reviewerReason} — approved by ${reviewerName}`
      : cr.note
        ? `${cr.note} — approved by ${reviewerName}`
        : `Approved by ${reviewerName}`;
    if (decides && opts.ackPolicy) {
      if (
        reviewerReason.length < ACK_REASON_MIN &&
        (opts.ackPolicy === "reset" || opts.ackKeepReasonRequired !== false)
      ) {
        throw new AckReasonRequiredError();
      }
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
    // The version the decision is about: the row written now, or (publish
    // transition without a text change) the newest row already there.
    let versionId: number | null = null;
    if (versionWorthy) {
      // Provenance (C6): the submitter published the words, the reviewer
      // approved them, and the request that carried them is on the row.
      const v = await client.query<{ id: number }>(
        `INSERT INTO doc_versions
           (document_id, title, content, author, note,
            published_by, published_by_name, approved_by, approved_by_name, change_request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          cr.document_id,
          cr.title,
          cr.content,
          cr.author_name,
          versionNote,
          cr.created_by,
          cr.author_name,
          reviewerId,
          reviewerName,
          id,
        ]
      );
      versionId = v.rows[0].id;
    } else if (substantive) {
      const v = await client.query<{ id: number | null }>(
        "SELECT MAX(id) AS id FROM doc_versions WHERE document_id = $1",
        [cr.document_id]
      );
      versionId = v.rows[0]?.id ?? null;
    }

    const actor: AckActor = { id: reviewerId, name: reviewerName };
    let ack: AckOutcomeWithDecision = {
      changed: true,
      substantive,
      reset: false,
      confirmations_reset: 0,
      policy: chosen,
      source: "approval",
      decision_id: null,
    };
    if (decides && versionId !== null) {
      // A person's choice (the reviewer's, else the submitter's) applies as
      // given. With neither, nobody is there to ask, so the document's edit
      // default decides (A5): under 'material' an editorial-looking request
      // is kept and recorded from source 'default', like a kept save;
      // anything else resets with source 'approval'. The same helper
      // updateDocument uses.
      const summary = changeSummary(base.content, cr.content, { oldTitle: base.title, newTitle: cr.title });
      const suggestion = suggestReconfirm(summary);
      const { resolved, decidedBySetting } =
        chosen === "auto" ? resolveAutoAckPolicy(live, suggestion) : { resolved: chosen, decidedBySetting: false };
      const decision = {
        versionId,
        actor,
        source: decidedBySetting ? ("default" as const) : ("approval" as const),
        reason: reviewerReason || changeRequestAckReason(cr.ack_reason) || cr.note.trim() || versionNote,
        summary,
        suggested: suggestion.policy,
        overrodeSuggestion: chosen !== "auto" && chosen !== suggestion.policy,
        submittedPolicy: submitted === "auto" ? ("" as const) : submitted,
        submittedBy: { id: cr.created_by, name: cr.author_name },
        origin: opts.origin,
      };
      if (resolved === "keep") {
        const k = await keepAcknowledgements(client, cr.document_id, decision);
        ack = { ...ack, source: decidedBySetting ? "default" : "approval", decision_id: k.decision_id };
      } else {
        const r = await resetAcknowledgements(client, cr.document_id, decision);
        ack = { ...ack, reset: true, confirmations_reset: r.confirmations_reset, decision_id: r.decision_id };
      }
    } else if (silentAdvance && versionId !== null) {
      await resetAcknowledgements(client, cr.document_id, {
        versionId,
        actor,
        source: "approval",
        reason: "",
        silent: true,
      });
    }

    await client.query(
      "UPDATE change_requests SET status='approved', reviewed_by=$1, reviewed_at=now(), review_note=$2 WHERE id=$3",
      [reviewerId, note, id]
    );
    await client.query("COMMIT");
    return { version_written: versionWorthy, ack_outcome: ack };
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
 * so it is refused here and the user's role is changed in Settings → Users
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
 * roles that the Users page cannot show from `users.role` alone (0.97).
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
