// Helpdesk 1.19.1: retention and privacy (agent V5, mock-up #6). Settings
// and shapes in ./retention-shared; schema in ./retention-schema.
//
//   Both rules below are OFF by default (owner decision, 1.19.1: nothing
//   destructive on upgrade); auto_close_enabled and retention_enabled turn
//   them on. A rule that is off is neither previewed nor run.
//   Auto-close   solved tickets with no reply for auto_close_days close
//                (status closed, a timeline line). A reply after that
//                starts a new request (email: a follow-up ticket).
//   Retention    closed tickets older than keep_amount keep_unit are
//                anonymised (default) or deleted. Anonymise keeps the row
//                and what reports count (status, priority, team, type,
//                tags, channel, every timestamp and SLA field, message
//                rows with their kind, author for agents and time) and
//                removes the rest: the subject, the requester's and CCs'
//                names and emails ("Former requester"; every author on
//                the requester's side, not only the current requester and
//                CCs), every message's text, the form answers, the survey
//                comment, notes and hand-offs on its workflow, drafts,
//                time-entry notes, CC rows and every file (rows and bytes
//                in the uploads volume), the ticket's bell notifications
//                (title "#N Anonymised request") and the subject, names and
//                emails in its audit rows (action, actor, time and ids
//                stay), and an outside portal contact left with no ticket
//                (its sessions and sign-in links go with it; a blocked one
//                keeps only its address). The timeline lines the reports
//                read (status changes, "took the ticket", "assigned the
//                ticket to") keep their text, with requester-side names
//                replaced, so past Reopened counts and pick-up times stay.
//                Content added to an anonymised ticket later (messages,
//                files, CCs, drafts, time notes) is anonymised again.
//                Delete removes the ticket (its rows cascade) and its
//                files. Open tickets are never touched; neither is a
//                ticket on legal hold (hd_tickets.legal_hold), whatever
//                the settings say.
//   Account removal   (lib/db deleteUser, in the same transaction as the
//                account delete, so a failed removal changes nothing; the
//                files go after the commit) the person's tickets as
//                requester are anonymised whole (agents' replies keep the
//                agents' names); elsewhere, their own messages on the
//                requester's side and their files are, whether or not they
//                are still copied in, and their CC rows go. Legal hold
//                applies here too: on a held ticket their CC row stays,
//                as a name and address, after the account goes.
//   Data export  personalHelpdeskExport: the person's requests (by account
//                or by their address), each with its public conversation,
//                including what a merge moved onto another ticket; and on
//                requests they were copied on or replied to, their own
//                public messages. Never internal notes or replies held for
//                review.
//
// The nightly sweep (lib/periodic HELPDESK_SWEEPS "hd_retention") runs once
// per local day after 02:00 in the helpdesk's time zone (a settings claim),
// in batches of 200, each batch a transaction under RETENTION_LOCK
// (try-lock: a second instance stops rather than waits). The preview
// (planRetention) and the run (runRetention) select with the same SQL, so a
// dry run lists exactly what a run at that moment would do. Audit, once per
// run with counts: helpdesk.ticket.auto_closed, helpdesk.ticket.anonymised,
// helpdesk.ticket.deleted_by_retention.
//
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { claimPeriod, getSetting, setSetting } from "../db";
import { audit } from "../audit";
import type { AuditActor } from "../audit";
import { logEvent } from "../log";
import { deleteUpload } from "../uploads";
import { hq, hqOne, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import { answerText } from "./request-types";
import { HD_STATUS_LABEL_REQUESTER } from "./types";
import type { HdFormField, HdStatus } from "./types";
import {
  HD_FORMER_REQUESTER,
  HD_RETENTION_KEY,
  autoCloseCutoff,
  normalizeRetention,
  retentionCutoff,
} from "./retention-shared";
import type { HdRetentionItem, HdRetentionPlan, HdRetentionSettings } from "./retention-shared";

/** pg advisory lock key for retention batches (calendars use 7_281_917). */
export const RETENTION_LOCK = 7_281_931;
const BATCH = 200;
/** The local hour the nightly run starts at (or after). */
export const RETENTION_RUN_HOUR = 2;
const ANONYMISED_SUBJECT = "Anonymised request";

// --- Settings ---------------------------------------------------------------------

export async function getRetentionSettings(): Promise<HdRetentionSettings> {
  const raw = await getSetting(HD_RETENTION_KEY);
  try {
    return normalizeRetention(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeRetention(null);
  }
}

/** Merge a checked patch (retentionPatchError first) and save; returns the saved value and the changed keys. */
export async function saveRetentionSettings(patch: Partial<HdRetentionSettings>): Promise<{ settings: HdRetentionSettings; changed: (keyof HdRetentionSettings)[] }> {
  const before = await getRetentionSettings();
  const next = normalizeRetention({ ...before, ...patch });
  const changed = (Object.keys(next) as (keyof HdRetentionSettings)[]).filter((k) => next[k] !== before[k]);
  if (changed.length) await setSetting(HD_RETENTION_KEY, JSON.stringify(next));
  return { settings: next, changed };
}

// --- What a run would touch (one SQL for the preview and the run) ------------------

/** Solved, not on hold, solved before the cutoff. $1 cutoff, $2 only (int[] | null). */
const CLOSE_WHERE = `status = 'solved' AND legal_hold = 0 AND solved_at IS NOT NULL AND solved_at <= $1
  AND ($2::int[] IS NULL OR id = ANY($2::int[]))`;

/**
 * Still to anonymise (unqualified columns of hd_tickets, or of `a`): never
 * anonymised, or content added since (a message other than the timeline
 * lines the reports read, a file, a CC, a draft, a time note).
 */
export function needsAnonymisingSql(a = "hd_tickets"): string {
  return `(${a}.anonymised_at IS NULL OR EXISTS (
    SELECT 1 FROM hd_messages nm WHERE nm.ticket_id = ${a}.id AND nm.created_at > ${a}.anonymised_at AND nm.body <> ''
       AND NOT (nm.via = 'system' AND (${REPORT_LINE_SQL("nm")}))
    UNION ALL SELECT 1 FROM hd_attachments na WHERE na.ticket_id = ${a}.id
    UNION ALL SELECT 1 FROM hd_ticket_ccs nc WHERE nc.ticket_id = ${a}.id
    UNION ALL SELECT 1 FROM hd_reply_drafts nd WHERE nd.ticket_id = ${a}.id
    UNION ALL SELECT 1 FROM hd_time_entries nt WHERE nt.ticket_id = ${a}.id AND nt.note <> ''))`;
}

/** The timeline lines the analytics read (lib/helpdesk/analytics/engine REOPEN_LINE, PICKUP_AT). */
const REPORT_LINE_SQL = (m: string) =>
  `${m}.body LIKE '% changed the status from % to %' OR ${m}.body LIKE '% took the ticket' OR ${m}.body LIKE '% assigned the ticket to %'`;

/** Closed, not on hold, closed before the cutoff; anonymise skips what is already anonymised (unless added to since). */
function purgeWhere(action: HdRetentionSettings["action"]): string {
  return `status = 'closed' AND legal_hold = 0 AND coalesce(closed_at, solved_at, updated_at) <= $1
  ${action === "anonymise" ? `AND ${needsAnonymisingSql()}` : ""}
  AND ($2::int[] IS NULL OR id = ANY($2::int[]))`;
}

/** Same as the two above but ON hold: what the rules that are on would touch and the hold keeps. */
function heldWhere(s: Pick<HdRetentionSettings, "action" | "auto_close_enabled" | "retention_enabled">): string {
  // A rule that is off still names its parameter (so its type is known) behind a constant false.
  const close = `(${s.auto_close_enabled ? "true" : "false"} AND status = 'solved' AND solved_at IS NOT NULL AND solved_at <= $1)`;
  const purge = `(${s.retention_enabled ? "true" : "false"} AND status = 'closed' AND coalesce(closed_at, solved_at, updated_at) <= $2 ${s.action === "anonymise" ? `AND ${needsAnonymisingSql()}` : ""})`;
  return `legal_hold = 1 AND ($3::int[] IS NULL OR id = ANY($3::int[])) AND (${close} OR ${purge})`;
}

const NONE = Promise.resolve({ n: 0 });

/** When the next nightly run is: today's RETENTION_RUN_HOUR in `tz`, or tomorrow's once that has passed. */
export function nextRunAt(now: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const hour = get("hour") % 24;
  const [y, m, d] = [get("year"), get("month"), get("day")];
  const dayOffset = hour >= RETENTION_RUN_HOUR ? 1 : 0;
  // The zone's offset at that wall time, found by comparing a guess with its own wall clock.
  const guess = Date.UTC(y, m - 1, d + dayOffset, RETENTION_RUN_HOUR, 0);
  const wall = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(guess));
  const w = (t: string) => Number(wall.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(w("year"), w("month") - 1, w("day"), w("hour") % 24, w("minute"));
  return new Date(guess - (asUtc - guess));
}

async function helpdeskZone(): Promise<string> {
  const { getHelpdeskSettings } = await import("./settings");
  return (await getHelpdeskSettings()).timezone;
}

/**
 * The dry run: what a run at `at` (default: the next nightly run) would do,
 * with the first `listLimit` tickets of each kind. `only` limits it to
 * those ticket ids (tests); `withIds` adds every id it would touch.
 */
export async function planRetention(
  opts: { at?: Date; settings?: HdRetentionSettings; only?: number[] | null; listLimit?: number; withIds?: boolean } = {}
): Promise<HdRetentionPlan & { ids?: { close: number[]; purge: number[] } }> {
  const s = opts.settings ?? (await getRetentionSettings());
  const at = opts.at ?? nextRunAt(new Date(), await helpdeskZone());
  const closeBefore = autoCloseCutoff(s, at);
  const purgeBefore = retentionCutoff(s, at);
  const only = opts.only ?? null;
  const limit = Math.max(0, Math.min(500, opts.listLimit ?? 50));
  const closeOn = s.auto_close_enabled;
  const purgeOn = s.retention_enabled;
  const [closeCount, purgeCount, held, closeItems, purgeItems] = await Promise.all([
    closeOn ? hqOne<{ n: number }>(`SELECT count(*)::int AS n FROM hd_tickets WHERE ${CLOSE_WHERE}`, [closeBefore, only]) : NONE,
    purgeOn ? hqOne<{ n: number }>(`SELECT count(*)::int AS n FROM hd_tickets WHERE ${purgeWhere(s.action)}`, [purgeBefore, only]) : NONE,
    closeOn || purgeOn ? hqOne<{ n: number }>(`SELECT count(*)::int AS n FROM hd_tickets WHERE ${heldWhere(s)}`, [closeBefore, purgeBefore, only]) : NONE,
    !closeOn ? Promise.resolve([]) : hq<Omit<HdRetentionItem, "what">>(
      `SELECT t.id, t.number, t.subject, tm.name AS team_name, t.solved_at AS since
         FROM hd_tickets t LEFT JOIN hd_teams tm ON tm.id = t.team_id
        WHERE t.id IN (SELECT id FROM hd_tickets WHERE ${CLOSE_WHERE}) ORDER BY t.solved_at, t.id LIMIT $3`,
      [closeBefore, only, limit]
    ),
    !purgeOn ? Promise.resolve([]) : hq<Omit<HdRetentionItem, "what">>(
      `SELECT t.id, t.number, t.subject, tm.name AS team_name, coalesce(t.closed_at, t.solved_at, t.updated_at) AS since
         FROM hd_tickets t LEFT JOIN hd_teams tm ON tm.id = t.team_id
        WHERE t.id IN (SELECT id FROM hd_tickets WHERE ${purgeWhere(s.action)}) ORDER BY since, t.id LIMIT $3`,
      [purgeBefore, only, limit]
    ),
  ]);
  const plan: HdRetentionPlan & { ids?: { close: number[]; purge: number[] } } = {
    enabled: { close: closeOn, purge: purgeOn },
    run_at: at.toISOString(),
    close_before: closeBefore.toISOString(),
    purge_before: purgeBefore.toISOString(),
    action: s.action,
    counts: {
      close: closeCount?.n ?? 0,
      anonymise: s.action === "anonymise" ? purgeCount?.n ?? 0 : 0,
      delete: s.action === "delete" ? purgeCount?.n ?? 0 : 0,
      held: held?.n ?? 0,
    },
    items: [
      ...closeItems.map((r) => ({ ...r, what: "close" as const })),
      ...purgeItems.map((r) => ({ ...r, what: s.action })),
    ],
  };
  if (opts.withIds) {
    const [c, p] = await Promise.all([
      closeOn ? hq<{ id: number }>(`SELECT id FROM hd_tickets WHERE ${CLOSE_WHERE} ORDER BY id`, [closeBefore, only]) : Promise.resolve([]),
      purgeOn ? hq<{ id: number }>(`SELECT id FROM hd_tickets WHERE ${purgeWhere(s.action)} ORDER BY id`, [purgeBefore, only]) : Promise.resolve([]),
    ]);
    plan.ids = { close: c.map((r) => r.id), purge: p.map((r) => r.id) };
  }
  return plan;
}

// --- Optional tables (other 1.19.1 features; read once per process) ---------------

let optionalTables: Promise<Set<string>> | null = null;
function optional(client: HdQueryable): Promise<Set<string>> {
  if (!optionalTables) {
    optionalTables = (async () => {
      const r = await client.query<{ name: string }>(
        `SELECT n AS name FROM unnest($1::text[]) n WHERE to_regclass(n) IS NOT NULL
         UNION ALL
         SELECT 'hd_tickets.portal_contact_id' WHERE EXISTS (
           SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('hd_tickets') AND attname = 'portal_contact_id' AND NOT attisdropped)`,
        [["hd_ticket_ccs", "hd_reply_drafts", "hd_time_entries", "hd_ticket_presence"]]
      );
      return new Set(r.rows.map((x) => x.name));
    })().catch((e) => {
      optionalTables = null;
      throw e;
    });
  }
  return optionalTables;
}

// --- One ticket ---------------------------------------------------------------------

/**
 * Messages written on the requester's side (unqualified hd_messages
 * columns): Get help and the customer portal, a requester's reply through
 * the Claude connector (agents' connector tools write notes and drafts
 * only), and inbound email from anyone who is not an agent.
 */
const REQUESTER_SIDE_SQL = `(hd_messages.via IN ('portal', 'customer_portal')
  OR (hd_messages.via = 'mcp' AND hd_messages.kind = 'public')
  OR (hd_messages.via = 'email' AND (hd_messages.author_id IS NULL OR (
        NOT EXISTS (SELECT 1 FROM hd_team_members tm WHERE tm.user_id = hd_messages.author_id)
        AND NOT EXISTS (SELECT 1 FROM hd_agent_roles ar WHERE ar.user_id = hd_messages.author_id)))))`;

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Keys whose text is the ticket's content (subject, bodies, addresses) in audit details. */
const AUDIT_TEXT_KEYS = new Set(["subject", "title", "body", "text", "note", "comment", "email", "requester_email", "requester_name", "to", "cc", "from"]);

/** An audit row's details with the ticket's personal text taken out (ids, counts and actions stay). */
export function redactAuditDetails(v: unknown, names: Set<string>, key = ""): unknown {
  if (typeof v === "string") {
    if (AUDIT_TEXT_KEYS.has(key)) return "";
    if (EMAIL_LIKE.test(v.trim())) return "";
    return names.has(v) ? HD_FORMER_REQUESTER : v;
  }
  if (Array.isArray(v)) return v.map((x) => redactAuditDetails(x, names, key));
  if (v && typeof v === "object") {
    // contact_id (1.19.2, a portal rating's contact) would lead back to the customer's address.
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== "contact_id")
        .map(([k, x]) => [k, redactAuditDetails(x, names, k)])
    );
  }
  return v;
}

/**
 * 1.19.2 review (agent W5): the actor name an anonymised ticket's audit row
 * takes when its actor is the requester's side with no account (actor_id
 * NULL, and the name is "Customer portal…" or carries a requester-side
 * address or name), or null to leave the row's actor alone.
 */
export function requesterSideActor(a: { actor_id: number | null; actor_name: string; ip: string | null }, emails: string[], names: Set<string>): string | null {
  if (a.actor_id !== null) return null;
  const name = a.actor_name ?? "";
  const lower = name.toLowerCase();
  const portal = lower.startsWith("customer portal");
  const named = names.has(name) || emails.some((e) => e && lower.includes(e.toLowerCase()));
  if (!portal && !named) return null;
  const next = portal ? "Customer portal" : HD_FORMER_REQUESTER;
  return next === name && a.ip === null ? null : next;
}

/** A report line with the requester-side names in it (as actor, or as "to …") replaced. */
function scrubReportLine(body: string, names: string[]): string {
  let out = body;
  for (const n of names) {
    if (out.startsWith(`${n} `)) out = `${HD_FORMER_REQUESTER}${out.slice(n.length)}`;
    if (out.endsWith(` to ${n}`)) out = `${out.slice(0, out.length - n.length)}${HD_FORMER_REQUESTER}`;
  }
  return out;
}

/**
 * An outside portal contact (lib/helpdesk/portal, agent V9) with no ticket
 * left goes, with its sessions and sign-in links (they cascade). A blocked
 * one stays so the block holds, with only its address. Inside the caller's
 * transaction.
 */
async function dropOrphanPortalContact(client: PoolClient, contactId: number | null | undefined): Promise<void> {
  if (!contactId) return;
  const left = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_tickets WHERE portal_contact_id = $1", [contactId], client);
  if ((left?.n ?? 0) > 0) return;
  const gone = await client.query("DELETE FROM hd_portal_contacts WHERE id = $1 AND blocked = 0", [contactId]);
  if (gone.rowCount) return;
  await client.query("UPDATE hd_portal_contacts SET name = '' WHERE id = $1", [contactId]);
  await client.query("DELETE FROM hd_portal_sessions WHERE contact_id = $1", [contactId]);
  await client.query("DELETE FROM hd_portal_links WHERE contact_id = $1", [contactId]);
}

/**
 * Anonymise one ticket inside the caller's transaction (see the header).
 * Returns the stored names of the files whose rows it removed: delete them
 * after the commit (deleteFiles). No-op (no files) for a missing ticket.
 * Again on an anonymised ticket: what was added since goes the same way.
 */
export async function anonymiseTicketTx(client: PoolClient, ticketId: number, now: Date = new Date()): Promise<string[]> {
  const t = await hqOne<{
    id: number;
    number: number;
    requester_id: number | null;
    requester_name: string;
    requester_email: string;
    anonymised_at: string | null;
    portal_contact_id?: number | null;
  }>("SELECT * FROM hd_tickets WHERE id = $1 FOR UPDATE", [ticketId], client);
  if (!t) return [];
  const opt = await optional(client);
  const ccUsers: number[] = [];
  const emails: string[] = t.requester_email ? [t.requester_email.toLowerCase()] : [];
  const names = new Set<string>([t.requester_name]);
  if (opt.has("hd_ticket_ccs")) {
    const ccs = await hq<{ user_id: number | null; email: string; name: string }>("SELECT user_id, email, name FROM hd_ticket_ccs WHERE ticket_id = $1", [ticketId], client);
    for (const c of ccs) {
      if (c.user_id) ccUsers.push(c.user_id);
      if (c.email) emails.push(c.email.toLowerCase());
      names.add(c.name);
    }
  }
  // Who wrote on the requester's side: the requester, CCs (now or earlier), outside senders. Agents keep their names.
  const who = `ticket_id = $1
        AND ((author_id IS NOT NULL AND (author_id = $2 OR author_id = ANY($3::int[])))
             OR (author_email <> '' AND lower(author_email) = ANY($4::text[]))
             OR ${REQUESTER_SIDE_SQL})`;
  const authors = await hq<{ author_name: string }>(`SELECT DISTINCT author_name FROM hd_messages WHERE ${who}`, [ticketId, t.requester_id, ccUsers, emails], client);
  for (const a of authors) names.add(a.author_name);
  names.delete("");
  names.delete(HD_FORMER_REQUESTER);
  await client.query(`UPDATE hd_messages SET author_name = $5, author_email = '', author_id = NULL WHERE ${who}`, [
    ticketId,
    t.requester_id,
    ccUsers,
    emails,
    HD_FORMER_REQUESTER,
  ]);
  // The lines the reports read keep their text, with requester-side names replaced; everything else is blanked.
  const nameList = [...names].sort((x, y) => y.length - x.length);
  const kept = await hq<{ id: number; body: string }>(
    `SELECT id, body FROM hd_messages WHERE ticket_id = $1 AND via = 'system' AND kind IN ('system', 'internal') AND (${REPORT_LINE_SQL("hd_messages")})`,
    [ticketId],
    client
  );
  for (const k of kept) {
    const body = scrubReportLine(k.body, nameList);
    if (body !== k.body) await client.query("UPDATE hd_messages SET body = $2 WHERE id = $1", [k.id, body]);
  }
  await client.query(
    `UPDATE hd_messages SET body = '', attachments = '[]'::jsonb, review_note = CASE WHEN review_note IS NULL THEN NULL ELSE '' END
      WHERE ticket_id = $1 AND NOT (id = ANY($2::int[]))`,
    [ticketId, kept.map((k) => k.id)]
  );
  await client.query("UPDATE hd_approvals SET note = '' WHERE ticket_id = $1 AND note <> ''", [ticketId]);
  await client.query(
    `UPDATE hd_workflow_steps SET result = result - 'note' - 'outputs' - 'handoff_note' - 'attempt_log'
      WHERE run_id IN (SELECT id FROM hd_workflow_runs WHERE ticket_id = $1)`,
    [ticketId]
  );
  if (opt.has("hd_ticket_ccs")) await client.query("DELETE FROM hd_ticket_ccs WHERE ticket_id = $1", [ticketId]);
  if (opt.has("hd_reply_drafts")) await client.query("DELETE FROM hd_reply_drafts WHERE ticket_id = $1", [ticketId]);
  if (opt.has("hd_time_entries")) await client.query("UPDATE hd_time_entries SET note = '' WHERE ticket_id = $1 AND note <> ''", [ticketId]);
  if (opt.has("hd_ticket_presence")) await client.query("DELETE FROM hd_ticket_presence WHERE ticket_id = $1", [ticketId]);
  // 1.19.2: checklist items may name the requester (agent W3, lib/helpdesk/checklists).
  await (await import("./checklists")).anonymiseChecklistsTx(client, ticketId);
  // 1.19.2: an incident's own ticket: its updates, title and their audit copies (agent W1, lib/helpdesk/incidents).
  await (await import("./incidents")).anonymiseIncidentTx(client, ticketId, ANONYMISED_SUBJECT);
  // 1.19.3: which device the requester had is theirs too: the asset links go (lib/helpdesk/assets).
  await (await import("./assets")).anonymiseTicketAssetsTx(client, ticketId);
  const files = await client.query<{ stored_name: string }>("DELETE FROM hd_attachments WHERE ticket_id = $1 RETURNING stored_name", [ticketId]);
  await client.query(
    `UPDATE hd_tickets
        SET subject = $2, requester_id = NULL, requester_name = $3, requester_email = '', form_answers = '{}'::jsonb,
            csat_comment = '', reply_token = NULL, anonymised_at = $4
            ${opt.has("hd_tickets.portal_contact_id") ? ", portal_contact_id = NULL" : ""}
      WHERE id = $1`,
    [ticketId, ANONYMISED_SUBJECT, HD_FORMER_REQUESTER, now]
  );
  if (opt.has("hd_tickets.portal_contact_id")) await dropOrphanPortalContact(client, t.portal_contact_id);
  // Bells that name the ticket (its subject, the requester) read "#N Anonymised request".
  const links = [`/desk/tickets/${t.number}`, `/help/requests/${t.number}`];
  await client.query(
    `UPDATE notifications SET title = $4, body = '', actor_name = CASE WHEN actor_name = ANY($5::text[]) THEN $6 ELSE actor_name END
      WHERE link = ANY($1::text[]) OR link LIKE $2 OR link LIKE $3`,
    [links, `${links[0]}?%`, `${links[1]}?%`, `#${t.number} ${ANONYMISED_SUBJECT}`, nameList, HD_FORMER_REQUESTER]
  );
  // Its audit rows keep the action, actor, time and ids; the subject, names and addresses go.
  const audits = await hq<{ id: number; details: unknown; target_label: string | null; actor_id: number | null; actor_name: string; ip: string | null }>(
    `SELECT id, details, target_label, actor_id, actor_name, ip FROM audit_log
      WHERE target_type = 'helpdesk_ticket'
        AND (target_id = $1 OR (action LIKE 'helpdesk.time.%' AND target_id = $2))`,
    [String(ticketId), String(t.number)],
    client
  );
  for (const a of audits) {
    const details = a.details == null ? a.details : redactAuditDetails(a.details, names);
    const label = `#${t.number}`;
    if (JSON.stringify(details) !== JSON.stringify(a.details) || a.target_label !== label) {
      await client.query("UPDATE audit_log SET details = $2, target_label = $3 WHERE id = $1", [a.id, details == null ? null : JSON.stringify(details), label]);
    }
    // 1.19.2 review (agent W5): a row whose actor is the requester's side
    // with no account (a portal rating; "Customer portal: <address>" before
    // the review) loses the address and the IP.
    const actor = requesterSideActor(a, emails, names);
    if (actor !== null) await client.query("UPDATE audit_log SET actor_name = $2, ip = NULL WHERE id = $1", [a.id, actor]);
  }
  if (!t.anonymised_at) {
    await client.query(
      `INSERT INTO hd_messages (ticket_id, author_name, kind, body, via, created_at)
       VALUES ($1, 'Helpdesk', 'system', 'Anonymised: names, emails, message text and files were removed.', 'system', $2)`,
      [ticketId, now]
    );
  }
  return files.rows.map((r) => r.stored_name);
}

/** Delete one ticket inside the caller's transaction; returns its files' stored names (delete them after the commit). */
export async function deleteTicketTx(client: PoolClient, ticketId: number): Promise<string[]> {
  const contact = (await optional(client)).has("hd_tickets.portal_contact_id")
    ? (await hqOne<{ c: number | null }>("SELECT portal_contact_id AS c FROM hd_tickets WHERE id = $1", [ticketId], client))?.c
    : null;
  const files = await client.query<{ stored_name: string }>("DELETE FROM hd_attachments WHERE ticket_id = $1 RETURNING stored_name", [ticketId]);
  await client.query("DELETE FROM hd_tickets WHERE id = $1", [ticketId]);
  await dropOrphanPortalContact(client, contact);
  return files.rows.map((r) => r.stored_name);
}

/** Remove files from the uploads volume (after the rows' transaction committed). */
export async function deleteFiles(names: string[]): Promise<void> {
  for (const n of names) await deleteUpload(n);
}

// --- The run ------------------------------------------------------------------------

export interface RetentionRunResult {
  closed: number[];
  anonymised: number[];
  deleted: number[];
  failed: number[];
  /** True when another instance held the lock and this run stopped. */
  busy: boolean;
}

/**
 * One run at `now`: close, then anonymise or delete, in batches (see the
 * header). `only` limits it to those ticket ids (tests). Audited once per
 * kind with the counts when anything happened (actor: the system, unless
 * `actor` is given).
 */
export async function runRetention(
  opts: { now?: Date; settings?: HdRetentionSettings; only?: number[] | null; actor?: AuditActor | null } = {}
): Promise<RetentionRunResult> {
  const s = opts.settings ?? (await getRetentionSettings());
  const now = opts.now ?? new Date();
  const only = opts.only ?? null;
  const closeBefore = autoCloseCutoff(s, now);
  const purgeBefore = retentionCutoff(s, now);
  const out: RetentionRunResult = { closed: [], anonymised: [], deleted: [], failed: [], busy: false };

  // Close solved tickets (only when that rule is on).
  while (s.auto_close_enabled) {
    const n = await withTx(async (client) => {
      const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [RETENTION_LOCK]);
      if (!lock.rows[0]?.ok) return -1;
      const rows = await client.query<{ id: number }>(
        `UPDATE hd_tickets SET status = 'closed', closed_at = $3, updated_at = $3
          WHERE id IN (SELECT id FROM hd_tickets WHERE ${CLOSE_WHERE} ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
          RETURNING id`,
        [closeBefore, only, now]
      );
      const ids = rows.rows.map((r) => r.id);
      if (ids.length) {
        await client.query(
          `INSERT INTO hd_messages (ticket_id, author_name, kind, body, via, created_at)
           SELECT x, 'Helpdesk', 'system', $2, 'system', $3 FROM unnest($1::int[]) x`,
          [ids, `Closed automatically: solved ${s.auto_close_days} ${s.auto_close_days === 1 ? "day" : "days"} ago with no reply since.`, now]
        );
      }
      out.closed.push(...ids);
      return ids.length;
    });
    if (n < 0) {
      out.busy = true;
      break;
    }
    if (n < BATCH) break;
  }

  // Anonymise or delete closed tickets past the retention period (only when that rule is on).
  if (!out.busy && s.retention_enabled) {
    for (;;) {
      const files: string[] = [];
      const n = await withTx(async (client) => {
        const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [RETENTION_LOCK]);
        if (!lock.rows[0]?.ok) return -1;
        const rows = await client.query<{ id: number }>(
          `SELECT id FROM hd_tickets WHERE ${purgeWhere(s.action)} AND NOT (id = ANY($3::int[]))
            ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
          [purgeBefore, only, out.failed]
        );
        for (const { id } of rows.rows) {
          await client.query("SAVEPOINT hd_retention_one");
          try {
            files.push(...(s.action === "delete" ? await deleteTicketTx(client, id) : await anonymiseTicketTx(client, id, now)));
            await client.query("RELEASE SAVEPOINT hd_retention_one");
            (s.action === "delete" ? out.deleted : out.anonymised).push(id);
          } catch (e) {
            await client.query("ROLLBACK TO SAVEPOINT hd_retention_one");
            out.failed.push(id);
            logEvent("error", "helpdesk.retention_ticket_failed", { ticket_id: id, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return rows.rows.length;
      });
      if (n < 0) {
        out.busy = true;
        break;
      }
      await deleteFiles(files);
      if (n < BATCH) break;
    }
  }

  const actor = opts.actor ?? null;
  const details = { auto_close_days: s.auto_close_days, keep: `${s.keep_amount} ${s.keep_unit}`, action: s.action };
  if (out.closed.length) {
    await audit({ actor, action: "helpdesk.ticket.auto_closed", targetType: "helpdesk_settings", targetLabel: "Retention and privacy", details: { ...details, count: out.closed.length } });
  }
  if (out.anonymised.length) {
    await audit({
      actor,
      action: "helpdesk.ticket.anonymised",
      targetType: "helpdesk_settings",
      targetLabel: "Retention and privacy",
      details: { ...details, reason: "retention", count: out.anonymised.length, closed_before: purgeBefore.toISOString() },
    });
  }
  if (out.deleted.length) {
    await audit({
      actor,
      action: "helpdesk.ticket.deleted_by_retention",
      targetType: "helpdesk_settings",
      targetLabel: "Retention and privacy",
      details: { ...details, count: out.deleted.length, closed_before: purgeBefore.toISOString() },
    });
  }
  if (out.failed.length) logEvent("warn", "helpdesk.retention_failures", { count: out.failed.length });
  return out;
}

/** The local date (YYYY-MM-DD) and hour of `now` in `tz`. */
function localDayHour(now: Date, tz: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

/** The nightly sweep (HELPDESK_SWEEPS "hd_retention"): once per local day, at or after RETENTION_RUN_HOUR. */
export async function retentionSweep(now: Date = new Date()): Promise<RetentionRunResult | null> {
  // Both rules off (the default): nothing to do, and the night is not claimed.
  const s = await getRetentionSettings();
  if (!s.auto_close_enabled && !s.retention_enabled) return null;
  const { day, hour } = localDayHour(now, await helpdeskZone());
  if (hour < RETENTION_RUN_HOUR) return null;
  if (!(await claimPeriod("hd_retention_sweep", day))) return null;
  return runRetention({ now, settings: s });
}

// --- Legal hold -----------------------------------------------------------------------

export interface HdLegalHold {
  legal_hold: boolean;
  by_name: string | null;
  at: string | null;
}

export async function getLegalHold(ticketId: number): Promise<HdLegalHold | undefined> {
  const r = await hqOne<{ legal_hold: number; by_name: string | null; legal_hold_at: string | null }>(
    `SELECT t.legal_hold, coalesce(nullif(u.name, ''), u.username) AS by_name, t.legal_hold_at
       FROM hd_tickets t LEFT JOIN users u ON u.id = t.legal_hold_by WHERE t.id = $1`,
    [ticketId]
  );
  return r ? { legal_hold: r.legal_hold === 1, by_name: r.legal_hold === 1 ? r.by_name : null, at: r.legal_hold === 1 ? r.legal_hold_at : null } : undefined;
}

/** Put a ticket on legal hold or take it off; returns whether it changed. */
export async function setLegalHold(ticketId: number, on: boolean, actorId: number): Promise<boolean> {
  const r = await hq(
    `UPDATE hd_tickets SET legal_hold = $2, legal_hold_by = CASE WHEN $2 = 1 THEN $3::int END, legal_hold_at = CASE WHEN $2 = 1 THEN now() END
      WHERE id = $1 AND legal_hold <> $2 RETURNING id`,
    [ticketId, on ? 1 : 0, actorId]
  );
  return r.length > 0;
}

// --- Account removal ----------------------------------------------------------------

export interface HdRemovedAccount {
  /** null when the setting is off (only the legal-hold CC rows were kept). */
  result: { requester: number; cc: number } | null;
  /** Stored file names to delete after the commit. */
  files: string[];
}

/**
 * The account-removal part that runs inside lib/db deleteUser's
 * transaction, before DELETE FROM users, so a failed removal changes
 * nothing (see the header). With the setting on: as requester (by account or by their
 * email, with the request's task tickets) the whole ticket; elsewhere,
 * on tickets not on hold, their own requester-side messages (author, text,
 * files) whether or not they are still copied in, every message of theirs
 * on a ticket they are copied on, and their CC rows. Then call
 * finishRemovedAccount after the commit.
 */
export async function anonymiseRemovedAccountTx(client: PoolClient, userId: number, now: Date = new Date()): Promise<HdRemovedAccount> {
  const files: string[] = [];
  const user = await hqOne<{ email: string }>(
    "SELECT coalesce(email, '') AS email FROM users WHERE id = $1",
    [userId],
    client
  );
  if (!user) return { result: null, files };
  const email = user.email.trim().toLowerCase();
  const opt = await optional(client);
  const s = await getRetentionSettings();
  if (!s.anonymise_on_account_removal) return { result: null, files };
  const own = await hq<{ id: number }>(
    `WITH mine AS (
       SELECT id FROM hd_tickets
        WHERE legal_hold = 0 AND ${needsAnonymisingSql()}
          AND (requester_id = $1 OR ($2 <> '' AND lower(requester_email) = $2)))
     SELECT id FROM mine
     UNION
     SELECT c.id FROM hd_tickets c JOIN mine m ON c.parent_ticket_id = m.id
      WHERE c.legal_hold = 0 AND ${needsAnonymisingSql("c")} AND c.source = 'workflow'
     ORDER BY id`,
    [userId, email],
    client
  );
  for (const t of own) files.push(...(await anonymiseTicketTx(client, t.id, now)));
  const ownIds = own.map((t) => t.id);
  const copied = opt.has("hd_ticket_ccs")
    ? (
        await hq<{ ticket_id: number }>(
          `SELECT DISTINCT c.ticket_id FROM hd_ticket_ccs c JOIN hd_tickets t ON t.id = c.ticket_id
            WHERE t.legal_hold = 0 AND NOT (c.ticket_id = ANY($3::int[]))
              AND (c.user_id = $1 OR (c.user_id IS NULL AND $2 <> '' AND lower(c.email) = $2))`,
          [userId, email, ownIds],
          client
        )
      ).map((r) => r.ticket_id)
    : [];
  // Their messages: everything on a ticket they are copied on; on any other ticket, what they wrote on the requester's side.
  const msgs = await client.query<{ id: number; ticket_id: number }>(
    `UPDATE hd_messages SET author_name = $3, author_email = '', author_id = NULL, body = '', attachments = '[]'::jsonb
      WHERE NOT (ticket_id = ANY($5::int[]))
        AND ticket_id IN (SELECT id FROM hd_tickets WHERE legal_hold = 0)
        AND (author_id = $1 OR ($2 <> '' AND lower(author_email) = $2))
        AND (ticket_id = ANY($4::int[]) OR ${REQUESTER_SIDE_SQL})
      RETURNING id, ticket_id`,
    [userId, email, HD_FORMER_REQUESTER, copied, ownIds]
  );
  const mids = msgs.rows.map((r) => r.id);
  if (mids.length) {
    const f = await client.query<{ stored_name: string }>("DELETE FROM hd_attachments WHERE message_id = ANY($1::int[]) RETURNING stored_name", [mids]);
    files.push(...f.rows.map((r) => r.stored_name));
  }
  if (copied.length) {
    await client.query(
      "DELETE FROM hd_ticket_ccs WHERE ticket_id = ANY($1::int[]) AND (user_id = $2 OR (user_id IS NULL AND $3 <> '' AND lower(email) = $3))",
      [copied, userId, email]
    );
  }
  const elsewhere = new Set([...copied, ...msgs.rows.map((r) => r.ticket_id)]);
  return { result: { requester: own.length, cc: elsewhere.size }, files };
}

/**
 * Legal hold (lib/db deleteUser, in its transaction, whatever the
 * settings): on a held ticket the person's CC row outlives the account as
 * the name and address it had (hd_ticket_ccs.user_id cascades), one row
 * per address and ticket. Returns how many rows were kept.
 * The kept row is a record, not a CC (account_removed): never mailed,
 * listed or matched as a CC's reply (lib/helpdesk/ccs). An outside-address
 * row of a held ticket with the person's address is marked the same way.
 */
export async function keepHeldCcRowsTx(client: PoolClient, userId: number): Promise<number> {
  if (!(await optional(client)).has("hd_ticket_ccs")) return 0;
  await client.query(
    `UPDATE hd_ticket_ccs c SET account_removed = true
       FROM hd_tickets t, users u
      WHERE t.id = c.ticket_id AND t.legal_hold = 1 AND u.id = $1 AND coalesce(u.email, '') <> ''
        AND c.user_id IS NULL AND lower(c.email) = lower(u.email) AND NOT c.account_removed`,
    [userId]
  );
  const r = await client.query(
    `UPDATE hd_ticket_ccs c SET user_id = NULL,
            email = lower(coalesce(u.email, '')),
            name = CASE WHEN c.name <> '' THEN c.name ELSE coalesce(nullif(u.name, ''), u.username) END,
            account_removed = true
       FROM hd_tickets t, users u
      WHERE t.id = c.ticket_id AND t.legal_hold = 1 AND c.user_id = $1 AND u.id = $1
        AND NOT EXISTS (SELECT 1 FROM hd_ticket_ccs o WHERE o.ticket_id = c.ticket_id AND o.user_id IS NULL AND lower(o.email) = lower(coalesce(u.email, '')))`,
    [userId]
  );
  return r.rowCount ?? 0;
}

/** After deleteUser's commit: the files go, and the audit row. Never throws. */
export async function finishRemovedAccount(userId: number, done: HdRemovedAccount): Promise<void> {
  try {
    await deleteFiles(done.files);
    const r = done.result;
    if (r && (r.requester || r.cc)) {
      await audit({
        actor: null,
        action: "helpdesk.ticket.anonymised",
        targetType: "user",
        targetId: userId,
        details: { reason: "account_removed", user_id: userId, requester: r.requester, cc: r.cc, count: r.requester + r.cc },
      });
    }
  } catch (e) {
    logEvent("error", "helpdesk.account_removal_finish_failed", { user_id: userId, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Anonymise a person's tickets on its own (tests, tools): the same as
 * account removal does, in one transaction of its own, then the files and
 * the audit. Null when the setting is off.
 */
export async function anonymiseRemovedAccount(userId: number, now: Date = new Date()): Promise<{ requester: number; cc: number } | null> {
  const done = await withTx((client) => anonymiseRemovedAccountTx(client, userId, now));
  await finishRemovedAccount(userId, done);
  return done.result;
}

// --- Data export ----------------------------------------------------------------------

export interface HdPersonalExport {
  included: boolean;
  requests: {
    number: number;
    subject: string;
    status: string;
    /** requester: their own request (by account or address). cc: copied on it. replied: they wrote on it. */
    relation: "requester" | "cc" | "replied";
    /** The request was merged into this one; its conversation is listed here all the same. */
    merged_into: number | null;
    request_type: string | null;
    team: string | null;
    created_at: string;
    solved_at: string | null;
    closed_at: string | null;
    answers: { question: string; answer: string }[];
    /** Their own requests: the public conversation. Otherwise: only their own public messages. */
    conversation: { from: string; at: string; text: string; files: string[]; from_request?: number }[];
    /** 1.19.3: the assets linked to their own request, tag and name only (lib/helpdesk/assets). */
    assets?: { tag: string; name: string }[];
  }[];
  /** 1.19.2: major incidents they said affect them ("Me too" in Get help; agent W1, lib/helpdesk/incidents). */
  incidents_affected?: { incident: string; at: string }[];
}

/**
 * A person's helpdesk data for their personal data export (the same people
 * account removal treats as theirs): their requests as requester, by
 * account or by their address (task tickets left out), with the answers
 * they gave and the public conversation, including what a merge moved onto
 * the kept ticket; requests they are copied on or wrote on (the
 * requester's side), with only their own public messages. Never internal
 * notes, system lines or replies held for review. `included: false` (and
 * nothing else) when the setting is off.
 */
export async function personalHelpdeskExport(userId: number): Promise<HdPersonalExport> {
  const s = await getRetentionSettings();
  if (!s.include_in_export) return { included: false, requests: [] };
  const email = ((await hqOne<{ email: string }>("SELECT coalesce(email, '') AS email FROM users WHERE id = $1", [userId]))?.email ?? "").trim().toLowerCase();
  const tickets = await hq<{
    id: number;
    number: number;
    subject: string;
    status: HdStatus;
    relation: "requester" | "cc" | "replied";
    merged_into_number: number | null;
    created_at: string;
    solved_at: string | null;
    closed_at: string | null;
    form_answers: Record<string, unknown>;
    rt_title: string | null;
    rt_form: HdFormField[] | null;
    team_name: string | null;
  }>(
    `WITH rel AS (
       SELECT id AS ticket_id, 1 AS rank FROM hd_tickets
        WHERE source <> 'workflow' AND (requester_id = $1 OR (requester_id IS NULL AND $2 <> '' AND lower(requester_email) = $2))
       UNION ALL
       SELECT ticket_id, 2 FROM hd_ticket_ccs WHERE NOT account_removed AND (user_id = $1 OR (user_id IS NULL AND $2 <> '' AND lower(email) = $2))
       UNION ALL
       SELECT ticket_id, 3 FROM hd_messages
        WHERE kind = 'public' AND (author_id = $1 OR ($2 <> '' AND lower(author_email) = $2)) AND ${REQUESTER_SIDE_SQL}
     ), best AS (SELECT ticket_id, min(rank) AS rank FROM rel GROUP BY ticket_id)
     SELECT t.id, t.number, t.subject, t.status, t.created_at, t.solved_at, t.closed_at, t.form_answers,
            CASE b.rank WHEN 1 THEN 'requester' WHEN 2 THEN 'cc' ELSE 'replied' END AS relation,
            mt.number AS merged_into_number,
            rt.title AS rt_title, rt.form AS rt_form, tm.name AS team_name
       FROM best b
       JOIN hd_tickets t ON t.id = b.ticket_id
       LEFT JOIN hd_tickets mt ON mt.id = t.merged_into
       LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id
       LEFT JOIN hd_teams tm ON tm.id = t.team_id
      ORDER BY t.created_at, t.id`,
    [userId, email]
  );
  const incidentsAffected = await (await import("./incidents")).incidentsAffectedFor(userId);
  if (!tickets.length) return { included: true, requests: [], incidents_affected: incidentsAffected };
  const own = tickets.filter((t) => t.relation === "requester");
  const msgs = await hq<{
    id: number;
    ticket_id: number;
    author_id: number | null;
    author_email: string;
    author_name: string;
    created_at: string;
    body: string;
    merged_from: number | null;
    attachments: { filename?: string }[] | null;
  }>(
    `SELECT id, ticket_id, author_id, author_email, author_name, created_at, body, merged_from, attachments FROM hd_messages
      WHERE kind = 'public' AND coalesce(review_state, '') NOT IN ('pending', 'returned')
        AND (ticket_id = ANY($1::int[]) OR merged_from = ANY($2::int[]))
      ORDER BY created_at, id`,
    [tickets.map((t) => t.id), own.map((t) => t.number)]
  );
  const mine = (m: (typeof msgs)[number]) => m.author_id === userId || (email !== "" && (m.author_email ?? "").toLowerCase() === email);
  const used = new Set<number>();
  const conversationOf = (t: (typeof tickets)[number]) => {
    const list = msgs.filter((m) =>
      t.relation === "requester"
        ? m.ticket_id === t.id || (t.merged_into_number !== null && Number(m.merged_from) === t.number)
        : m.ticket_id === t.id && mine(m)
    );
    const out = list.filter((m) => !used.has(m.id));
    for (const m of out) used.add(m.id);
    return out.map((m) => ({
      from: m.author_name,
      at: m.created_at,
      text: m.body,
      files: (Array.isArray(m.attachments) ? m.attachments : []).map((a) => String(a?.filename ?? "")).filter(Boolean),
      ...(m.merged_from !== null && m.ticket_id !== t.id ? { from_request: Number(m.merged_from) } : {}),
    }));
  };
  // Their own requests first, so a merged conversation is listed under the request it came from.
  const conversations = new Map<number, ReturnType<typeof conversationOf>>();
  for (const t of own) conversations.set(t.id, conversationOf(t));
  for (const t of tickets) if (t.relation !== "requester") conversations.set(t.id, conversationOf(t));
  // 1.19.3: assets linked to their own requests (lib/helpdesk/assets).
  const assetsOn = await (await import("./assets")).assetsForExport(own.map((t) => t.id));
  return {
    included: true,
    incidents_affected: incidentsAffected,
    requests: tickets.map((t) => ({
      number: t.number,
      subject: t.subject,
      status: HD_STATUS_LABEL_REQUESTER[t.status] ?? t.status,
      relation: t.relation,
      merged_into: t.merged_into_number,
      request_type: t.rt_title,
      team: t.team_name,
      created_at: t.created_at,
      solved_at: t.solved_at,
      closed_at: t.closed_at,
      answers:
        t.relation !== "requester"
          ? []
          : (t.rt_form ?? []).map((f) => ({ question: f.label, answer: answerText(f, (t.form_answers ?? {})[f.key]) })).filter((a) => a.answer !== ""),
      conversation: conversations.get(t.id) ?? [],
      ...(t.relation === "requester" && assetsOn.get(t.id)?.length ? { assets: assetsOn.get(t.id) } : {}),
    })),
  };
}
