// Composable email templates (1.19.0). Every email CompassDocs sends is
// built from four parts, each from its own library:
//
//   header      the top of the mail (built-ins: "Standard header", the
//               default: the workspace logo and name over an accent bar;
//               and "No header")
//   body        one per email event, carrying the subject: today's
//               EMAIL_TEMPLATES entries, seeded as built-in bodies (from the
//               admin's old override when there was one). An event may have
//               further bodies of its own (a team's variant).
//   signature   built-ins "No signature" (the default) and "Team signature"
//   footer      built-ins "Standard footer" (the default): the workspace name
//               and a "Manage your notifications" link; and "No footer"
//
// A composition picks one of each for an event, for everyone ('all') or for
// one helpdesk team ('hd_team:<id>'). A null slot inherits: a team row from
// the event's 'all' row, the 'all' row from the kind's default part (the
// event's built-in body for a body).
//
// Owner decision (1.19.0): every email is branded by default, with the
// Standard header and Standard footer around the body (which stays byte for
// byte what 1.18 sent). G's first cut seeded the empty parts as defaults;
// a workspace seeded that way is moved to the standard ones once
// (migrateDefaultsV2, marker setting `email_parts_defaults_v2`), unless an
// admin has set a default of that kind themselves. Emails that carry their
// own layout (newsletters, the weekly digest, the directory sync report)
// never go through these parts.
//
// lib/email-templates renders through resolveComposition(); this module is
// the data layer (schema: lib/email-parts-schema). The tables are created
// and the built-ins seeded on first use (and by the boot schema step once
// lib/db appends EMAIL_PARTS_SCHEMA), idempotently, under an advisory lock.
// Server-only.

import "server-only";
import { dbReady, pool, withAdvisoryLock } from "./db";
import type { Queryable } from "./db";
import {
  COMMON_OPTIONAL_TAGS,
  COMMON_TAGS,
  COMMON_TEXT_TAGS,
  EMAIL_TEMPLATES,
  FRAME_TEXT_TAGS,
  SAMPLE_FRAME_VARS,
  SAMPLE_VARS,
  SIGNATURE_TAGS,
  renderComposedEmail,
  templateDef,
} from "./email-templates";
import { EMAIL_PARTS_SCHEMA } from "./email-parts-schema";

export { EMAIL_PARTS_SCHEMA };

export const PART_KINDS = ["header", "body", "signature", "footer"] as const;
export type EmailPartKind = (typeof PART_KINDS)[number];
export const PART_KIND_LABEL: Record<EmailPartKind, string> = {
  header: "Header",
  body: "Body",
  signature: "Signature",
  footer: "Footer",
};

export function isPartKind(v: unknown): v is EmailPartKind {
  return typeof v === "string" && (PART_KINDS as readonly string[]).includes(v);
}

export const PART_NAME_MAX = 120;
export const PART_SUBJECT_MAX = 300;
export const PART_BODY_MAX = 20_000;
export const PART_CONTENT_MAX = 5_000; // headers, signatures, footers

export const SCOPE_ALL = "all";
const TEAM_SCOPE_RE = /^hd_team:([1-9]\d{0,9})$/;

/** 'all' or 'hd_team:<id>'; anything else is not a scope. */
export function isScope(v: unknown): v is string {
  return v === SCOPE_ALL || (typeof v === "string" && TEAM_SCOPE_RE.test(v));
}
export function teamIdOfScope(scope: string): number | null {
  const m = TEAM_SCOPE_RE.exec(scope);
  return m ? Number(m[1]) : null;
}
/** Helpdesk events (hd_*): the only ones a team scope applies to. */
export function isHelpdeskEvent(eventKey: string): boolean {
  return eventKey.startsWith("hd_");
}

// --- Tags every part may use (defined in lib/email-templates, which renders them) ---

export { COMMON_TAGS, SIGNATURE_TAGS, COMMON_TEXT_TAGS, FRAME_TEXT_TAGS, COMMON_OPTIONAL_TAGS };

/** The tags offered when editing a part of `kind` (for a body: its event's too). */
export function partTags(kind: EmailPartKind, eventKey?: string | null): { tag: string; label: string }[] {
  const out = [...COMMON_TAGS];
  if (kind === "signature") out.push(...SIGNATURE_TAGS);
  const def = eventKey ? templateDef(eventKey) : undefined;
  for (const t of def?.tags ?? []) if (!out.some((o) => o.tag === t.tag)) out.push(t);
  return out;
}

// --- Built-ins ---------------------------------------------------------------------

interface BuiltinFrame {
  key: string;
  kind: Exclude<EmailPartKind, "body">;
  name: string;
  content: string;
  /** The kind's default on a fresh install. */
  seedDefault: boolean;
}

/**
 * The built-in headers, signatures and footers. The Standard header and
 * footer are the defaults (no signature); see the module comment.
 */
export const BUILTIN_FRAMES: BuiltinFrame[] = [
  { key: "header:none", kind: "header", name: "No header", content: "", seedDefault: false },
  { key: "header:standard", kind: "header", name: "Standard header", content: "{{logo}} **{{org_name}}**", seedDefault: true },
  { key: "signature:none", kind: "signature", name: "No signature", content: "", seedDefault: true },
  { key: "signature:team", kind: "signature", name: "Team signature", content: "{{team_name}} · {{org_name}}", seedDefault: false },
  { key: "footer:none", kind: "footer", name: "No footer", content: "", seedDefault: false },
  {
    key: "footer:standard",
    kind: "footer",
    name: "Standard footer",
    content: "Sent by {{org_name}} · [Manage your notifications]({{manage_notifications_url}})",
    seedDefault: true,
  },
];

export function bodyBuiltinKey(eventKey: string): string {
  return `body:${eventKey}`;
}

/** What "Reset to original" restores for a built-in part (null for a custom one). */
export function builtinOriginal(builtinKey: string | null): { name: string; subject: string; content: string } | null {
  if (!builtinKey) return null;
  if (builtinKey.startsWith("body:")) {
    const def = templateDef(builtinKey.slice(5));
    return def ? { name: def.label, subject: def.subject, content: def.body } : null;
  }
  const f = BUILTIN_FRAMES.find((b) => b.key === builtinKey);
  return f ? { name: f.name, subject: "", content: f.content } : null;
}

// --- Rows ----------------------------------------------------------------------------

export interface EmailPart {
  id: number;
  kind: EmailPartKind;
  name: string;
  event_key: string | null;
  subject: string;
  content: string;
  builtin_key: string | null;
  is_default: boolean;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  /** Seeded with CompassDocs: editable and resettable, never deletable. */
  builtin: boolean;
  /** A built-in whose name, subject or content differs from the original. */
  customized: boolean;
}

export interface PartUsage {
  event_key: string;
  event_label: string;
  scope: string;
  slot: EmailPartKind;
}

interface PartRow {
  id: number;
  kind: string;
  name: string;
  event_key: string | null;
  subject: string;
  content: string;
  builtin_key: string | null;
  is_default: number;
  created_by: number | null;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
}

const PART_COLS = `p.id, p.kind, p.name, p.event_key, p.subject, p.content, p.builtin_key, p.is_default,
  p.created_by, u.name AS created_by_name, p.created_at, p.updated_at`;
const PART_FROM = "email_template_parts p LEFT JOIN users u ON u.id = p.created_by";

function toPart(r: PartRow): EmailPart {
  const original = builtinOriginal(r.builtin_key);
  return {
    id: r.id,
    kind: r.kind as EmailPartKind,
    name: r.name,
    event_key: r.event_key,
    subject: r.subject,
    content: r.content,
    builtin_key: r.builtin_key,
    is_default: r.is_default === 1,
    created_by: r.created_by,
    created_by_name: r.created_by_name ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    builtin: !!r.builtin_key,
    customized: !!original && (original.subject !== r.subject || original.content !== r.content || original.name !== r.name),
  };
}

// --- Schema and seeding -----------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __compassEmailParts: Promise<void> | undefined;
}

/**
 * The tables exist and every built-in is seeded, once per process. Cheap
 * after the first call (a resolved promise); a failed attempt is retried on
 * the next call.
 */
export function ensureEmailParts(): Promise<void> {
  if (!global.__compassEmailParts) {
    global.__compassEmailParts = seedEmailParts().catch((e) => {
      global.__compassEmailParts = undefined;
      throw e;
    });
  }
  return global.__compassEmailParts;
}

/** The old per-template override (`email_tpl_<key>`), when it is a valid one. */
function parseOverride(raw: string | undefined): { subject: string; body: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.subject === "string" && typeof parsed?.body === "string") return parsed;
  } catch {
    /* not an override */
  }
  return null;
}

/**
 * Create the tables when the boot has not (lib/db appends the schema once
 * agent A wires it), then insert whatever built-in is missing: the frames,
 * a body per EMAIL_TEMPLATES entry (seeded from the admin's old override,
 * so customisations carry over) and the event's 'all' composition. Rows
 * that exist are never touched, so an admin's edits and defaults survive
 * every boot. Exported for the tests (idempotency).
 */
export async function seedEmailParts(events: string[] = EMAIL_TEMPLATES.map((t) => t.key)): Promise<void> {
  await dbReady();
  // Fast path: everything is there (every boot after the first).
  const have = await pool()
    .query<{ parts: number; comps: number; v2: boolean }>(
      `SELECT (SELECT COUNT(*)::int FROM email_template_parts WHERE builtin_key = ANY($1)) AS parts,
              (SELECT COUNT(*)::int FROM email_template_compositions WHERE scope = 'all' AND event_key = ANY($2)) AS comps,
              EXISTS (SELECT 1 FROM settings WHERE key = '${DEFAULTS_V2_MARKER}') AS v2`,
      [[...BUILTIN_FRAMES.map((f) => f.key), ...events.map(bodyBuiltinKey)], events]
    )
    .then((r) => r.rows[0])
    .catch(() => null); // the tables do not exist yet
  if (have && have.v2 && have.parts === BUILTIN_FRAMES.length + events.length && have.comps === events.length) return;

  await withAdvisoryLock("email_template_parts:seed", async (c) => {
    const exists = await c.query<{ ok: boolean }>("SELECT to_regclass('email_template_compositions') IS NOT NULL AS ok");
    if (!exists.rows[0].ok) await c.query(EMAIL_PARTS_SCHEMA);
    for (const f of BUILTIN_FRAMES) {
      await c.query(
        `INSERT INTO email_template_parts (kind, name, content, builtin_key, is_default)
         SELECT $1::text, $2::text, $3::text, $4::text,
                CASE WHEN $5::boolean AND NOT EXISTS (SELECT 1 FROM email_template_parts WHERE kind = $1::text AND is_default = 1) THEN 1 ELSE 0 END
         ON CONFLICT (builtin_key) DO NOTHING`,
        [f.kind, f.name, f.content, f.key, f.seedDefault]
      );
    }
    const overrides = new Map<string, string>();
    for (const r of (
      await c.query<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key = ANY($1)", [
        events.map((k) => `email_tpl_${k}`),
      ])
    ).rows) {
      overrides.set(r.key.slice("email_tpl_".length), r.value);
    }
    for (const key of events) {
      const def = templateDef(key);
      if (!def) continue;
      const o = parseOverride(overrides.get(key));
      // As the old renderEmail read it: an empty half of an override fell back to the default.
      const subject = o?.subject || def.subject;
      const body = o?.body || def.body;
      await c.query(
        `INSERT INTO email_template_parts (kind, name, event_key, subject, content, builtin_key)
         VALUES ('body', $1, $2, $3, $4, $5) ON CONFLICT (builtin_key) DO NOTHING`,
        [def.label, key, subject, body, bodyBuiltinKey(key)]
      );
      await c.query(
        `INSERT INTO email_template_compositions (event_key, scope, body_id)
         SELECT $1::text, 'all', id FROM email_template_parts WHERE builtin_key = $2
         ON CONFLICT (event_key, scope) DO NOTHING`,
        [key, bodyBuiltinKey(key)]
      );
    }
    await migrateDefaultsV2(c);
  });
}

/** Set once the defaults have been moved to the Standard header and footer (or found chosen by an admin). */
export const DEFAULTS_V2_MARKER = "email_parts_defaults_v2";

/**
 * The once-only move to branded defaults (1.19.0, owner decision), inside
 * the seed's lock: for the header and the footer, when the kind's default
 * is still the built-in empty part ("No header" / "No footer", what G's
 * first seed chose) and no admin has ever set a default of that kind (no
 * email_template.default_changed audit entry for it), the Standard one
 * becomes the default. A default an admin chose, even "No header" itself,
 * is never touched. Then the marker is written, so it never runs again,
 * not even after an admin later goes back to "No header". A fresh install
 * seeds the Standard parts as defaults and only writes the marker.
 * Answers the kinds it moved. Exported for the tests.
 */
export async function migrateDefaultsV2(c: Queryable): Promise<EmailPartKind[]> {
  const done = await c.query("SELECT 1 FROM settings WHERE key = $1", [DEFAULTS_V2_MARKER]);
  if (done.rows.length > 0) return [];
  const moved: EmailPartKind[] = [];
  for (const kind of ["header", "footer"] as const) {
    const cur = (
      await c.query<{ builtin_key: string | null }>("SELECT builtin_key FROM email_template_parts WHERE kind = $1 AND is_default = 1", [kind])
    ).rows[0];
    if (cur?.builtin_key !== `${kind}:none`) continue;
    const chosen = await c.query(
      "SELECT 1 FROM audit_log WHERE action = 'email_template.default_changed' AND details->>'kind' = $1 LIMIT 1",
      [kind]
    );
    if (chosen.rows.length > 0) continue;
    const std = await c.query("SELECT id FROM email_template_parts WHERE builtin_key = $1", [`${kind}:standard`]);
    if (std.rows.length === 0) continue;
    // One default per kind (a unique index): clear the old one first.
    await c.query("UPDATE email_template_parts SET is_default = 0 WHERE kind = $1 AND is_default = 1", [kind]);
    await c.query("UPDATE email_template_parts SET is_default = 1 WHERE id = $1", [std.rows[0].id]);
    moved.push(kind);
  }
  await c.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [
    DEFAULTS_V2_MARKER,
    JSON.stringify({ at: new Date().toISOString(), moved }),
  ]);
  return moved;
}

async function eq<T = any>(sql: string, params: unknown[] = [], client?: Queryable): Promise<T[]> {
  await ensureEmailParts();
  const res = await (client ?? pool()).query(sql, params as any[]);
  return res.rows as T[];
}

// --- Parts ---------------------------------------------------------------------------

/** A part with what uses it: the compositions that name it, and (the kind's default) how many emails follow it. */
export type PartWithUse = EmailPart & {
  used_by: PartUsage[];
  /** The kind's default: the emails whose 'all' template names no part of this kind, so they use it. 0 otherwise. */
  default_for: number;
};

/** How many emails follow the default header, signature and footer (their 'all' row names none). */
async function defaultFollowers(): Promise<Record<EmailPartKind, number>> {
  const r = (
    await eq<{ header: number; signature: number; footer: number }>(
      `SELECT COUNT(*) FILTER (WHERE header_id IS NULL)::int AS header,
              COUNT(*) FILTER (WHERE signature_id IS NULL)::int AS signature,
              COUNT(*) FILTER (WHERE footer_id IS NULL)::int AS footer
         FROM email_template_compositions WHERE scope = 'all' AND event_key = ANY($1)`,
      [EMAIL_TEMPLATES.map((t) => t.key)]
    )
  )[0];
  return { header: r?.header ?? 0, body: 0, signature: r?.signature ?? 0, footer: r?.footer ?? 0 };
}

export async function listParts(filter: { kind?: EmailPartKind; event_key?: string } = {}): Promise<PartWithUse[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.kind) {
    params.push(filter.kind);
    where.push(`p.kind = $${params.length}`);
  }
  if (filter.event_key) {
    params.push(filter.event_key);
    where.push(`p.event_key = $${params.length}`);
  }
  const rows = await eq<PartRow>(
    `SELECT ${PART_COLS} FROM ${PART_FROM} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE p.kind WHEN 'header' THEN 0 WHEN 'body' THEN 1 WHEN 'signature' THEN 2 ELSE 3 END,
               p.event_key NULLS FIRST, (p.builtin_key IS NULL), p.name, p.id`,
    params
  );
  const [usage, followers] = await Promise.all([usageFor(rows.map((r) => r.id)), defaultFollowers()]);
  return rows.map((r) => ({
    ...toPart(r),
    used_by: usage.get(r.id) ?? [],
    default_for: r.is_default === 1 && r.kind !== "body" ? followers[r.kind as EmailPartKind] : 0,
  }));
}

export async function getPart(id: number): Promise<PartWithUse | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const r = (await eq<PartRow>(`SELECT ${PART_COLS} FROM ${PART_FROM} WHERE p.id = $1`, [id]))[0];
  if (!r) return null;
  const followers = r.is_default === 1 && r.kind !== "body" ? (await defaultFollowers())[r.kind as EmailPartKind] : 0;
  return { ...toPart(r), used_by: (await usageFor([id])).get(id) ?? [], default_for: followers };
}

/** The compositions that name each part explicitly (inheriting rows do not count). */
async function usageFor(ids: number[], client?: Queryable): Promise<Map<number, PartUsage[]>> {
  const out = new Map<number, PartUsage[]>();
  if (ids.length === 0) return out;
  const rows = await eq<{ part_id: number; event_key: string; scope: string; slot: EmailPartKind }>(
    `SELECT x.part_id, c.event_key, c.scope, x.slot
       FROM email_template_compositions c
       CROSS JOIN LATERAL (VALUES (c.header_id, 'header'), (c.body_id, 'body'), (c.signature_id, 'signature'), (c.footer_id, 'footer')) AS x(part_id, slot)
      WHERE x.part_id = ANY($1)
      ORDER BY c.event_key, c.scope`,
    [ids],
    client
  );
  for (const r of rows) {
    const list = out.get(r.part_id) ?? [];
    list.push({ event_key: r.event_key, event_label: templateDef(r.event_key)?.label ?? r.event_key, scope: r.scope, slot: r.slot });
    out.set(r.part_id, list);
  }
  return out;
}

export type PartError = { error: string; status: number; used_by?: PartUsage[] };

function cleanName(v: unknown): string {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, PART_NAME_MAX);
}

/** Validate a create/update payload. Answers the clean fields or the error to return. */
function validateFields(
  kind: EmailPartKind,
  input: { name?: unknown; subject?: unknown; content?: unknown },
  partial: boolean
): { name?: string; subject?: string; content?: string } | PartError {
  const out: { name?: string; subject?: string; content?: string } = {};
  if (input.name !== undefined || !partial) {
    const name = cleanName(input.name);
    if (!name) return { error: "Give the part a name.", status: 400 };
    if (String(input.name ?? "").trim().length > PART_NAME_MAX) return { error: `The name can be at most ${PART_NAME_MAX} characters.`, status: 400 };
    out.name = name;
  }
  if (input.subject !== undefined && kind === "body") {
    if (typeof input.subject !== "string") return { error: "The subject must be text.", status: 400 };
    const subject = input.subject.replace(/[\r\n]+/g, " ").trim();
    if (subject.length > PART_SUBJECT_MAX) return { error: `The subject can be at most ${PART_SUBJECT_MAX} characters.`, status: 400 };
    out.subject = subject;
  } else if (kind === "body" && !partial) {
    return { error: "A body needs a subject.", status: 400 };
  }
  if (input.content !== undefined || !partial) {
    if (input.content !== undefined && typeof input.content !== "string") return { error: "The content must be text.", status: 400 };
    const content = String(input.content ?? "").replace(/\r\n/g, "\n").trim();
    const max = kind === "body" ? PART_BODY_MAX : PART_CONTENT_MAX;
    if (content.length > max) return { error: `The content can be at most ${max.toLocaleString("en-US")} characters.`, status: 400 };
    out.content = content;
  }
  if (kind === "body") {
    if (out.subject !== undefined && !out.subject) return { error: "A body needs a subject.", status: 400 };
    if (out.content !== undefined && !out.content) return { error: "A body can't be empty.", status: 400 };
  }
  return out;
}

export async function createPart(
  input: { kind: unknown; name?: unknown; event_key?: unknown; subject?: unknown; content?: unknown },
  userId: number | null
): Promise<EmailPart | PartError> {
  if (!isPartKind(input.kind)) return { error: "Unknown part kind.", status: 400 };
  const kind = input.kind;
  let eventKey: string | null = null;
  if (kind === "body") {
    eventKey = String(input.event_key ?? "");
    if (!templateDef(eventKey)) return { error: "A body belongs to an email event: choose a known one.", status: 400 };
  }
  const fields = validateFields(kind, input, false);
  if ("error" in fields) return fields as PartError;
  const r = (
    await eq<{ id: number }>(
      `INSERT INTO email_template_parts (kind, name, event_key, subject, content, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [kind, fields.name, eventKey, kind === "body" ? fields.subject : "", fields.content ?? "", userId]
    )
  )[0];
  return (await getPart(r.id))!;
}

export async function updatePart(
  id: number,
  input: { name?: unknown; subject?: unknown; content?: unknown }
): Promise<EmailPart | PartError> {
  const cur = await getPart(id);
  if (!cur) return { error: "That part doesn't exist.", status: 404 };
  const fields = validateFields(cur.kind, input, true);
  if ("error" in fields) return fields as PartError;
  await eq(
    `UPDATE email_template_parts
        SET name = COALESCE($2, name), subject = COALESCE($3, subject), content = COALESCE($4, content), updated_at = now()
      WHERE id = $1`,
    [id, fields.name ?? null, fields.subject ?? null, fields.content ?? null]
  );
  return (await getPart(id))!;
}

/** Built-ins: back to what CompassDocs shipped (name, subject and content). */
export async function resetPart(id: number): Promise<EmailPart | PartError> {
  const cur = await getPart(id);
  if (!cur) return { error: "That part doesn't exist.", status: 404 };
  const original = builtinOriginal(cur.builtin_key);
  if (!original) return { error: "Only a built-in part can be reset to its original.", status: 400 };
  await eq(
    "UPDATE email_template_parts SET name = $2, subject = $3, content = $4, updated_at = now() WHERE id = $1",
    [id, original.name, original.subject, original.content]
  );
  return (await getPart(id))!;
}

/**
 * Delete a custom part. Refused for a built-in, for the kind's default and
 * while a composition names it (the answer lists them).
 */
export async function deletePart(id: number): Promise<{ ok: true; part: EmailPart } | PartError> {
  await ensureEmailParts();
  return withAdvisoryLock("email_template_parts:write", async (c) => {
    const r = (await c.query<PartRow>(`SELECT ${PART_COLS} FROM ${PART_FROM} WHERE p.id = $1 FOR UPDATE OF p`, [id])).rows[0];
    if (!r) return { error: "That part doesn't exist.", status: 404 };
    const part = toPart(r);
    if (part.builtin) return { error: "A built-in part can't be deleted. Reset it to its original instead.", status: 409 };
    if (part.is_default) return { error: `This is the default ${part.kind}. Make another one the default first.`, status: 409 };
    const used = (await usageFor([id], c)).get(id) ?? [];
    if (used.length > 0) {
      return { error: `This ${part.kind} is used by ${used.length === 1 ? "an email" : `${used.length} emails`}. Choose another for them first.`, status: 409, used_by: used };
    }
    await c.query("DELETE FROM email_template_parts WHERE id = $1", [id]);
    return { ok: true as const, part };
  });
}

/** Make a header, signature or footer the default of its kind. */
export async function setDefaultPart(id: number): Promise<{ part: EmailPart; previous: EmailPart | null; changed: boolean } | PartError> {
  await ensureEmailParts();
  return withAdvisoryLock("email_template_parts:write", async (c) => {
    const r = (await c.query<PartRow>(`SELECT ${PART_COLS} FROM ${PART_FROM} WHERE p.id = $1`, [id])).rows[0];
    if (!r) return { error: "That part doesn't exist.", status: 404 };
    if (r.kind === "body") return { error: "A body belongs to its event; choose it in the event's template instead.", status: 400 };
    const prev = (await c.query<PartRow>(`SELECT ${PART_COLS} FROM ${PART_FROM} WHERE p.kind = $1 AND p.is_default = 1`, [r.kind])).rows[0];
    await c.query("UPDATE email_template_parts SET is_default = 0 WHERE kind = $1 AND is_default = 1 AND id <> $2", [r.kind, id]);
    await c.query("UPDATE email_template_parts SET is_default = 1 WHERE id = $1", [id]);
    const now = (await c.query<PartRow>(`SELECT ${PART_COLS} FROM ${PART_FROM} WHERE p.id = $1`, [id])).rows[0];
    return { part: toPart(now), previous: prev && prev.id !== id ? toPart(prev) : null, changed: r.is_default !== 1 };
  });
}

// --- Compositions ----------------------------------------------------------------------

export interface CompositionSlot {
  /** The part this row names; null inherits. */
  id: number | null;
  /** The part the mail actually uses (null: none, e.g. no default left). */
  effective_id: number | null;
  effective_name: string;
  /** Where the effective part comes from. */
  source: "chosen" | "all" | "default" | "builtin";
}

export interface EmailComposition {
  event_key: string;
  event_label: string;
  scope: string;
  /** A stored row exists for (event, scope); false: everything inherits. */
  stored: boolean;
  header: CompositionSlot;
  body: CompositionSlot;
  signature: CompositionSlot;
  footer: CompositionSlot;
  updated_by: number | null;
  updated_by_name: string | null;
  updated_at: string | null;
}

interface CompRow {
  event_key: string;
  scope: string;
  header_id: number | null;
  body_id: number | null;
  signature_id: number | null;
  footer_id: number | null;
  updated_by: number | null;
  updated_by_name: string | null;
  updated_at: string;
}

const SLOT_COL: Record<EmailPartKind, "header_id" | "body_id" | "signature_id" | "footer_id"> = {
  header: "header_id",
  body: "body_id",
  signature: "signature_id",
  footer: "footer_id",
};

async function compRows(eventKeys: string[] | null, scopes: string[] | null): Promise<CompRow[]> {
  return eq<CompRow>(
    `SELECT c.event_key, c.scope, c.header_id, c.body_id, c.signature_id, c.footer_id, c.updated_by, u.name AS updated_by_name, c.updated_at
       FROM email_template_compositions c LEFT JOIN users u ON u.id = c.updated_by
      WHERE ($1::text[] IS NULL OR c.event_key = ANY($1)) AND ($2::text[] IS NULL OR c.scope = ANY($2))
      ORDER BY c.event_key, (c.scope <> 'all'), c.scope`,
    [eventKeys, scopes]
  );
}

interface PartLite {
  id: number;
  kind: EmailPartKind;
  name: string;
  event_key: string | null;
  subject: string;
  content: string;
  builtin_key: string | null;
  is_default: number;
}

async function partsLite(ids: number[], eventKeys: string[]): Promise<PartLite[]> {
  return eq<PartLite>(
    `SELECT id, kind, name, event_key, subject, content, builtin_key, is_default FROM email_template_parts
      WHERE id = ANY($1) OR (is_default = 1 AND kind <> 'body') OR builtin_key = ANY($2)`,
    [ids, eventKeys.map(bodyBuiltinKey)]
  );
}

function effective(
  kind: EmailPartKind,
  eventKey: string,
  own: CompRow | undefined,
  all: CompRow | undefined,
  scope: string,
  parts: Map<number, PartLite>,
  defaults: Map<EmailPartKind, PartLite>,
  builtinBody: PartLite | undefined
): { slot: CompositionSlot; part: PartLite | null } {
  const col = SLOT_COL[kind];
  const ownId = own?.[col] ?? null;
  const pick = (id: number | null) => (id != null ? parts.get(id) ?? null : null);
  const valid = (p: PartLite | null) => !!p && p.kind === kind && (kind !== "body" || p.event_key === eventKey);
  let part: PartLite | null = null;
  let source: CompositionSlot["source"] = "default";
  if (valid(pick(ownId))) {
    part = pick(ownId);
    source = "chosen";
  } else if (scope !== SCOPE_ALL && valid(pick(all?.[col] ?? null))) {
    part = pick(all![col]);
    source = "all";
  } else if (kind === "body") {
    part = builtinBody ?? null;
    source = "builtin";
  } else {
    part = defaults.get(kind) ?? null;
    source = "default";
  }
  return {
    slot: { id: ownId, effective_id: part?.id ?? null, effective_name: part?.name ?? "", source },
    part,
  };
}

function compose(
  eventKey: string,
  scope: string,
  rows: CompRow[],
  parts: Map<number, PartLite>,
  defaults: Map<EmailPartKind, PartLite>,
  builtinBodies: Map<string, PartLite>
): { view: EmailComposition; resolved: Record<EmailPartKind, PartLite | null> } {
  const own = rows.find((r) => r.event_key === eventKey && r.scope === scope);
  const all = rows.find((r) => r.event_key === eventKey && r.scope === SCOPE_ALL);
  const slots = {} as Record<EmailPartKind, CompositionSlot>;
  const resolved = {} as Record<EmailPartKind, PartLite | null>;
  for (const kind of PART_KINDS) {
    const e = effective(kind, eventKey, own, all, scope, parts, defaults, builtinBodies.get(eventKey));
    slots[kind] = e.slot;
    resolved[kind] = e.part;
  }
  return {
    view: {
      event_key: eventKey,
      event_label: templateDef(eventKey)?.label ?? eventKey,
      scope,
      stored: !!own,
      ...slots,
      updated_by: own?.updated_by ?? null,
      updated_by_name: own?.updated_by_name ?? null,
      updated_at: own?.updated_at ?? null,
    },
    resolved,
  };
}

async function load(eventKeys: string[], scopes: string[]) {
  const rows = await compRows(eventKeys, scopes);
  const ids = rows.flatMap((r) => [r.header_id, r.body_id, r.signature_id, r.footer_id]).filter((x): x is number => x != null);
  const lite = await partsLite(ids, eventKeys);
  const parts = new Map(lite.map((p) => [p.id, p]));
  const defaults = new Map<EmailPartKind, PartLite>();
  const builtinBodies = new Map<string, PartLite>();
  for (const p of lite) {
    if (p.is_default === 1 && p.kind !== "body") defaults.set(p.kind, p);
    if (p.builtin_key?.startsWith("body:") && p.event_key) builtinBodies.set(p.event_key, p);
  }
  return { rows, parts, defaults, builtinBodies };
}

/**
 * Every event's composition for `scope` ('all' by default): one entry per
 * EMAIL_TEMPLATES event, in their order. For a team scope, `stored` tells
 * whether the team has a variant (otherwise every slot inherits 'all').
 */
export async function listCompositions(scope: string = SCOPE_ALL, eventKeys?: string[]): Promise<EmailComposition[]> {
  const events = eventKeys ?? EMAIL_TEMPLATES.map((t) => t.key);
  const scopes = scope === SCOPE_ALL ? [SCOPE_ALL] : [scope, SCOPE_ALL];
  const { rows, parts, defaults, builtinBodies } = await load(events, scopes);
  return events.map((k) => compose(k, scope, rows, parts, defaults, builtinBodies).view);
}

/** The team variants that exist: [{event_key, scope}] for every stored team-scope row. */
export async function listTeamVariants(): Promise<{ event_key: string; scope: string; team_id: number }[]> {
  const rows = await eq<{ event_key: string; scope: string }>(
    "SELECT event_key, scope FROM email_template_compositions WHERE scope <> 'all' ORDER BY scope, event_key"
  );
  return rows.map((r) => ({ ...r, team_id: teamIdOfScope(r.scope) ?? 0 }));
}

export async function getComposition(eventKey: string, scope: string = SCOPE_ALL): Promise<EmailComposition | null> {
  if (!templateDef(eventKey) || !isScope(scope)) return null;
  return (await listCompositions(scope, [eventKey]))[0];
}

export interface ResolvedPart {
  id: number;
  name: string;
  subject: string;
  content: string;
}
export interface ResolvedComposition {
  header: ResolvedPart | null;
  body: ResolvedPart | null;
  signature: ResolvedPart | null;
  footer: ResolvedPart | null;
}

/**
 * The four parts an email of `eventKey` is built from for `scope` (a team
 * scope falls back to 'all' slot by slot). A body that is missing (an event
 * added since the seed ran in this process) is seeded on the spot.
 */
export async function resolveComposition(eventKey: string, scope?: string | null): Promise<ResolvedComposition> {
  const sc = scope && isScope(scope) ? scope : SCOPE_ALL;
  const scopes = sc === SCOPE_ALL ? [SCOPE_ALL] : [sc, SCOPE_ALL];
  let loaded = await load([eventKey], scopes);
  if (!loaded.builtinBodies.has(eventKey) && templateDef(eventKey)) {
    await seedEmailParts([eventKey]);
    loaded = await load([eventKey], scopes);
  }
  const { resolved } = compose(eventKey, sc, loaded.rows, loaded.parts, loaded.defaults, loaded.builtinBodies);
  const lite = (p: PartLite | null): ResolvedPart | null => (p ? { id: p.id, name: p.name, subject: p.subject, content: p.content } : null);
  return { header: lite(resolved.header), body: lite(resolved.body), signature: lite(resolved.signature), footer: lite(resolved.footer) };
}

/** The parts by id, for a preview of an unsaved combination. */
export async function partsById(ids: number[]): Promise<Map<number, PartLite>> {
  if (ids.length === 0) return new Map();
  const rows = await eq<PartLite>(
    "SELECT id, kind, name, event_key, subject, content, builtin_key, is_default FROM email_template_parts WHERE id = ANY($1)",
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

export interface CompositionInput {
  header_id?: unknown;
  body_id?: unknown;
  signature_id?: unknown;
  footer_id?: unknown;
}

/**
 * Save (event, scope)'s choices. A slot left out keeps its stored value; a
 * null inherits. Each id must be a part of the slot's kind (a body: one of
 * this event's). Answers the composition before and after (for the audit).
 */
export async function putComposition(
  eventKey: string,
  scope: string,
  input: CompositionInput,
  userId: number | null
): Promise<{ before: EmailComposition; after: EmailComposition } | PartError> {
  if (!templateDef(eventKey)) return { error: "Unknown email event.", status: 404 };
  if (!isScope(scope)) return { error: "Unknown scope: use 'all' or 'hd_team:<id>'.", status: 400 };
  const teamId = teamIdOfScope(scope);
  if (teamId != null) {
    if (!isHelpdeskEvent(eventKey)) return { error: "Team variants are for helpdesk emails only.", status: 400 };
    const team = await eq<{ ok: number }>(
      "SELECT 1 AS ok WHERE to_regclass('hd_teams') IS NOT NULL AND EXISTS (SELECT 1 FROM hd_teams WHERE id = $1)",
      [teamId]
    ).catch(() => []);
    if (team.length === 0) return { error: "That helpdesk team doesn't exist.", status: 404 };
  }
  const ids: Partial<Record<EmailPartKind, number | null>> = {};
  for (const kind of PART_KINDS) {
    const v = input[SLOT_COL[kind]];
    if (v === undefined) continue;
    if (v === null || v === "") {
      ids[kind] = null;
      continue;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return { error: `The ${kind} must be a part id or null.`, status: 400 };
    ids[kind] = n;
  }
  const chosen = Object.values(ids).filter((x): x is number => x != null);
  const found = await partsById(chosen);
  for (const kind of PART_KINDS) {
    const id = ids[kind];
    if (id == null) continue;
    const p = found.get(id);
    if (!p || p.kind !== kind) return { error: `Part ${id} is not a ${kind}.`, status: 400 };
    if (kind === "body" && p.event_key !== eventKey) return { error: "That body belongs to another email event.", status: 400 };
  }
  const before = (await getComposition(eventKey, scope))!;
  const cur = before.stored
    ? { header: before.header.id, body: before.body.id, signature: before.signature.id, footer: before.footer.id }
    : { header: null, body: null, signature: null, footer: null };
  const next = { ...cur, ...ids };
  await eq(
    `INSERT INTO email_template_compositions (event_key, scope, header_id, body_id, signature_id, footer_id, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (event_key, scope) DO UPDATE SET header_id = EXCLUDED.header_id, body_id = EXCLUDED.body_id,
       signature_id = EXCLUDED.signature_id, footer_id = EXCLUDED.footer_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [eventKey, scope, next.header, next.body, next.signature, next.footer, userId]
  );
  return { before, after: (await getComposition(eventKey, scope))! };
}

/** Remove a team's variant of an event (it inherits 'all' again). The 'all' row stays. */
export async function deleteComposition(eventKey: string, scope: string): Promise<{ ok: boolean } | PartError> {
  if (!templateDef(eventKey)) return { error: "Unknown email event.", status: 404 };
  if (!isScope(scope) || scope === SCOPE_ALL) return { error: "Only a team variant can be removed.", status: 400 };
  const r = await eq("DELETE FROM email_template_compositions WHERE event_key = $1 AND scope = $2 RETURNING id", [eventKey, scope]);
  return { ok: r.length > 0 };
}

// --- The old single-template API (compat) ----------------------------------------------

/** The event's built-in body, or null before the seed (never, after ensureEmailParts). */
export async function builtinBody(eventKey: string): Promise<EmailPart | null> {
  const r = (await eq<PartRow>(`SELECT ${PART_COLS} FROM ${PART_FROM} WHERE p.builtin_key = $1`, [bodyBuiltinKey(eventKey)]))[0];
  return r ? toPart(r) : null;
}

/** Write the event's built-in body (the old saveTemplateOverride / resetTemplate). */
export async function writeBuiltinBody(eventKey: string, subject: string, content: string): Promise<void> {
  await seedEmailParts([eventKey]);
  await eq(
    "UPDATE email_template_parts SET subject = $2, content = $3, updated_at = now() WHERE builtin_key = $1",
    [bodyBuiltinKey(eventKey), subject, content]
  );
}

/** {{sender_name}} and {{sender_title}} for a user: their name and visible directory title. */
export async function senderDetails(userId: number): Promise<{ name: string; title: string } | null> {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const r = (
    await eq<{ name: string; title: string }>(
      `SELECT COALESCE(NULLIF(u.name, ''), u.username) AS name, COALESCE(dp.title, '') AS title
         FROM users u LEFT JOIN directory_people dp ON dp.id = u.directory_person_id AND dp.hidden = 0
        WHERE u.id = $1`,
      [userId]
    )
  )[0];
  return r ?? null;
}

/**
 * {{recipient_name}} for a recipient: an active account by id, or by
 * address (case-insensitive). Null when the address is no active account's
 * (an outside requester): renderEmail then leaves out the "Manage your
 * notifications" link.
 */
export async function recipientDetails(who: { userId?: number | null; email?: string | null }): Promise<{ id: number; name: string } | null> {
  const id = who.userId != null && Number.isInteger(who.userId) && who.userId > 0 ? who.userId : null;
  const email = (who.email ?? "").trim();
  if (id == null && !email) return null;
  const r = (
    await eq<{ id: number; name: string }>(
      `SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM users
        WHERE status = 'active' AND ${id != null ? "id = $1" : "lower(email) = lower($1) AND email <> ''"}
        ORDER BY id LIMIT 1`,
      [id ?? email]
    )
  )[0];
  return r ?? null;
}

// --- Preview ---------------------------------------------------------------------------

/** An unsaved edit of one slot in a preview: its text replaces the chosen part's. */
export interface PreviewDraft {
  subject?: unknown;
  content?: unknown;
}

export interface PreviewInput extends CompositionInput {
  /** The email event (`event` is accepted as well). */
  event_key?: unknown;
  event?: unknown;
  scope?: unknown;
  /** Unsaved text per slot (the editor's live preview). */
  drafts?: Partial<Record<EmailPartKind, PreviewDraft | null>>;
  /** One unsaved part, the one being edited: {kind, subject?, content?}. Wins over `drafts` for its kind. */
  draft?: (PreviewDraft & { kind?: unknown }) | null;
  /** Extra sample values (strings only) over the event's SAMPLE_VARS. */
  vars?: unknown;
}

/**
 * Render any combination for an event with its sample values: the slots
 * the input names (ids, as putComposition takes them; null inherits), the
 * rest as the (event, scope) composition stands, and any unsaved drafts on
 * top. Answers subject, html and text.
 */
export async function previewComposition(
  input: PreviewInput,
  origin: string
): Promise<{ subject: string; html: string; text: string; parts: Record<EmailPartKind, { id: number | null; name: string }> } | PartError> {
  const eventKey = String(input.event_key ?? input.event ?? "");
  const def = templateDef(eventKey);
  if (!def) return { error: "Unknown email event.", status: 404 };
  const drafts: Partial<Record<EmailPartKind, PreviewDraft | null>> = {};
  if (input.drafts && typeof input.drafts === "object") {
    for (const kind of PART_KINDS) {
      const d = (input.drafts as Record<string, unknown>)[kind];
      if (d && typeof d === "object") drafts[kind] = d as PreviewDraft;
    }
  }
  if (input.draft && typeof input.draft === "object") {
    if (!isPartKind(input.draft.kind)) return { error: "The draft needs a kind: header, body, signature or footer.", status: 400 };
    drafts[input.draft.kind] = input.draft;
  }
  const scope = input.scope === undefined || input.scope === null || input.scope === "" ? SCOPE_ALL : input.scope;
  if (!isScope(scope)) return { error: "Unknown scope: use 'all' or 'hd_team:<id>'.", status: 400 };
  const scopes = scope === SCOPE_ALL ? [SCOPE_ALL] : [scope, SCOPE_ALL];
  const loaded = await load([eventKey], scopes);
  // The row as it would be saved with the input's slots.
  const own = loaded.rows.find((r) => r.scope === scope);
  const row: CompRow = own
    ? { ...own }
    : { event_key: eventKey, scope, header_id: null, body_id: null, signature_id: null, footer_id: null, updated_by: null, updated_by_name: null, updated_at: "" };
  const wanted: number[] = [];
  for (const kind of PART_KINDS) {
    const v = input[SLOT_COL[kind]];
    if (v === undefined) continue;
    if (v === null || v === "") {
      row[SLOT_COL[kind]] = null;
      continue;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return { error: `The ${kind} must be a part id or null.`, status: 400 };
    row[SLOT_COL[kind]] = n;
    wanted.push(n);
  }
  const extra = await partsById(wanted.filter((id) => !loaded.parts.has(id)));
  for (const [id, p] of extra) loaded.parts.set(id, p);
  for (const kind of PART_KINDS) {
    const id = row[SLOT_COL[kind]];
    if (id == null || input[SLOT_COL[kind]] === undefined) continue;
    const p = loaded.parts.get(id);
    if (!p || p.kind !== kind) return { error: `Part ${id} is not a ${kind}.`, status: 400 };
    if (kind === "body" && p.event_key !== eventKey) return { error: "That body belongs to another email event.", status: 400 };
  }
  const rows = [...loaded.rows.filter((r) => r.scope !== scope), row];
  const { resolved } = compose(eventKey, scope, rows, loaded.parts, loaded.defaults, loaded.builtinBodies);

  const text = (kind: EmailPartKind, field: "subject" | "content", fallback: string): string => {
    const d = drafts[kind];
    const v = d ? d[field] : undefined;
    if (typeof v === "string") return v.slice(0, kind === "body" ? (field === "subject" ? PART_SUBJECT_MAX : PART_BODY_MAX) : PART_CONTENT_MAX);
    return fallback;
  };
  const b = resolved.body;
  const parts = {
    header: text("header", "content", resolved.header?.content ?? ""),
    subject: text("body", "subject", b?.subject || def.subject),
    body: text("body", "content", b?.content || def.body),
    signature: text("signature", "content", resolved.signature?.content ?? ""),
    footer: text("footer", "content", resolved.footer?.content ?? ""),
  };
  const extraVars: Record<string, string> = {};
  if (input.vars && typeof input.vars === "object" && !Array.isArray(input.vars)) {
    for (const [k, v] of Object.entries(input.vars as Record<string, unknown>).slice(0, 50)) {
      if (/^\w{1,64}$/.test(k) && typeof v === "string") extraVars[k] = v.slice(0, 2_000);
    }
  }
  // A team's version previews with the team's own name in {{team_name}}.
  const teamId = teamIdOfScope(scope);
  const teamName =
    teamId != null
      ? (await eq<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [teamId]).catch(() => []))[0]?.name
      : undefined;
  const vars = { ...SAMPLE_FRAME_VARS, ...(SAMPLE_VARS[eventKey] ?? {}), ...(teamName ? { team_name: teamName } : {}), ...extraVars };
  const out = await renderComposedEmail(eventKey, parts, vars, origin);
  const named = (p: PartLite | null) => ({ id: p?.id ?? null, name: p?.name ?? "" });
  return {
    ...out,
    parts: { header: named(resolved.header), body: named(resolved.body), signature: named(resolved.signature), footer: named(resolved.footer) },
  };
}
