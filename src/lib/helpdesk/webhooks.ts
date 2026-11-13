// Helpdesk 1.19.4 (area C2): outgoing webhooks. Desk settings → API and
// webhooks (settings.manage) sets them up; lib/helpdesk/events calls
// emitHelpdeskWebhookEvent after each write commits, and the recycle bin
// (C7) calls it for ticket.deleted / ticket.restored.
//
// Why not lib/webhooks (Settings → Notifications): those are chat-channel
// notices, fire-and-forget with an 8-second timeout, no queue, no retry, no
// signature and one status line per hook. Integrations need the opposite
// (a signed JSON envelope, retries for a day, a log), so this is its own
// small queue. It shares the transport rules: every request goes through
// lib/safe-fetch (safeFetchOnce: the SSRF guard, DNS pinned to the address
// that was checked, private ranges only with COMPASSDOCS_FETCH_ALLOW_PRIVATE=1,
// HTTPS_PROXY routing). Redirects are never followed: a POST is not
// re-sent somewhere else, and a 3xx is a failed attempt naming the reason.
//
// Scope and privacy: a webhook hears about the tickets of the teams it
// is filtered to (no filter = every team; a ticket with no team only
// reaches unfiltered hooks). That is its "acts as": what an agent of those
// teams sees on the ticket, and no more. Public replies are sent; internal
// notes only when the hook includes them; a newbie's reply held for review
// is never sent (it goes as message.created once a lead approves it); a
// ticket in the recycle bin sends nothing but ticket.deleted.
//
// Delivery: one queued row per (event, hook), written after the commit and
// sent at once in the background; the minute sweep (lib/periodic
// "hd_webhooks") retries with backoff (1, 5, 15, 30 minutes, then 1, 2, 4
// and every 6 hours) until 24 hours after the event, then marks it failed.
// The body is the same on every attempt; the signature is made fresh each
// time:  X-CompassDocs-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
// "<t>.<body>"> with the hook's secret. X-CompassDocs-Delivery is the
// event's id (the same on retries, so a receiver can drop duplicates).
// When a delivery gives up while the hook has been failing for 24 hours
// the hook turns itself off and the desk's admins hear in the bell.
//
// Server-only.

import "server-only";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { audit, type AuditActor } from "../audit";
import { logEvent } from "../log";
import { openSecret, sealSecret } from "../secretbox";
import type { Role } from "../types";
import { hq, hqOne, normalizeRow, withTx } from "./db-core";
import { helpdeskLicensed } from "./access";
import {
  HD_API_LIMITS,
  HD_WEBHOOK_SIGNATURE_HEADER,
  isWebhookEvent,
  type HdDeliveryState,
  type HdDeliveryView,
  type HdWebhookEvent,
  type HdWebhookHealth,
  type HdWebhookView,
} from "./api-shared";

// --- The hook other areas call -------------------------------------------------------

/** Who caused the event: a person, a rule ("Assignment rule …"), or an API token's service account. */
export interface HdWebhookActorInput {
  id?: number | null;
  name?: string;
}

/**
 * What each event needs. Everything else (the ticket's fields, the message,
 * the approval) is read when the event is emitted, so the payload is the
 * state just after the write.
 */
export interface HdWebhookEventInput {
  "ticket.created": { ticketId: number; actor?: HdWebhookActorInput; origin?: string };
  "ticket.updated": { ticketId: number; changed: string[]; previousTeamId?: number | null; actor?: HdWebhookActorInput; origin?: string };
  "ticket.solved": { ticketId: number; actor?: HdWebhookActorInput; origin?: string };
  "message.created": { ticketId: number; messageId: number; actor?: HdWebhookActorInput; origin?: string };
  "note.created": { ticketId: number; messageId: number; actor?: HdWebhookActorInput; origin?: string };
  "approval.decided": { ticketId: number; approvalId: number; actor?: HdWebhookActorInput; origin?: string };
  /** The recycle bin (C7): emit right after the ticket is binned (its row still exists, deleted_at set). */
  "ticket.deleted": { ticketId: number; actor?: HdWebhookActorInput; origin?: string };
  /** The recycle bin (C7): emit right after the ticket is restored (deleted_at cleared). */
  "ticket.restored": { ticketId: number; actor?: HdWebhookActorInput; origin?: string };
  /** 1.20.6 (lib/helpdesk/desk-calendar): emit after the commit that marked the event's setup complete. */
  "event.setup_completed": { ticketId: number; actor?: HdWebhookActorInput; origin?: string };
}

/**
 * Queue `event` for every enabled webhook that subscribes to it and whose
 * team filter covers the ticket. Call it AFTER the write has committed and
 * outside any transaction. Never throws (a webhook must not fail the write
 * that caused it); resolves to the number of deliveries queued. Sending
 * starts in the background at once.
 */
export async function emitHelpdeskWebhookEvent<E extends HdWebhookEvent>(event: E, input: HdWebhookEventInput[E]): Promise<number> {
  try {
    return await emit(event, input as HdWebhookEventInput[HdWebhookEvent] & { ticketId: number });
  } catch (e) {
    logEvent("error", "helpdesk.webhook.emit_failed", { event, error: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

// --- Payload -------------------------------------------------------------------------

interface TicketFacts {
  id: number;
  number: number;
  subject: string;
  status: string;
  priority: string;
  team_id: number | null;
  team_name: string | null;
  assignee_id: number | null;
  assignee_name: string | null;
  requester_name: string;
  requester_email: string;
  tags: string[];
  category: string;
  /** 1.20.6: read through to_jsonb, so this works on a database the column has not reached yet. */
  subcategory: string | null;
  source: string;
  request_type: string | null;
  created_at: string;
  updated_at: string;
  solved_at: string | null;
  merged_into: number | null;
  /** The recycle bin's column read through to_jsonb, so this works before and after C7 adds it. */
  deleted_at: string | null;
  /** 1.20.2 (lib/helpdesk/mailboxes): the ticket's own help address. */
  mailbox_id: number | null;
  mailbox_address: string | null;
  mailbox_name: string | null;
}

async function ticketFacts(ticketId: number): Promise<TicketFacts | undefined> {
  return hqOne<TicketFacts>(
    `SELECT t.id, t.number, t.subject, t.status, t.priority, t.team_id, tm.name AS team_name,
            t.assignee_id, NULLIF(COALESCE(NULLIF(a.name, ''), a.username), '') AS assignee_name,
            t.requester_name, t.requester_email, t.tags, t.category, (to_jsonb(t) ->> 'subcategory') AS subcategory, t.source, rt.title AS request_type,
            t.created_at, t.updated_at, t.solved_at, (to_jsonb(t) ->> 'merged_into')::int AS merged_into,
            (to_jsonb(t) ->> 'deleted_at') AS deleted_at,
            mb.id AS mailbox_id, mb.address AS mailbox_address, mb.name AS mailbox_name
       FROM hd_tickets t
       LEFT JOIN hd_mailboxes mb ON mb.id = t.mailbox_id
       LEFT JOIN hd_teams tm ON tm.id = t.team_id
       LEFT JOIN users a ON a.id = t.assignee_id
       LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id
      WHERE t.id = $1`,
    [ticketId]
  );
}

function ticketOut(t: TicketFacts, origin: string) {
  const path = `/desk/tickets/${t.number}`;
  return {
    number: t.number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    team: t.team_id ? { id: t.team_id, name: t.team_name ?? "" } : null,
    // 1.20.2 (additive): the help address the ticket came in on or is answered from; null = none of its own.
    mailbox: t.mailbox_id && t.mailbox_address ? { id: t.mailbox_id, address: t.mailbox_address, name: t.mailbox_name ?? "" } : null,
    assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name ?? "" } : null,
    requester: { name: t.requester_name, email: t.requester_email },
    tags: t.tags ?? [],
    category: t.category || null,
    // 1.20.6 (additive): a sub-category of `category`; null = none.
    subcategory: t.subcategory || null,
    request_type: t.request_type,
    source: t.source,
    created_at: t.created_at,
    updated_at: t.updated_at,
    solved_at: t.solved_at,
    ...(t.merged_into ? { merged: true } : {}),
    url: origin ? `${origin}${path}` : path,
  };
}

/** The actor as receivers see it; an API token's service account says which token. */
async function actorOut(a: HdWebhookActorInput | undefined): Promise<Record<string, unknown> | null> {
  if (!a || (!a.id && !a.name)) return null;
  if (a.id) {
    const tok = await hqOne<{ id: number; name: string }>("SELECT id, name FROM hd_api_tokens WHERE principal_id = $1", [a.id]);
    if (tok) return { name: a.name || tok.name, via: "api", api_token: { id: tok.id, name: tok.name } };
  }
  return { name: a.name ?? "" };
}

interface MessageFacts {
  id: number;
  kind: string;
  via: string;
  body: string;
  author_name: string;
  author_id: number | null;
  attachments: { name?: string }[];
  review_state: string | null;
  created_at: string;
  requester_id: number | null;
}

// --- Emit ------------------------------------------------------------------------------

interface HookRow {
  id: number;
  team_ids: number[];
  include_notes: boolean;
}

let autoSend = true;
/** Tests: don't start sending in the background after an emit (they call processDueDeliveries themselves). */
export function setWebhookAutoSendForTests(on: boolean): void {
  autoSend = on;
}

async function emit(event: HdWebhookEvent, input: HdWebhookEventInput[HdWebhookEvent] & { ticketId: number }): Promise<number> {
  if (!isWebhookEvent(event)) return 0;
  // Cheap first: is anyone listening?
  let hooks = await hq<HookRow>("SELECT id, team_ids, include_notes FROM hd_webhooks WHERE enabled AND $1 = ANY(events) ORDER BY id", [event]);
  if (!hooks.length) return 0;
  if (!(await helpdeskLicensed())) return 0;
  const t = await ticketFacts(input.ticketId);
  if (!t) return 0;
  // A ticket in the recycle bin is silent, except for the event that put it there.
  if (t.deleted_at && event !== "ticket.deleted") return 0;
  const previousTeam = event === "ticket.updated" ? (input as HdWebhookEventInput["ticket.updated"]).previousTeamId : undefined;
  hooks = hooks.filter((h) => {
    if (!h.team_ids?.length) return true;
    if (t.team_id !== null && h.team_ids.includes(t.team_id)) return true;
    // A ticket moved out of a hook's team: that hook hears about the move.
    return previousTeam != null && h.team_ids.includes(previousTeam);
  });
  if (event === "note.created") hooks = hooks.filter((h) => h.include_notes);
  if (!hooks.length) return 0;

  const { helpdeskOrigin } = await import("./email");
  const origin = await helpdeskOrigin(input.origin).catch(() => "");
  const body: Record<string, unknown> = {};

  if (event === "message.created" || event === "note.created") {
    const m = await hqOne<MessageFacts>(
      `SELECT m.id, m.kind, m.via, m.body, m.author_name, m.author_id, m.attachments, m.review_state, m.created_at, t.requester_id
         FROM hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id WHERE m.id = $1 AND m.ticket_id = $2`,
      [(input as { messageId: number }).messageId, t.id]
    );
    if (!m) return 0;
    // Held for review (or returned): not sent to anyone yet, so not here either.
    if (m.review_state === "pending" || m.review_state === "returned") return 0;
    if (event === "message.created" && m.kind !== "public") return 0;
    if (event === "note.created" && (m.kind !== "internal" || m.via === "system")) return 0;
    body.message = {
      id: m.id,
      kind: m.kind,
      // "requester": the requester's side (the requester, a CC, an outside sender); "desk": an agent.
      from: await messageSide(m),
      author: { name: m.author_name },
      body: m.body,
      attachments: (m.attachments ?? []).map((a) => a?.name ?? "").filter(Boolean),
      created_at: m.created_at,
    };
  } else if (event === "approval.decided") {
    const a = await hqOne<{ id: number; title: string | null; decision: string; decided_by_name: string; decided_at: string | null; note: string }>(
      `SELECT a.id, s.result->>'title' AS title, a.decision, a.decided_by_name, a.decided_at, a.note
         FROM hd_approvals a JOIN hd_workflow_steps s ON s.id = a.step_id WHERE a.id = $1 AND a.ticket_id = $2`,
      [(input as { approvalId: number }).approvalId, t.id]
    );
    if (!a || a.decision === "pending") return 0;
    body.approval = { id: a.id, step: a.title ?? "Approval", decision: a.decision, decided_by: { name: a.decided_by_name }, decided_at: a.decided_at, note: a.note || null };
  } else if (event === "ticket.updated") {
    body.changes = [...new Set((input as HdWebhookEventInput["ticket.updated"]).changed)];
  } else if (event === "ticket.solved") {
    // 1.20.5 (additive): the "Before you solve" answers kept on the ticket, [{ set, key, label, value, text }]; [] when
    // none (lib/helpdesk/solve-requirements). They are what an agent of the hook's teams reads on the ticket.
    body.solve_details = await (await import("./solve-requirements")).solveDetailsOut(t.id).catch(() => []);
  }

  const eventId = `evt_${randomUUID()}`;
  const payload = {
    id: eventId,
    event,
    created_at: "", // the database clock, stamped by the INSERT below
    actor: await actorOut(input.actor),
    // 1.20.6 (additive): `ticket.event`, the ticket's event (lib/helpdesk/desk-calendar eventOut); null when it has none.
    // 1.20.6 (additive): ticket.custom_fields, { "<field key>": value | null } for the fields of the ticket's team; {} when
    // none (lib/helpdesk/custom-fields). They are what an agent of the hook's teams reads on the ticket, agent-only ones included.
    ticket: {
      ...ticketOut(t, origin),
      event: await (await import("./desk-calendar")).ticketEventOut(t.id),
      custom_fields: await (await import("./custom-fields")).customFieldsOut({ id: t.id, team_id: t.team_id }).catch(() => ({})),
    },
    ...body,
  };
  const ids = await hq<{ id: number }>(
    `INSERT INTO hd_webhook_deliveries (hook_id, event, event_id, ticket_id, ticket_number, payload, actor_id)
     SELECT h, $2, $3, $4, $5, jsonb_set($6::jsonb, '{created_at}', to_jsonb(now())), $7 FROM unnest($1::int[]) AS h
     RETURNING id`,
    [hooks.map((h) => h.id), event, eventId, t.id, t.number, JSON.stringify(payload), input.actor?.id ?? null]
  );
  // Start sending now, in the background: whatever is due, so a row queued behind its hook's send in flight
  // (one at a time per hook, oldest first) goes as soon as that one finishes, not at the next minute's sweep.
  if (autoSend && ids.length) {
    void processDueDeliveries({ limit: 25 }).catch((e) =>
      logEvent("error", "helpdesk.webhook.send_failed", { error: e instanceof Error ? e.message : String(e) })
    );
  }
  return ids.length;
}

/** "requester" for the requester's own message (or a CC's / an outside sender's by email or the portal), else "desk". */
async function messageSide(m: MessageFacts): Promise<"requester" | "desk"> {
  if (m.author_id !== null && m.author_id === m.requester_id) return "requester";
  if (m.via === "customer_portal" || m.via === "portal") return "requester";
  if (m.author_id === null && m.via === "email") return "requester";
  if (m.author_id !== null) {
    // An agent of the desk (anyone with a desk role) is "desk"; anyone else writing a public message is on the requester's side (a CC).
    const { isAgent } = await import("./access");
    const u = await hqOne<{ id: number; role: import("../types").Role }>("SELECT id, role FROM users WHERE id = $1", [m.author_id]);
    if (u && !(await isAgent(u))) return "requester";
  }
  return "desk";
}

// --- Sending ------------------------------------------------------------------------------

/** Seconds to wait after the Nth failed attempt (1-based); the last repeats. */
export const WEBHOOK_BACKOFF_SECONDS = [60, 300, 900, 1800, 3600, 7200, 14400, 21600] as const;

export function nextDelaySeconds(attempts: number): number {
  return WEBHOOK_BACKOFF_SECONDS[Math.min(Math.max(1, attempts), WEBHOOK_BACKOFF_SECONDS.length) - 1];
}

/** `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function signWebhookBody(secret: string, body: string, unixSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${v1}`;
}

/**
 * The receiver's check, as the docs show it: the header's v1 must be the
 * HMAC of "<t>.<body>" and t within `toleranceSeconds` of now.
 */
export function verifyWebhookSignature(secret: string, header: string, body: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > toleranceSeconds || typeof parts.v1 !== "string") return false;
  const want = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  const got = Buffer.from(parts.v1);
  return want.length === got.length && timingSafeEqual(want, got);
}

export type WebhookTransport = (url: string, init: RequestInit) => Promise<Response>;
let testTransport: WebhookTransport | null = null;

/** Tests: send through `t` (an in-process receiver) instead of safeFetchOnce; null restores it. */
export function setWebhookTransportForTests(t: WebhookTransport | null): void {
  testTransport = t;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  if (testTransport) return testTransport(url, init);
  const { safeFetchOnce } = await import("../safe-fetch");
  return safeFetchOnce(url, init);
}

/** The first `max` bytes of a body as text; the rest is never read. */
async function excerpt(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    /* a body that breaks off: keep what came */
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, max).toString("utf8").replace(/�+$/, "");
}

interface AttemptOutcome {
  ok: boolean;
  status: number | null;
  excerpt: string;
  error: string;
  ms: number;
}

/** A sentence an admin can act on, naming no internal address. */
function failureSentence(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted/i.test(msg)) return `No answer within ${HD_API_LIMITS.timeoutMs / 1000} seconds.`;
  if (/^Blocked (address|host)/.test(msg)) {
    return "That address is on a private or local network, which webhooks can't reach unless the server sets COMPASSDOCS_FETCH_ALLOW_PRIVATE=1.";
  }
  if (/^Blocked URL scheme/.test(msg)) return "Only https addresses can be used.";
  if (/Could not resolve host/.test(msg)) return "The endpoint's host name could not be found.";
  return "The endpoint could not be reached (connection refused, reset, or a certificate problem).";
}

async function attempt(url: string, secret: string, event: string, eventId: string, _deliveryId: number, body: string, signedAt: Date): Promise<AttemptOutcome> {
  const started = Date.now();
  // Signed with the time of this attempt (the database clock read as the row was claimed, a moment ago), never a batch's or a tick's start.
  const unix = Math.floor(signedAt.getTime() / 1000);
  let res: Response;
  try {
    if (!/^https:\/\//i.test(url)) throw new Error("Blocked URL scheme: http:");
    res = await send(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "CompassDocs-Webhooks/1.19.4",
        "x-compassdocs-event": event,
        "x-compassdocs-delivery": eventId,
        [HD_WEBHOOK_SIGNATURE_HEADER.toLowerCase()]: signWebhookBody(secret, body, unix),
      },
      body,
      signal: AbortSignal.timeout(HD_API_LIMITS.timeoutMs),
    });
  } catch (e) {
    return { ok: false, status: null, excerpt: "", error: failureSentence(e), ms: Date.now() - started };
  }
  const text = await excerpt(res, HD_API_LIMITS.responseExcerpt).catch(() => "");
  const ms = Date.now() - started;
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, excerpt: text, error: "", ms };
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, status: res.status, excerpt: text, error: `The endpoint answered with a redirect (HTTP ${res.status}). Redirects aren't followed: use the final address.`, ms };
  }
  return { ok: false, status: res.status, excerpt: text, error: `HTTP ${res.status}`, ms };
}

interface DeliveryRow {
  id: number;
  hook_id: number;
  event: string;
  event_id: string;
  ticket_id: number | null;
  ticket_number: number | null;
  test: boolean;
  payload: unknown;
  attempts: number;
  /** The event's time (the retry window runs 24 hours from it). */
  created_at: string;
  /** This claim, exactly as stored (text): every later write is conditional on it. */
  claim: string;
  /** The database clock when the row was claimed, in epoch milliseconds: the attempt's time. */
  db_now_ms: string;
}

interface HookSecretRow {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  secret_sealed: string;
  failing_since: string | null;
}

/** Parallel senders per pass; one hook never has more than one send in flight, so a dead endpoint holds at most one. */
const WEBHOOK_WORKERS = 4;
/** A pass stops claiming new rows after this long (the minute tick's next pass carries on). */
let passBudgetMs = 45_000;
/**
 * A claim older than this belongs to a process that died mid-send, and the
 * sweep queues the row again. Each row is claimed just before its one
 * attempt (at most HD_API_LIMITS.timeoutMs), so this is far longer than any
 * live claim can be.
 */
let staleClaimMs = 5 * 60_000;

/** Tests: shorten the stale-claim threshold and a pass's budget (null restores them). */
export function setWebhookTimingForTests(t: { staleClaimMs?: number; passBudgetMs?: number } | null): void {
  staleClaimMs = t?.staleClaimMs ?? 5 * 60_000;
  passBudgetMs = t?.passBudgetMs ?? 45_000;
}

const CLAIM_RETURNING = `RETURNING d.id, d.hook_id, d.event, d.event_id, d.ticket_id, d.ticket_number, d.test, d.payload, d.attempts, d.created_at,
                d.claimed_at::text AS claim, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS db_now_ms`;

/**
 * Claim one due row, in a short transaction. A test send is claimed as it
 * is. An event is claimed only for a hook with no send in flight, and only
 * its oldest due row: the claimer first takes the hook's two-key advisory
 * try-lock (WEBHOOK_SWEEP_LOCK, hook id), so two claimers can't both find
 * the hook idle before either commits, and events reach a receiver one at a
 * time, oldest first. `asOf` only chooses which rows are due (tests); the
 * database clock decides otherwise.
 */
async function claimOne(asOf: Date | null, ids: number[] | null): Promise<DeliveryRow | undefined> {
  const due = `q.state = 'queued' AND q.next_attempt_at <= COALESCE($1::timestamptz, clock_timestamp()) AND ($2::bigint[] IS NULL OR q.id = ANY($2::bigint[]))`;
  const params = [asOf, ids?.length ? ids : null];
  return withTx(async (client) => {
    const test = await client.query<DeliveryRow>(
      `UPDATE hd_webhook_deliveries d SET state = 'sending', claimed_at = clock_timestamp()
        WHERE d.id = (SELECT q.id FROM hd_webhook_deliveries q WHERE ${due} AND q.test ORDER BY q.id LIMIT 1 FOR UPDATE SKIP LOCKED)
        ${CLAIM_RETURNING}`,
      params
    );
    if (test.rows[0]) return normalizeRow<DeliveryRow>(test.rows[0] as unknown as Record<string, unknown>);
    const hooks = await client.query<{ hook_id: number }>(
      `SELECT q.hook_id FROM hd_webhook_deliveries q WHERE ${due} AND NOT q.test
        GROUP BY q.hook_id ORDER BY min(q.next_attempt_at), q.hook_id LIMIT 20`,
      params
    );
    for (const { hook_id } of hooks.rows) {
      const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1, $2) AS ok", [WEBHOOK_SWEEP_LOCK, hook_id]);
      if (!lock.rows[0]?.ok) continue;
      const busy = await client.query("SELECT 1 FROM hd_webhook_deliveries WHERE hook_id = $1 AND state = 'sending' AND NOT test LIMIT 1", [hook_id]);
      if (busy.rowCount) continue;
      const row = await client.query<DeliveryRow>(
        `UPDATE hd_webhook_deliveries d SET state = 'sending', claimed_at = clock_timestamp()
          WHERE d.id = (SELECT q.id FROM hd_webhook_deliveries q WHERE ${due} AND NOT q.test AND q.hook_id = $3
                         ORDER BY q.next_attempt_at, q.id LIMIT 1 FOR UPDATE)
          ${CLAIM_RETURNING}`,
        [...params, hook_id]
      );
      if (row.rows[0]) return normalizeRow<DeliveryRow>(row.rows[0] as unknown as Record<string, unknown>);
    }
    return undefined;
  });
}

/**
 * Send the deliveries that are due (or only `ids`, when given and due), one
 * claimed row at a time, up to WEBHOOK_WORKERS in parallel on different
 * hooks. Every process may run this at once: a row is claimed by one. `now`
 * only decides which rows are due (tests); attempt times, signatures,
 * backoff and the 24-hour window use the database clock. Resolves to how
 * many attempts were made.
 */
export async function processDueDeliveries(opts: { now?: Date; ids?: number[]; limit?: number } = {}): Promise<number> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const started = Date.now();
  let tried = 0;
  const worker = async () => {
    while (tried < limit && Date.now() - started < passBudgetMs) {
      const d = await claimOne(opts.now ?? null, opts.ids ?? null);
      if (!d) return;
      tried++;
      try {
        await deliverClaimed(d);
      } catch (e) {
        // Put it back for the sweep rather than leave it claimed (only while the claim is still ours).
        logEvent("error", "helpdesk.webhook.deliver_crashed", { delivery: d.id, error: e instanceof Error ? e.message : String(e) });
        await hq("UPDATE hd_webhook_deliveries SET state = 'queued', claimed_at = NULL WHERE id = $1 AND state = 'sending' AND claimed_at::text = $2", [d.id, d.claim]).catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: WEBHOOK_WORKERS }, worker));
  return tried;
}

type Outcome = { error: string; status: number | null; excerpt: string; ms: number | null; attempted: boolean };
const NOT_SENT = (error: string): Outcome => ({ error, status: null, excerpt: "", ms: null, attempted: false });

/** Why a claimed row must not be sent at all (its content is gone or must stay home), or null. */
async function unsendable(d: DeliveryRow, hook: HookSecretRow): Promise<string | null> {
  if (d.payload === null || d.payload === undefined) return "Not sent: nothing left to send.";
  if (d.test) return null;
  if (!hook.enabled) return "The webhook is turned off.";
  if (d.ticket_number === null) return null;
  // ON DELETE SET NULL: the ticket was deleted for good after this was queued.
  if (d.ticket_id === null) return "Not sent: the ticket was deleted.";
  const t = await hqOne<{ binned: string | null }>("SELECT to_jsonb(t) ->> 'deleted_at' AS binned FROM hd_tickets t WHERE t.id = $1", [d.ticket_id]);
  if (!t) return "Not sent: the ticket was deleted.";
  if (t.binned && d.event !== "ticket.deleted") return "Not sent: the ticket is in the recycle bin.";
  return null;
}

async function deliverClaimed(d: DeliveryRow): Promise<void> {
  const hook = await hqOne<HookSecretRow>("SELECT id, name, url, enabled, secret_sealed, failing_since FROM hd_webhooks WHERE id = $1", [d.hook_id]);
  if (!hook) return; // deleted: the row went with it
  const why = await unsendable(d, hook);
  if (why) {
    await finish(d, "failed", NOT_SENT(why));
    return;
  }
  let secret: string;
  try {
    secret = openSecret(hook.secret_sealed);
  } catch {
    await finish(d, "failed", NOT_SENT("The signing secret can't be read (the server's secret key changed). Rotate the secret."));
    return;
  }
  const at = new Date(Number(d.db_now_ms));
  const out = await attempt(hook.url, secret, d.event, d.event_id, Number(d.id), JSON.stringify(d.payload), at);
  const o: Outcome = { error: out.error, status: out.status, excerpt: out.excerpt, ms: out.ms, attempted: true };
  if (out.ok) {
    if ((await finish(d, "delivered", o)) && !d.test) {
      await hq("UPDATE hd_webhooks SET failing_since = NULL WHERE id = $1 AND failing_since IS NOT NULL", [hook.id]);
    }
    return;
  }
  // A test send is tried once and never counts against the hook.
  if (d.test) {
    await finish(d, "failed", o);
    return;
  }
  // The 24-hour window runs from the event: retries are scheduled no later
  // than its end, so one attempt is always made at the end; an attempt made
  // at or after the end that fails is the last.
  const deadline = Date.parse(d.created_at) + HD_API_LIMITS.retryHours * 3_600_000;
  let wrote: boolean;
  if (at.getTime() < deadline) {
    const r = await hqOne<{ id: number }>(
      `UPDATE hd_webhook_deliveries
          SET state = 'queued', claimed_at = NULL, attempts = attempts + 1, last_attempt_at = clock_timestamp(),
              next_attempt_at = LEAST(clock_timestamp() + make_interval(secs => $3), created_at + make_interval(hours => $4)),
              response_status = $5, response_excerpt = $6, error = $7, duration_ms = $8
        WHERE id = $1 AND state = 'sending' AND claimed_at::text = $2 RETURNING id`,
      [d.id, d.claim, nextDelaySeconds(d.attempts + 1), HD_API_LIMITS.retryHours, out.status, out.excerpt, out.error, out.ms]
    );
    wrote = Boolean(r);
  } else {
    wrote = await finish(d, "failed", { ...o, error: `${out.error} Gave up after ${HD_API_LIMITS.retryHours} hours.` });
  }
  // The claim was lost meanwhile (anonymised, turned off, requeued): the outcome is dropped and counts for nothing.
  if (!wrote) return;
  // Failing for 24 hours turns the hook off, decided at every failed attempt (not only when a delivery gives up).
  const f = await hqOne<{ off: boolean }>(
    `UPDATE hd_webhooks SET failing_since = COALESCE(failing_since, $2::timestamptz) WHERE id = $1
     RETURNING failing_since <= $2::timestamptz - make_interval(hours => $3) AS off`,
    [hook.id, at, HD_API_LIMITS.retryHours]
  );
  if (f?.off) await autoDisable(hook);
}

/** Finish a claimed row; false when the claim was no longer ours (the row was finished or requeued elsewhere), and then nothing changes. */
async function finish(d: DeliveryRow, state: Extract<HdDeliveryState, "delivered" | "failed">, o: Outcome): Promise<boolean> {
  const row = await hqOne<{ hook_id: number }>(
    `UPDATE hd_webhook_deliveries
        SET state = $3, payload = NULL, claimed_at = NULL, finished_at = clock_timestamp(),
            last_attempt_at = CASE WHEN $8 THEN clock_timestamp() ELSE last_attempt_at END,
            attempts = attempts + CASE WHEN $8 THEN 1 ELSE 0 END,
            response_status = $4, response_excerpt = $5, error = $6, duration_ms = $7
      WHERE id = $1 AND state = 'sending' AND claimed_at::text = $2 RETURNING hook_id`,
    [d.id, d.claim, state, o.status, o.excerpt, o.error, o.ms, o.attempted]
  );
  if (row) await pruneLog(row.hook_id);
  return Boolean(row);
}

/** Keep the newest finished rows per hook (HD_API_LIMITS.logPerHook); queued ones are never pruned. */
async function pruneLog(hookId: number): Promise<void> {
  await hq(
    `DELETE FROM hd_webhook_deliveries
      WHERE hook_id = $1 AND state IN ('delivered', 'failed')
        AND id NOT IN (SELECT id FROM hd_webhook_deliveries WHERE hook_id = $1 AND state IN ('delivered', 'failed')
                        ORDER BY COALESCE(finished_at, created_at) DESC, id DESC LIMIT $2)`,
    [hookId, HD_API_LIMITS.logPerHook]
  );
}

const AUTO_OFF_REASON = "Turned off after failing for 24 hours.";

async function autoDisable(hook: HookSecretRow): Promise<void> {
  const off = await hqOne<{ id: number }>(
    "UPDATE hd_webhooks SET enabled = false, disabled_reason = $2, updated_at = now() WHERE id = $1 AND enabled RETURNING id",
    [hook.id, AUTO_OFF_REASON]
  );
  if (!off) return;
  await dropQueued(hook.id, "The webhook was turned off after failing for 24 hours.");
  await audit({
    actor: { name: "Helpdesk" },
    action: "helpdesk.webhook.auto_disabled",
    targetType: "helpdesk_webhook",
    targetId: hook.id,
    targetLabel: hookLabel(hook),
    details: { reason: AUTO_OFF_REASON },
  });
  await tellAdmins(hook);
}

/** The desk's admins (settings.manage), each checked with their own workspace role (the legacy break-glass reads it). */
export async function webhookAdminIds(): Promise<number[]> {
  const { listDeskAgents } = await import("./roles-agents");
  const { hdCan } = await import("./roles");
  const ids = (await listDeskAgents()).map((p) => p.user_id);
  if (!ids.length) return [];
  // listDeskAgents' `role` is the desk role; hdCan needs the account's workspace role (users.role).
  const people = await hq<{ id: number; role: Role }>("SELECT id, role FROM users WHERE id = ANY($1::int[]) AND status = 'active' ORDER BY id", [ids]);
  const out: number[] = [];
  for (const p of people) if (await hdCan(p, "settings.manage")) out.push(p.id);
  return out;
}

/** The bell for the desk's admins (catalog event hd_webhook_disabled, bell only). */
async function tellAdmins(hook: HookSecretRow): Promise<void> {
  try {
    const admins = await webhookAdminIds();
    if (!admins.length) return;
    const { notify } = await import("../notifications");
    await notify(admins, {
      kind: "hd_ticket",
      event: "hd_webhook_disabled",
      title: `Webhook turned off: ${hookLabel(hook)}`,
      body: "It failed for 24 hours. Check the endpoint, then turn it back on in Desk settings, API and webhooks.",
      link: "/desk/settings/integrations/api#webhooks",
    });
  } catch (e) {
    logEvent("warn", "helpdesk.webhook.notice_failed", { hook: hook.id, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Fail a hook's queued rows (turned off). A row in flight finishes its one attempt, then is never retried (its hook is off). */
async function dropQueued(hookId: number, why: string): Promise<void> {
  await hq(
    `UPDATE hd_webhook_deliveries SET state = 'failed', payload = NULL, claimed_at = NULL, finished_at = clock_timestamp(), error = $2
      WHERE hook_id = $1 AND state = 'queued'`,
    [hookId, why]
  );
  await pruneLog(hookId);
}

// --- The sweep --------------------------------------------------------------------------

/**
 * The webhook sweep's advisory lock (lib/periodic "hd_webhooks"): only the
 * upkeep (claims left by a process that died) runs under it; the sends
 * themselves are row claims. Listed with the other helpdesk keys beside
 * RECURRING_SWEEP_LOCK (lib/helpdesk/recurring).
 */
export const WEBHOOK_SWEEP_LOCK = 7_281_977;

/**
 * The minute sweep: claims a dead process left (older than the stale
 * threshold) go back to the queue, or fail when nothing is left to send;
 * then the due rows are sent. The tick's own time is not used: the
 * database clock decides what is due.
 */
export async function webhookSweep(_tickTime?: Date): Promise<{ requeued: number; tried: number } | null> {
  const requeued = await withTx(async (client: PoolClient) => {
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [WEBHOOK_SWEEP_LOCK]);
    if (!lock.rows[0]?.ok) return null;
    const r = await client.query(
      `UPDATE hd_webhook_deliveries
          SET state = CASE WHEN payload IS NULL THEN 'failed' ELSE 'queued' END,
              claimed_at = NULL,
              finished_at = CASE WHEN payload IS NULL THEN clock_timestamp() ELSE finished_at END,
              error = CASE WHEN payload IS NULL THEN 'Not sent: nothing left to send.' ELSE error END
        WHERE state = 'sending' AND claimed_at < clock_timestamp() - make_interval(secs => $1)`,
      [staleClaimMs / 1000]
    );
    return r.rowCount ?? 0;
  });
  if (requeued === null) return null;
  const tried = await processDueDeliveries({ limit: 100 });
  return { requeued, tried };
}

// --- Privacy ------------------------------------------------------------------------------

/** Fail undelivered rows matching `where` (its params from $2): their payload is dropped now. */
async function dropPendingTx(client: PoolClient, why: string, where: string, params: unknown[]): Promise<number> {
  const r = await client.query(
    `UPDATE hd_webhook_deliveries SET state = 'failed', payload = NULL, claimed_at = NULL, finished_at = clock_timestamp(), error = $1
      WHERE state IN ('queued', 'sending') AND (${where})`,
    [why, ...params]
  );
  return r.rowCount ?? 0;
}

/**
 * Anonymising a ticket (lib/helpdesk/retention anonymiseTicketTx): an
 * undelivered event still holds its text, so those rows fail now with their
 * payload dropped. Finished rows hold none. A send already in flight
 * finishes its one attempt and its outcome is dropped (the claim is gone).
 */
export async function anonymiseWebhookDeliveriesTx(client: PoolClient, ticketId: number): Promise<void> {
  await dropPendingTx(client, "Not sent: the ticket was anonymised.", "ticket_id = $2", [ticketId]);
}

/** Deleting a ticket for good (lib/helpdesk/retention deleteTicketTx, which the recycle bin's purge uses): its undelivered events go first. */
export async function dropTicketWebhookDeliveriesTx(client: PoolClient, ticketId: number): Promise<void> {
  await dropPendingTx(client, "Not sent: the ticket was deleted.", "ticket_id = $2", [ticketId]);
}

/**
 * Removing an account (retention anonymiseRemovedAccountTx): undelivered
 * events that person caused, that carry a message of theirs that was just
 * blanked, or that name them as the owner, are dropped with their payload.
 */
export async function scrubRemovedAccountWebhookDeliveriesTx(client: PoolClient, userId: number, messageIds: number[]): Promise<number> {
  return dropPendingTx(
    client,
    "Not sent: a person in it was removed.",
    `actor_id = $2
     OR (payload -> 'message' ->> 'id')::bigint = ANY($3::bigint[])
     OR (payload -> 'ticket' -> 'assignee' ->> 'id')::int = $2`,
    [userId, messageIds]
  );
}

// --- Managing hooks (Desk settings → API and webhooks) -------------------------------------

export class WebhookError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface WebhookInput {
  name: string;
  url: string;
  events: HdWebhookEvent[];
  team_ids: number[];
  include_notes: boolean;
}

/** The endpoint's host: what audit rows and bells name. A path or query can carry the receiver's own secret (a "catch" URL), so it never goes there. */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
const hookLabel = (h: { name?: string; url: string }) => (h.name ? h.name : urlHost(h.url)).slice(0, 200);

/** The secret's look: "whsec_" + 32 random bytes in base64url. */
function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** Check a webhook's fields (all of them on create; the ones sent on update). */
export async function validateWebhookInput(raw: Record<string, unknown>, partial = false): Promise<Partial<WebhookInput>> {
  const out: Partial<WebhookInput> = {};
  if (!partial || raw.name !== undefined) {
    if (raw.name !== undefined && raw.name !== null && typeof raw.name !== "string") throw new WebhookError("The name must be text.");
    const name = String(raw.name ?? "").trim();
    if (name.length > HD_API_LIMITS.name) throw new WebhookError(`Keep the name under ${HD_API_LIMITS.name} characters.`);
    out.name = name;
  }
  if (!partial || raw.url !== undefined) out.url = await validateUrl(raw.url);
  if (!partial || raw.events !== undefined) {
    if (!Array.isArray(raw.events)) throw new WebhookError("Choose at least one event.");
    const events = [...new Set(raw.events)];
    if (!events.length) throw new WebhookError("Choose at least one event.");
    if (!events.every(isWebhookEvent)) throw new WebhookError("Unknown event.");
    out.events = events as HdWebhookEvent[];
  }
  if (!partial || raw.team_ids !== undefined) {
    const ids = raw.team_ids ?? [];
    if (!Array.isArray(ids) || !ids.every((n) => Number.isSafeInteger(n) && (n as number) > 0)) throw new WebhookError("Unknown team.");
    const uniq = [...new Set(ids as number[])];
    if (uniq.length) {
      const found = await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1::int[])", [uniq]);
      if (found.length !== uniq.length) throw new WebhookError("Unknown team.");
    }
    out.team_ids = uniq.sort((a, b) => a - b);
  }
  if (!partial || raw.include_notes !== undefined) {
    if (raw.include_notes !== undefined && typeof raw.include_notes !== "boolean") throw new WebhookError("Include internal notes is on or off.");
    out.include_notes = raw.include_notes === true;
  }
  return out;
}

/** https only, no credentials in it, and never an address safe-fetch refuses outright. */
async function validateUrl(raw: unknown): Promise<string> {
  if (typeof raw !== "string" || !raw.trim()) throw new WebhookError("Enter the endpoint's address.");
  const s = raw.trim();
  if (s.length > HD_API_LIMITS.url) throw new WebhookError("That address is too long.");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new WebhookError("That isn't a web address.");
  }
  if (u.protocol !== "https:") throw new WebhookError("Use an https:// address.");
  if (u.username || u.password) throw new WebhookError("Leave the user name and password out of the address: deliveries are signed instead.");
  if (u.hash) throw new WebhookError("Leave the #fragment out of the address.");
  const { assertPublicTarget } = await import("../safe-fetch");
  try {
    await assertPublicTarget(u.toString());
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // A name that doesn't resolve yet may be set up later; blocked addresses never pass.
    if (/^Blocked/.test(msg)) throw new WebhookError(failureSentence(e));
  }
  return u.toString();
}

interface HookListRow {
  id: number;
  name: string;
  url: string;
  events: string[];
  team_ids: number[];
  include_notes: boolean;
  enabled: boolean;
  disabled_reason: string;
  secret_last4: string;
  failing_since: string | null;
  created_at: string;
  created_by_name: string;
  last_at: string | null;
  last_status: number | null;
  last_state: HdDeliveryState | null;
  pending: number;
}

function health(r: HookListRow): HdWebhookHealth {
  if (!r.enabled) return "off";
  if (r.failing_since) return "failing";
  if (!r.last_at) return "new";
  return "ok";
}

export async function listWebhookViews(): Promise<HdWebhookView[]> {
  const [rows, teams] = await Promise.all([
    hq<HookListRow>(
      `SELECT h.id, h.name, h.url, h.events, h.team_ids, h.include_notes, h.enabled, h.disabled_reason, h.secret_last4,
              h.failing_since, h.created_at, h.created_by_name,
              l.at AS last_at, l.response_status AS last_status, l.state AS last_state,
              (SELECT count(*)::int FROM hd_webhook_deliveries q WHERE q.hook_id = h.id AND q.state IN ('queued', 'sending')) AS pending
         FROM hd_webhooks h
         LEFT JOIN LATERAL (
           SELECT COALESCE(d.last_attempt_at, d.finished_at) AS at, d.response_status, d.state
             FROM hd_webhook_deliveries d
            WHERE d.hook_id = h.id AND NOT d.test AND d.last_attempt_at IS NOT NULL
            ORDER BY d.last_attempt_at DESC, d.id DESC LIMIT 1) l ON true
        ORDER BY h.id`
    ),
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams"),
  ]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    events: r.events.filter(isWebhookEvent),
    team_ids: r.team_ids,
    team_names: r.team_ids.map((id) => teamName.get(id)).filter((n): n is string => Boolean(n)),
    include_notes: r.include_notes,
    enabled: r.enabled,
    disabled_reason: r.disabled_reason,
    secret_hint: `whsec_…${r.secret_last4}`,
    health: health(r),
    last_delivery: r.last_at ? { at: r.last_at, status: r.last_status, state: r.last_state ?? "delivered" } : null,
    pending: r.pending,
    created_at: r.created_at,
    created_by_name: r.created_by_name,
  }));
}

export async function getWebhookView(id: number): Promise<HdWebhookView | undefined> {
  return (await listWebhookViews()).find((h) => h.id === id);
}

export async function listDeliveries(hookId: number): Promise<HdDeliveryView[]> {
  const rows = await hq<HdDeliveryView>(
    `SELECT id, event, ticket_number, test, state, attempts, response_status, response_excerpt, error, duration_ms,
            created_at, last_attempt_at, CASE WHEN state = 'queued' THEN next_attempt_at END AS next_attempt_at, finished_at
       FROM hd_webhook_deliveries WHERE hook_id = $1 ORDER BY id DESC LIMIT $2`,
    [hookId, HD_API_LIMITS.logPerHook + 50]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

type Actor = AuditActor & { id: number; name: string };

/**
 * A webhook sends what an agent of its teams sees, so whoever sets one up
 * must work those teams themselves (the token rule, lib/helpdesk/api-tokens):
 * every chosen team is one of theirs, "every team" (no filter) needs every
 * team, and internal notes need Add internal notes in each of them. On an
 * edit, a hook that already reaches further than the editor may not have its
 * address, teams or notes changed by them (it can still be turned off,
 * tested or deleted). Answers the refusal, or null.
 */
async function webhookScopeRefusal(actor: Actor, next: { team_ids: number[]; include_notes: boolean }, before?: { team_ids: number[] }): Promise<string | null> {
  // The workspace role as stored (an audit actor's role is free text): the legacy break-glass reads it.
  const role = (await hqOne<{ role: Role }>("SELECT role FROM users WHERE id = $1", [actor.id]))?.role ?? "viewer";
  const user = { id: actor.id, role };
  const { agentTeamIds } = await import("./access");
  const { hdCan } = await import("./roles");
  const scope = await agentTeamIds(user);
  const covers = (teams: number[]) => scope === "all" || (teams.length > 0 && teams.every((t) => scope.includes(t)));
  if (before && !covers(before.team_ids)) {
    return "This webhook reaches teams you don't work, so you can't change where it sends or what it includes. You can still turn it off or delete it.";
  }
  if (!covers(next.team_ids)) {
    return next.team_ids.length ? "Choose teams you work in." : "Choose at least one team: you don't work every team, so a webhook of yours can't hear about all of them.";
  }
  if (next.include_notes) {
    const ok = scope === "all" ? await hdCan(user, "tickets.internal_note") : (await Promise.all(next.team_ids.map((t) => hdCan(user, "tickets.internal_note", { teamId: t })))).every(Boolean);
    if (!ok) return "You can't add internal notes in all of those teams, so the webhook can't include them.";
  }
  return null;
}

export async function createWebhook(input: WebhookInput, actor: Actor, ip: string | null = null): Promise<{ hook: HdWebhookView; secret: string }> {
  const count = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_webhooks");
  if ((count?.n ?? 0) >= HD_API_LIMITS.webhooks) throw new WebhookError(`A workspace can have up to ${HD_API_LIMITS.webhooks} webhooks.`, 409);
  const refused = await webhookScopeRefusal(actor, input);
  if (refused) throw new WebhookError(refused, 403);
  const secret = newSecret();
  const row = await hqOne<{ id: number }>(
    `INSERT INTO hd_webhooks (name, url, events, team_ids, include_notes, secret_sealed, secret_last4, created_by, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [input.name, input.url, input.events, input.team_ids, input.include_notes, sealSecret(secret), secret.slice(-4), actor.id, actor.name]
  );
  const hook = (await getWebhookView(row!.id))!;
  await audit({
    actor,
    action: "helpdesk.webhook.created",
    targetType: "helpdesk_webhook",
    targetId: hook.id,
    targetLabel: hookLabel(hook),
    details: { host: urlHost(hook.url), events: hook.events, team_ids: hook.team_ids, include_notes: hook.include_notes },
    ip,
  });
  return { hook, secret };
}

export async function updateWebhook(id: number, patch: Partial<WebhookInput> & { enabled?: boolean }, actor: Actor, ip: string | null = null): Promise<HdWebhookView> {
  const before = await getWebhookView(id);
  if (!before) throw new WebhookError("Not found.", 404);
  const sameTeams = patch.team_ids === undefined || JSON.stringify(patch.team_ids) === JSON.stringify(before.team_ids);
  const reaches = (patch.url !== undefined && patch.url !== before.url) || !sameTeams || (patch.include_notes !== undefined && patch.include_notes !== before.include_notes);
  if (reaches) {
    const refused = await webhookScopeRefusal(actor, { team_ids: patch.team_ids ?? before.team_ids, include_notes: patch.include_notes ?? before.include_notes }, before);
    if (refused) throw new WebhookError(refused, 403);
  }
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  const changed: string[] = [];
  if (patch.name !== undefined && patch.name !== before.name) (set("name", patch.name), changed.push("name"));
  if (patch.url !== undefined && patch.url !== before.url) (set("url", patch.url), changed.push("url"));
  if (patch.events !== undefined && JSON.stringify([...patch.events].sort()) !== JSON.stringify([...before.events].sort())) (set("events", patch.events), changed.push("events"));
  if (patch.team_ids !== undefined && JSON.stringify(patch.team_ids) !== JSON.stringify(before.team_ids)) (set("team_ids", patch.team_ids), changed.push("team_ids"));
  if (patch.include_notes !== undefined && patch.include_notes !== before.include_notes) (set("include_notes", patch.include_notes), changed.push("include_notes"));
  if (patch.enabled !== undefined && patch.enabled !== before.enabled) {
    set("enabled", patch.enabled);
    changed.push("enabled");
    // Turned back on: a clean slate. Turned off: nothing more is sent.
    set("disabled_reason", "");
    if (patch.enabled) sets.push("failing_since = NULL");
  }
  if (!sets.length) return before;
  sets.push("updated_at = now()");
  await hq(`UPDATE hd_webhooks SET ${sets.join(", ")} WHERE id = $1`, params);
  if (patch.enabled === false && before.enabled) await dropQueued(id, "The webhook was turned off.");
  const after = (await getWebhookView(id))!;
  await audit({
    actor,
    action: "helpdesk.webhook.updated",
    targetType: "helpdesk_webhook",
    targetId: id,
    targetLabel: hookLabel(after),
    details: {
      changed,
      ...(changed.includes("url") ? { host: urlHost(after.url) } : {}),
      ...(changed.includes("events") ? { events: after.events } : {}),
      ...(changed.includes("team_ids") ? { team_ids: after.team_ids } : {}),
      ...(changed.includes("include_notes") ? { include_notes: after.include_notes } : {}),
      ...(changed.includes("enabled") ? { enabled: after.enabled } : {}),
    },
    ip,
  });
  return after;
}

export async function rotateWebhookSecret(id: number, actor: Actor, ip: string | null = null): Promise<{ hook: HdWebhookView; secret: string }> {
  const secret = newSecret();
  const row = await hqOne<{ id: number; name: string; url: string }>(
    "UPDATE hd_webhooks SET secret_sealed = $2, secret_last4 = $3, updated_at = now() WHERE id = $1 RETURNING id, name, url",
    [id, sealSecret(secret), secret.slice(-4)]
  );
  if (!row) throw new WebhookError("Not found.", 404);
  await audit({ actor, action: "helpdesk.webhook.secret_rotated", targetType: "helpdesk_webhook", targetId: id, targetLabel: hookLabel(row), details: {}, ip });
  return { hook: (await getWebhookView(id))!, secret };
}

export async function deleteWebhook(id: number, actor: Actor, ip: string | null = null): Promise<boolean> {
  const row = await hqOne<{ id: number; name: string; url: string }>("DELETE FROM hd_webhooks WHERE id = $1 RETURNING id, name, url", [id]);
  if (!row) return false;
  await audit({ actor, action: "helpdesk.webhook.deleted", targetType: "helpdesk_webhook", targetId: id, targetLabel: hookLabel(row), details: { host: urlHost(row.url) }, ip });
  return true;
}

/**
 * Test send: one signed `ping` to the endpoint now, logged like any
 * delivery (marked as a test), tried once, never counted against the hook.
 */
export async function testWebhook(id: number, actor: Actor, ip: string | null = null): Promise<HdDeliveryView> {
  const hook = await hqOne<{ id: number; name: string; url: string }>("SELECT id, name, url FROM hd_webhooks WHERE id = $1", [id]);
  if (!hook) throw new WebhookError("Not found.", 404);
  const eventId = `evt_${randomUUID()}`;
  const payload = {
    id: eventId,
    event: "ping",
    created_at: new Date().toISOString(),
    actor: { name: actor.name },
    test: true,
    note: "A test from Desk settings, API and webhooks. Check the signature with your secret; real events have the same envelope.",
  };
  const row = await hqOne<{ id: number }>(
    `INSERT INTO hd_webhook_deliveries (hook_id, event, event_id, test, payload) VALUES ($1, 'ping', $2, true, jsonb_set($3::jsonb, '{created_at}', to_jsonb(now()))) RETURNING id`,
    [id, eventId, JSON.stringify(payload)]
  );
  await processDueDeliveries({ ids: [Number(row!.id)] });
  const out = (await listDeliveries(id)).find((d) => d.id === Number(row!.id));
  await audit({
    actor,
    action: "helpdesk.webhook.tested",
    targetType: "helpdesk_webhook",
    targetId: id,
    targetLabel: hookLabel(hook),
    details: { outcome: out?.state ?? "unknown", status: out?.response_status ?? null },
    ip,
  });
  if (!out) throw new WebhookError("The test couldn't be sent. Try again.", 500);
  return out;
}
