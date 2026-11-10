// Helpdesk 1.19.4 (area C2): the helpdesk REST API, /api/helpdesk/v1.
// Bearer tokens only (lib/helpdesk/api-tokens); session cookies are never
// read on these routes, so there is no CSRF surface and a browser session
// can't call them. Every call acts as the token's service account, so only
// the token role's capabilities in the token's teams apply, checked by the
// same functions the desk's own routes use.
//
// ---------------------------------------------------------------------------
// Routes (OpenAPI-ish). Base: /api/helpdesk/v1. Header: Authorization: Bearer cdh_…
// JSON in, JSON out. Errors: { "error": "<sentence>" }.
//
//   GET   /me
//         → { token: {id, name, expires_at}, acts_as: {name, role, role_label, teams:[{id,name}]}, can: "<line>", capabilities: [...] }
//   GET   /tickets?view=&status=&priority=&team=&assignee=&tag=&q=&created_from=&created_to=&sort=&limit=&cursor=
//         view: open (default; a q without a view searches every status) | all | mine | unassigned | overdue | waiting | workflow | solved_week | team:<id>
//         assignee: <user id> | none.  sort: updated (default) | created | number.  limit 1..100 (25).
//         created_from / created_to: YYYY-MM-DD (the default calendar's zone).
//         → { tickets: [Ticket], total, next_cursor: string | null }
//         Cursor paging: pass next_cursor back (same filters) for the next page. It is
//         offset-based: a ticket that changes while you page may show twice or move pages.
//   GET   /tickets/{number}
//         → Ticket + { messages: [Message] }  Public replies and status lines always; internal
//           notes (and replies held for review, with review_state) only if the role can add
//           internal notes in the ticket's team.
//   PATCH /tickets/{number}  { status?, priority?, team_id?, assignee_id?, tags? }
//         Each change needs the desk capability for it (Change status, Change priority,
//         Transfer to another team, Assign within their teams / Assign to anyone); tags need
//         only that the token works the ticket. → { ticket: Ticket, changed: [...] }
//   POST  /tickets/{number}/notes  { body }          (Add internal notes) → 201 { message }
//   POST  /tickets/{number}/replies  { body, status? }
//         A public reply to the requester (Reply to the requester, or Reply after review: then
//         it is held for a lead, held: true, and nothing is sent yet). status sets the status
//         in the same step (Change status). → 201 { message, held, status }
//   GET   /approvals → { approvals: [...] }  pending approvals on requests in the token's queues
//   GET   /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&team=<id>
//         The Claude connector's hd_report numbers. Every team needs All reports; team=<id>
//         needs Team reports in that team. → { from, to, timezone, created, solved, ... }
//
// Answers: 401 for a missing, malformed, unknown, revoked or expired token (one sentence for
// all); 402 when the helpdesk isn't licensed; 404 for a ticket that doesn't exist, that the
// token can't work, or that is in the recycle bin (the same sentence, so numbers reveal
// nothing); 403 only for a ticket the token can work but a change its role may not make;
// 409 for a merged ticket, a workflow task's missing hand-off or required checklist items;
// 429 over 120 calls a minute per token (Retry-After), or 30 failed token checks a minute
// from one address (only failed checks count; a valid token is never refused for them).
// ---------------------------------------------------------------------------
//
// Audit: every call is one audit row with the token's id and name, the
// method and route, the status and the outcome. Writes are recorded under
// their own actions (helpdesk.ticket.updated, helpdesk.note.added,
// helpdesk.reply.added, with via "api"); anything else is helpdesk.api.call.
// Successful reads are throttled: the first GET of a route per token per
// minute is recorded, later ones in that minute are not (a script polling a
// queue would otherwise fill the log). Refused calls are always recorded.
//
// Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { audit, ipFrom } from "../audit";
import { logEvent } from "../log";
import { agentTeamIds, canWorkTicket, hdRateLimited, helpdeskLicensed, HD_LICENCE_ERROR, messagePostLimited } from "./access";
import { hdCan, hdCapsFor, HD_FORBIDDEN, HD_ROLE_LABEL } from "./roles";
import { principalForToken, apiCanLine, type ApiPrincipal } from "./api-tokens";
import { HD_API_LIMITS } from "./api-shared";
import { hq, hqOne } from "./db-core";
import {
  getTicketByNumber,
  HdTicketError,
  isPriorityValue,
  isStatus,
  listTickets,
  parseTicketNumber,
  parseView,
  TICKET_LIMITS,
  updateTicket,
  validateTicketPatch,
  type TicketListFilters,
} from "./tickets";
import { addMessage, listMessages, MESSAGE_LIMITS } from "./messages";
import { textField } from "./routes";
import type { HdMessage, HdTicket, HdTicketListRow } from "./types";

// --- Plumbing ---------------------------------------------------------------------------

export interface ApiCtx {
  req: Request;
  p: ApiPrincipal;
  /** The service account, as hdCan and friends take it. */
  user: ApiPrincipal["user"];
  origin: string;
}

/** What a handler answers. `audit` names a write's own action; otherwise the call is helpdesk.api.call. */
export interface ApiOut {
  status: number;
  body: unknown;
  /** The ticket the call is about (the audit row's target, so anonymising the ticket redacts it). */
  ticket?: { id: number; number: number; subject: string };
  audit?: { action: string; details: Record<string, unknown> };
  headers?: Record<string, string>;
}

const json = (status: number, error: string): ApiOut => ({ status, body: { error } });
export const NO_TICKET = (n: unknown) => json(404, `No ticket #${String(n).replace(/[^0-9]/g, "").slice(0, 12) || "?"}.`);
const UNAUTHORISED = "Invalid or missing API token. Send Authorization: Bearer <token>.";

// Failed token checks per address: peeked before anything is read, bumped on a failure.
const authFails = new Map<string, { count: number; resetAt: number }>();
function failCount(key: string, now = Date.now()): number {
  const w = authFails.get(key);
  return w && now < w.resetAt ? w.count : 0;
}
function bumpFail(key: string, now = Date.now()): void {
  let w = authFails.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + 60_000 };
    authFails.set(key, w);
  }
  w.count++;
  if (authFails.size > 20_000) for (const [k, v] of authFails) if (now >= v.resetAt) authFails.delete(k);
}

/** Tests: forget the failed-check counters. */
export function resetApiAuthFailsForTests(): void {
  authFails.clear();
  readAudits.clear();
}

// One recorded successful GET per token and route per minute.
const readAudits = new Map<string, number>();
function auditThisRead(key: string, now = Date.now()): boolean {
  const minute = Math.floor(now / 60_000);
  if (readAudits.get(key) === minute) return false;
  readAudits.set(key, minute);
  if (readAudits.size > 20_000) for (const [k, v] of readAudits) if (v < minute) readAudits.delete(k);
  return true;
}

function bearer(req: Request): string {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : "";
}

function originOf(req: Request): string {
  try {
    const h = req.headers;
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
    return host ? `${proto}://${host}` : new URL(req.url).origin;
  } catch {
    return "";
  }
}

/**
 * Run one API call: licence (402), the failed-check budget (429), the token
 * (401), the token's rate limit (429), then the handler; one audit row.
 * `route` is the route's template ("PATCH /tickets/{number}").
 */
export async function apiV1(req: Request, route: string, handler: (ctx: ApiCtx) => Promise<ApiOut>): Promise<NextResponse> {
  if (!(await helpdeskLicensed())) return NextResponse.json({ error: HD_LICENCE_ERROR }, { status: 402 });
  const ip = ipFrom(req);
  // The token first: a valid token is never refused because of other callers'
  // failures from the same address (a stale script, a shared NAT). Only a
  // failed check counts, and only against a known address: a request with no
  // client address has no budget of its own to share with everyone else.
  const p = await principalForToken(bearer(req));
  if (!p) {
    const ipKey = ip ? `ip:${ip}` : null;
    if (ipKey && failCount(ipKey) >= HD_API_LIMITS.authFailsPerMinute) {
      return NextResponse.json({ error: "Too many failed token checks. Wait a minute." }, { status: 429, headers: { "retry-after": "60" } });
    }
    if (ipKey) bumpFail(ipKey);
    // One row per address a minute at most, so a flood of bad tokens can't fill the log.
    if (auditThisRead(`fail:${ipKey ?? "no-address"}`)) {
      await audit({ actor: { name: "Helpdesk API" }, action: "helpdesk.api.call", targetType: "helpdesk_api_token", targetLabel: "Unknown token", details: { route, status: 401, outcome: "unauthorised" }, ip });
    }
    return NextResponse.json({ error: UNAUTHORISED }, { status: 401, headers: { "www-authenticate": 'Bearer realm="helpdesk"' } });
  }
  const actor = { id: p.user.id, name: p.user.name, role: p.user.role };
  const base = { token_id: p.token_id, token_name: p.token_name, route, via: "api" };
  if (hdRateLimited(`hd-api:${p.token_id}`, HD_API_LIMITS.perMinute, 60_000)) {
    if (auditThisRead(`limit:${p.token_id}`)) {
      await audit({ actor, action: "helpdesk.api.call", targetType: "helpdesk_api_token", targetId: p.token_id, targetLabel: p.token_name, details: { ...base, status: 429, outcome: "rate_limited" }, ip });
    }
    return NextResponse.json({ error: `Rate limit: ${HD_API_LIMITS.perMinute} calls a minute per token.` }, { status: 429, headers: { "retry-after": "60" } });
  }
  let out: ApiOut;
  try {
    out = await handler({ req, p, user: p.user, origin: originOf(req) });
  } catch (e) {
    if (e instanceof HdTicketError) out = { status: e.status, body: { error: e.message } };
    else if (e instanceof BodyError) out = json(e.status, e.message);
    else {
      logEvent("error", "helpdesk.api.failed", { route, error: e instanceof Error ? e.message : String(e) });
      out = json(500, "Something went wrong. Try again.");
    }
  }
  const ok = out.status < 400;
  const target = out.ticket
    ? { targetType: "helpdesk_ticket", targetId: out.ticket.id, targetLabel: `#${out.ticket.number} ${out.ticket.subject}`.slice(0, 200) }
    : { targetType: "helpdesk_api_token", targetId: p.token_id, targetLabel: p.token_name };
  if (ok && out.audit) {
    await audit({ actor, action: out.audit.action, ...target, details: { ...out.audit.details, ...base, status: out.status }, ip });
  } else if (!ok || req.method !== "GET" || auditThisRead(`${p.token_id}:${route}`)) {
    const outcome = ok ? "ok" : out.status === 404 ? "not_found" : out.status === 403 ? "forbidden" : out.status === 429 ? "rate_limited" : out.status >= 500 ? "error" : "refused";
    await audit({ actor, action: "helpdesk.api.call", ...target, details: { ...base, status: out.status, outcome }, ip });
  }
  return NextResponse.json(out.body, { status: out.status, headers: out.headers });
}

class BodyError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** A JSON object body of at most `max` bytes, however it is sent (a chunked body is counted as it arrives). */
export async function readBody(req: Request, max = 64 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > max) throw new BodyError("The body is too large.", 413);
  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new BodyError("The body is too large.", 413);
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  }
  try {
    const v = JSON.parse(text || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* below */
  }
  throw new BodyError("Send a JSON object.");
}

// --- Shapes -----------------------------------------------------------------------------

function ticketSummary(t: HdTicket | HdTicketListRow, origin: string, requesterEmail?: string) {
  return {
    number: t.number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    team: t.team_id ? { id: t.team_id, name: t.team_name ?? "" } : null,
    // 1.20.2 (additive): the help address the ticket came in on or is answered from; null = it has none of its own.
    mailbox: t.mailbox_id && t.mailbox_address ? { id: t.mailbox_id, address: t.mailbox_address, name: t.mailbox_name ?? "" } : null,
    assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name ?? "" } : null,
    requester: { name: t.requester_name, ...(requesterEmail !== undefined ? { email: requesterEmail } : {}) },
    tags: t.tags ?? [],
    category: t.category || null,
    source: t.source,
    in_workflow: t.in_workflow,
    due: t.due_label || null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    url: `${origin}/desk/tickets/${t.number}`,
  };
}

function ticketFull(t: HdTicket, origin: string) {
  return {
    ...ticketSummary(t, origin, t.requester_email),
    request_type: t.request_type_title,
    first_reply_due: t.first_reply_due,
    resolve_due: t.resolve_due,
    first_replied_at: t.first_replied_at,
    solved_at: t.solved_at,
    closed_at: t.closed_at,
    ...(t.merged_into ? { merged: true } : {}),
  };
}

function messageOut(m: HdMessage, withReview: boolean) {
  const review = m.review_state ?? null;
  return {
    id: m.id,
    kind: m.kind,
    author: { name: m.author_name },
    via: m.via,
    body: m.body,
    attachments: (m.attachments ?? []).map((a) => a.name),
    created_at: m.created_at,
    ...(withReview && review ? { review_state: review } : {}),
  };
}

// --- Loading a ticket ---------------------------------------------------------------------

/** In the recycle bin (1.19.4 C7)? Read through to_jsonb so this works before and after that column exists. */
async function binned(ticketId: number): Promise<boolean> {
  const r = await hqOne<{ d: string | null }>("SELECT to_jsonb(t) ->> 'deleted_at' AS d FROM hd_tickets t WHERE t.id = $1", [ticketId]);
  return Boolean(r?.d);
}

/** The ticket the token works, or undefined (missing, out of its queues, or binned: the same answer). */
export async function workTicket(user: ApiPrincipal["user"], raw: string): Promise<HdTicket | undefined> {
  const n = parseTicketNumber(raw);
  if (!n) return undefined;
  const t = await getTicketByNumber(n);
  if (!t) return undefined;
  if (!(await canWorkTicket(user, t))) return undefined;
  if (t.deleted_at || (await binned(t.id))) return undefined;
  return t;
}

const ref = (t: { id: number; number: number; subject: string }) => ({ id: t.id, number: t.number, subject: t.subject });

// --- Handlers ------------------------------------------------------------------------------

export async function getMe(ctx: ApiCtx): Promise<ApiOut> {
  const v = await hdCapsFor(ctx.user);
  const teams = ctx.p.team_ids.length
    ? await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE id = ANY($1::int[]) ORDER BY position, name", [ctx.p.team_ids])
    : [];
  return {
    status: 200,
    body: {
      token: { id: ctx.p.token_id, name: ctx.p.token_name, expires_at: ctx.p.expires_at },
      acts_as: { name: ctx.user.name, role: ctx.p.role, role_label: HD_ROLE_LABEL[ctx.p.role], teams },
      can: apiCanLine(v.caps),
      capabilities: v.caps,
    },
  };
}

const SORTS = ["updated", "created", "number"] as const;

function encodeCursor(offset: number, key: string): string {
  return Buffer.from(JSON.stringify({ o: offset, k: key })).toString("base64url");
}

function decodeCursor(raw: string, key: string): number | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (v && Number.isSafeInteger(v.o) && v.o >= 0 && v.o <= 100_000 && v.k === key) return v.o;
  } catch {
    /* below */
  }
  return null;
}

export async function listTicketsRoute(ctx: ApiCtx): Promise<ApiOut> {
  const sp = new URL(ctx.req.url).searchParams;
  const f: TicketListFilters = {};
  const view = sp.get("view");
  if (view) {
    const v = parseView(view);
    if (!v) return json(400, "Unknown view. Use open, all, mine, unassigned, overdue, waiting, workflow, solved_week or team:<id>.");
    f.view = v;
  }
  const status = sp.get("status");
  if (status) {
    if (!isStatus(status)) return json(400, "Unknown status.");
    f.status = status;
    f.view ??= "all";
  }
  const priority = sp.get("priority");
  if (priority) {
    if (!isPriorityValue(priority)) return json(400, "Unknown priority.");
    f.priority = priority;
  }
  const team = sp.get("team");
  if (team) {
    if (!/^\d{1,9}$/.test(team)) return json(400, "Unknown team.");
    f.team_id = Number(team);
  }
  const assignee = sp.get("assignee");
  if (assignee) {
    if (assignee === "none") f.assignee = "none";
    else if (/^\d{1,9}$/.test(assignee)) f.assignee = Number(assignee);
    else return json(400, "Unknown assignee. Use a user id or none.");
  }
  const tag = sp.get("tag");
  if (tag) f.tag = tag.slice(0, 80);
  for (const k of ["created_from", "created_to"] as const) {
    const v = sp.get(k);
    if (v) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return json(400, `${k} is a date: YYYY-MM-DD.`);
      f[k] = v;
    }
  }
  const sort = sp.get("sort") ?? "updated";
  if (!(SORTS as readonly string[]).includes(sort)) return json(400, "Unknown sort. Use updated, created or number.");
  f.sort = sort as (typeof SORTS)[number];
  f.q = (sp.get("q") ?? "").slice(0, TICKET_LIMITS.q);
  const limitRaw = sp.get("limit");
  const limit = limitRaw === null ? 25 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return json(400, "limit is 1 to 100.");
  // The cursor is tied to the filters it was made for.
  const key = [...sp.entries()].filter(([k]) => k !== "cursor" && k !== "limit").sort().map(([k, v]) => `${k}=${v}`).join("&");
  let offset = 0;
  const cursor = sp.get("cursor");
  if (cursor) {
    const o = decodeCursor(cursor, key);
    if (o === null) return json(400, "That cursor doesn't belong to these filters. Start again without one.");
    offset = o;
  }
  f.limit = limit;
  f.offset = offset;
  const { rows, total } = await listTickets(ctx.user, f);
  const next = offset + rows.length < total && rows.length === limit ? encodeCursor(offset + rows.length, key) : null;
  return { status: 200, body: { tickets: rows.map((r) => ticketSummary(r, ctx.origin)), total, next_cursor: next } };
}

export async function getTicketRoute(ctx: ApiCtx, number: string): Promise<ApiOut> {
  const t = await workTicket(ctx.user, number);
  if (!t) return NO_TICKET(number);
  const notes = await hdCan(ctx.user, "tickets.internal_note", { teamId: t.team_id });
  const messages = (await listMessages(t.id)).filter((m) => {
    const held = m.review_state === "pending" || m.review_state === "returned";
    if (m.kind === "internal" || held) return notes;
    return m.kind === "public" || m.kind === "system";
  });
  return {
    status: 200,
    ticket: ref(t),
    body: { ...ticketFull(t, ctx.origin), internal_notes_included: notes, messages: messages.map((m) => messageOut(m, notes)) },
  };
}

const PATCH_KEYS = ["status", "priority", "team_id", "assignee_id", "tags"] as const;

export async function patchTicketRoute(ctx: ApiCtx, number: string): Promise<ApiOut> {
  const t = await workTicket(ctx.user, number);
  if (!t) return NO_TICKET(number);
  const b = await readBody(ctx.req, 16 * 1024);
  const unknown = Object.keys(b).filter((k) => !(PATCH_KEYS as readonly string[]).includes(k));
  if (unknown.length) return json(400, `Only ${PATCH_KEYS.join(", ")} can be changed here (not ${unknown.join(", ")}).`);
  if (!Object.keys(b).length) return json(400, `Say what to change: ${PATCH_KEYS.join(", ")}.`);
  const patch = validateTicketPatch(b);
  const { patchRefusal } = await import("./patch-caps");
  const refused = await patchRefusal(ctx.user as never, t, patch);
  if (refused) return { ...json(403, refused), ticket: ref(t) };
  const { mergedLock } = await import("./merge");
  if (patch.status !== undefined && patch.status !== t.status) {
    const locked = await mergedLock(t);
    if (locked) return { ...json(409, locked), ticket: ref(t) };
  }
  if (t.source === "workflow" && (patch.status === "solved" || patch.status === "closed") && patch.status !== t.status) {
    const { validateTaskSolve } = await import("./engine");
    const missing = await validateTaskSolve(t.id);
    if (missing) return { status: 409, body: missing, ticket: ref(t) };
  }
  const r = await updateTicket(t.id, patch, { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role, via: "api" }, { origin: ctx.origin });
  if (!r) return NO_TICKET(number);
  if (r.changed.includes("assignee_id")) {
    const { recordManualAssignment } = await import("./assignment/engine");
    void recordManualAssignment(r.ticket.id, { fromUserId: r.before.assignee_id, toUserId: r.ticket.assignee_id, teamId: r.ticket.team_id, actorId: ctx.user.id });
  }
  return {
    status: 200,
    ticket: ref(r.ticket),
    body: { ticket: ticketFull(r.ticket, ctx.origin), changed: r.changed },
    audit: { action: "helpdesk.ticket.updated", details: { number: t.number, changed: r.changed } },
  };
}

export async function addNoteRoute(ctx: ApiCtx, number: string): Promise<ApiOut> {
  if (messagePostLimited(ctx.user.id)) return json(429, "Too many messages. Wait a moment and try again.");
  const t = await workTicket(ctx.user, number);
  if (!t) return NO_TICKET(number);
  if (!(await hdCan(ctx.user, "tickets.internal_note", { teamId: t.team_id }))) return { ...json(403, HD_FORBIDDEN), ticket: ref(t) };
  const { mergedLock } = await import("./merge");
  const locked = await mergedLock(t);
  if (locked) return { ...json(409, locked), ticket: ref(t) };
  const b = await readBody(ctx.req, 128 * 1024);
  const body = textField(b.body, MESSAGE_LIMITS.body);
  if (body === null) return json(400, "The note is too long.");
  if (!body) return json(400, "Write the note (body).");
  const res = await addMessage(
    t.id,
    { kind: "internal", body, author: { id: ctx.user.id, name: ctx.user.name, email: "" }, via: "api", asRequester: false },
    { origin: ctx.origin, noAutoFollow: true }
  );
  if (!res) return NO_TICKET(number);
  return {
    status: 201,
    ticket: ref(t),
    body: { message: messageOut(res.message, true) },
    audit: { action: "helpdesk.note.added", details: { number: t.number, message_id: res.message.id } },
  };
}

export async function addReplyRoute(ctx: ApiCtx, number: string): Promise<ApiOut> {
  if (messagePostLimited(ctx.user.id)) return json(429, "Too many messages. Wait a moment and try again.");
  const t = await workTicket(ctx.user, number);
  if (!t) return NO_TICKET(number);
  const b = await readBody(ctx.req, 128 * 1024);
  if (b.status !== undefined && !isStatus(b.status)) return json(400, "Unknown status.");
  const teamId = t.team_id;
  const may = (await hdCan(ctx.user, "tickets.reply_public", { teamId })) || (await hdCan(ctx.user, "tickets.reply_needs_review", { teamId }));
  if (!may || (b.status !== undefined && !(await hdCan(ctx.user, "tickets.change_status", { teamId })))) return { ...json(403, HD_FORBIDDEN), ticket: ref(t) };
  const { mergedLock } = await import("./merge");
  const locked = await mergedLock(t);
  if (locked) return { ...json(409, locked), ticket: ref(t) };
  const body = textField(b.body, MESSAGE_LIMITS.body);
  if (body === null) return json(400, "The reply is too long.");
  if (!body) return json(400, "Write the reply (body).");
  const thenStatus = b.status as HdTicket["status"] | undefined;
  if (t.source === "workflow" && (thenStatus === "solved" || thenStatus === "closed") && thenStatus !== t.status) {
    const { validateTaskSolve } = await import("./engine");
    const missing = await validateTaskSolve(t.id);
    if (missing) return { status: 409, body: missing, ticket: ref(t) };
  }
  const checklists = await import("./checklists");
  if (checklists.solvesForChecklists(t.status, thenStatus)) {
    const held = await checklists.checklistSolveRefusal(t.id);
    if (held) return { status: 409, body: held, ticket: ref(t) };
  }
  const res = await addMessage(
    t.id,
    { kind: "public", body, author: { id: ctx.user.id, name: ctx.user.name, email: "" }, via: "api", asRequester: false, then_status: thenStatus },
    { origin: ctx.origin, noAutoFollow: true }
  );
  if (!res) return NO_TICKET(number);
  return {
    status: 201,
    ticket: ref(t),
    body: { message: messageOut(res.message, true), held: res.held, status: res.status, ...(res.status_unchanged ? { status_unchanged: res.status_unchanged } : {}) },
    audit: { action: "helpdesk.reply.added", details: { number: t.number, message_id: res.message.id, held: res.held } },
  };
}

export async function listApprovalsRoute(ctx: ApiCtx): Promise<ApiOut> {
  const { listDeskApprovals } = await import("./approvals");
  const rows = await listDeskApprovals(ctx.user, await agentTeamIds(ctx.user));
  return {
    status: 200,
    body: {
      approvals: rows.map((a) => ({
        id: a.id,
        step: a.step_title,
        ticket: { number: a.ticket_number, subject: a.subject, url: `${ctx.origin}/desk/tickets/${a.ticket_number}` },
        request_type: a.request_type_title,
        requester: { name: a.requester_name },
        waiting_since: a.created_at,
        answers: a.answers,
      })),
    },
  };
}

export async function reportSummaryRoute(ctx: ApiCtx): Promise<ApiOut> {
  const sp = new URL(ctx.req.url).searchParams;
  const { getHelpdeskSettings } = await import("./settings");
  const { parseReportRange, reportSummary } = await import("./reports");
  const p = new URLSearchParams();
  for (const k of ["from", "to", "team"]) {
    const v = sp.get(k);
    if (v) p.set(k, v);
  }
  const settings = await getHelpdeskSettings();
  const parsed = parseReportRange(p, settings.timezone);
  if (!parsed.ok) return json(400, parsed.error);
  const range = parsed.range;
  const allowed = range.team_id ? await hdCan(ctx.user, "reports.team", { teamId: range.team_id }) : await hdCan(ctx.user, "reports.all");
  if (!allowed) return json(403, `${HD_FORBIDDEN} (${range.team_id ? "Team reports" : "All reports"})`);
  if (hdRateLimited(`hd-api-report:${ctx.p.token_id}`, 30, 60_000)) return { ...json(429, "Too many reports. Try again in a minute."), headers: { "retry-after": "60" } };
  const r = await reportSummary({ from: range.from, to: range.to, team_id: range.team_id, assignee_id: range.assignee_id });
  return {
    status: 200,
    body: {
      from: r.from,
      to: r.to,
      timezone: settings.timezone,
      scope: range.team_id ? { team_id: range.team_id } : "every team",
      created: r.created,
      solved: r.solved,
      first_reply_median_minutes: r.first_reply_median_minutes,
      resolution_median_minutes: r.resolution_median_minutes,
      sla_met_percent: r.sla_met_percent,
      csat_percent: r.csat_percent,
      csat_average: r.csat_average ?? null,
      csat_responses: r.csat_responses,
      by_team: r.by_team.slice(0, 50),
      by_agent: r.by_agent.slice(0, 50),
      by_category: r.by_category.slice(0, 50),
      note: "Times are business minutes in each team's calendar.",
    },
  };
}
