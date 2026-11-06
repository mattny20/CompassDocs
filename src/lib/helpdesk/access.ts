// Helpdesk 1.19.0: who may do what. Every helpdesk route, page and module
// asks here; nothing else decides.
//
//   requester  helpdesk.request (every built-in role): Get help, raise and
//              follow their own requests. Sees public and requester-visible
//              system messages only, never internal notes or internal
//              fields (requesterSafe).
//   agent      helpdesk.agent: works the tickets of the teams they belong to
//              (hd_team_members) plus tickets assigned to them. Their own
//              requests always, as a requester.
//   agent_all  helpdesk.agent_all: every team's tickets.
//   admin      helpdesk.admin: configuration (and reports). Configuring is
//              not working: an admin without an agent key does not see
//              tickets in the desk.
//   reports    helpdesk.reports (or admin): reports.
//   approver   anyone named on an approval of the request (directly, as a
//              member of the approving team): reads the request's answers
//              and public conversation, as a requester would, to decide.
//
// The legacy break-glass (COMPASSDOCS_AUTHZ_LEGACY) keeps request at viewer
// and everything else at admin. Everything is licence-gated on "helpdesk".
// Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { cache } from "react";
import { crossOriginRejection } from "../api-auth";
import { getCurrentUser } from "../auth";
import { featureEnabled } from "../ee";
import { userHolds } from "../access";
import type { Role, SessionUser } from "../types";
import type { PermissionKey } from "../permissions";
import { hq } from "./db-core";
import { hdCan, hdLeadTeamIds, hdRoleOf } from "./roles";
import { HD_IN_WORKFLOW_LABEL, HD_STATUS_LABEL_REQUESTER } from "./types";
import type { HdMessage, HdRequestSummary, HdTicket, HdTicketRow } from "./types";

type U = { id: number; role: Role };

export const HD_LICENCE_ERROR = "The helpdesk is not included in your licence.";

export function helpdeskLicensed(): Promise<boolean> {
  return featureEnabled("helpdesk");
}

/** Holds a helpdesk key (break-glass: request = viewer, the rest = admin). */
export async function hdHolds(user: U, key: PermissionKey): Promise<boolean> {
  return userHolds(user, key, { legacyMin: key === "helpdesk.request" ? "viewer" : "admin" });
}

/** Licensed and holds helpdesk.request. */
export async function canUseHelpdesk(user: U): Promise<boolean> {
  return (await helpdeskLicensed()) && (await hdHolds(user, "helpdesk.request"));
}

// The desk-side questions below delegate to the desk role ladder
// (lib/helpdesk/roles, agent J). Its derived roles reproduce the answers
// these gave from the workspace keys alone (helpdesk.agent / agent_all /
// admin / reports), so nobody loses access; an assigned desk role adds to
// them (test/helpdesk-roles.test.ts pins both).

/** Has a desk role (assigned, or derived from helpdesk.agent / agent_all / admin). Does not check the licence. */
export async function isAgent(user: U): Promise<boolean> {
  return (await hdRoleOf(user)) !== null;
}

/** Sees every team's tickets: helpdesk.agent_all, or a desk role with tickets.view_all. */
export function hasAgentAll(user: U): Promise<boolean> {
  return hdCan(user, "tickets.view_all");
}

/** Desk Admin (settings.manage): a workspace helpdesk.admin holder always is. */
export function isHelpdeskAdmin(user: U): Promise<boolean> {
  return hdCan(user, "settings.manage");
}

/** Reads every report: helpdesk.reports, desk Admin, or a role with reports.all. */
export async function canReadReports(user: U): Promise<boolean> {
  return hdCan(user, "reports.all");
}

/** The teams this person belongs to (any role), whatever their keys. */
export const memberTeamIds = cache(async (userId: number): Promise<number[]> => {
  const rows = await hq<{ team_id: number }>("SELECT team_id FROM hd_team_members WHERE user_id = $1 ORDER BY team_id", [userId]);
  return rows.map((r) => r.team_id);
});

/**
 * The teams this person leads: every team of an assigned Team lead, none
 * for another assigned role, else the teams where hd_team_members says lead
 * (the desk keeps that column in step with assigned roles).
 */
export async function leadTeamIds(userId: number): Promise<number[]> {
  return hdLeadTeamIds(userId);
}

/**
 * The queues an agent works: "all" with tickets.view_all (agent_all), their
 * teams with tickets.view_team ("See their teams' queues" on the Roles
 * page), [] otherwise. Tickets assigned to them come on top
 * (canWorkTicket, tickets scopeSql), whatever the matrix says.
 */
export async function agentTeamIds(user: U): Promise<number[] | "all"> {
  if (await hasAgentAll(user)) return "all";
  if (!(await isAgent(user))) return [];
  if (!(await hdCan(user, "tickets.view_team"))) return [];
  return memberTeamIds(user.id);
}

type TicketRef = Pick<HdTicketRow, "id" | "requester_id" | "team_id" | "assignee_id">;

/** May this person work (agent view, reply, change fields of) the ticket? */
export async function canWorkTicket(user: U, ticket: TicketRef): Promise<boolean> {
  const teams = await agentTeamIds(user);
  if (teams === "all") return true;
  if (!(await isAgent(user))) return false;
  if (ticket.assignee_id === user.id) return true;
  return ticket.team_id !== null && teams.includes(ticket.team_id);
}

/**
 * Is this person an approver of the ticket (named, of the approving team,
 * the manager fallback's leads, a space-access manager, or the one who
 * decided)? The rule is B's (lib/helpdesk/approvals isApproverFor), so the
 * approvals list and this read always agree.
 */
export async function isApproverOf(userId: number, ticketId: number): Promise<boolean> {
  const { isApproverFor } = await import("./approvals");
  return isApproverFor(userId, ticketId);
}

export type TicketRelation = "agent" | "requester" | "approver" | "cc";

/**
 * How this person reaches the ticket, strongest first: agent (works it),
 * requester (their own), approver (decides a step of it), cc (copied on it,
 * 1.19.1 lib/helpdesk/ccs: reads it as the requester does, public
 * conversation only); null = not at all.
 */
export async function ticketRelation(user: U, ticket: TicketRef): Promise<TicketRelation | null> {
  if (await canWorkTicket(user, ticket)) return "agent";
  if (ticket.requester_id !== null && ticket.requester_id === user.id) return "requester";
  if (await isApproverOf(user.id, ticket.id)) return "approver";
  if (await isCcOfTicket(user.id, ticket.id)) return "cc";
  return null;
}

/** Copied on the ticket (lib/helpdesk/ccs, agent V3). */
async function isCcOfTicket(userId: number, ticketId: number): Promise<boolean> {
  const { isCcOf } = await import("./ccs");
  return isCcOf(userId, ticketId);
}

/** May this person see the ticket in any form (agent, requester, approver or CC)? */
export async function canSeeTicket(user: U, ticket: TicketRef): Promise<boolean> {
  return (await ticketRelation(user, ticket)) !== null;
}

/**
 * Messages a requester (or an approver) may read: public and system, never
 * internal, and never a newbie's reply still held for review or returned
 * (review_state 'pending' / 'returned', lib/helpdesk/review). The review
 * columns are agent-side and are stripped.
 */
export function requesterMessages(messages: HdMessage[]): HdMessage[] {
  return messages
    .filter((m) => m.kind === "public" || m.kind === "system")
    .filter((m) => {
      const state = (m as { review_state?: string | null }).review_state;
      return state !== "pending" && state !== "returned";
    })
    .map((m) => {
      const { review_state: _s, reviewed_by: _b, reviewed_at: _a, review_note: _n, ...rest } = m as HdMessage & {
        review_state?: unknown;
        reviewed_by?: unknown;
        reviewed_at?: unknown;
        review_note?: unknown;
      };
      return { ...(rest as HdMessage), email_message_id: null };
    });
}

/**
 * The requester-safe view of a ticket and its messages: the summary fields
 * only (no tags, assignee, SLA internals, reply token, internal notes).
 */
export function requesterSafe(
  ticket: Pick<
    HdTicket,
    | "number"
    | "subject"
    | "status"
    | "in_workflow"
    | "team_name"
    | "request_type_title"
    | "source"
    | "created_at"
    | "updated_at"
    | "solved_at"
    | "csat_score"
  >,
  messages: HdMessage[]
): { summary: HdRequestSummary; messages: HdMessage[] } {
  const safe = requesterMessages(messages);
  const lastPublic = [...safe].reverse().find((m) => m.kind === "public");
  return {
    summary: {
      number: ticket.number,
      subject: ticket.subject,
      status: ticket.status,
      status_label: ticket.in_workflow ? HD_IN_WORKFLOW_LABEL : HD_STATUS_LABEL_REQUESTER[ticket.status],
      in_workflow: ticket.in_workflow,
      team_name: ticket.team_name,
      request_type_title: ticket.request_type_title,
      source: ticket.source,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      solved_at: ticket.solved_at,
      csat_score: ticket.csat_score,
      last_public_author: lastPublic?.author_name ?? null,
      last_public_at: lastPublic?.created_at ?? null,
    },
    messages: safe,
  };
}

// --- Route guard ---------------------------------------------------------------

/** What a route needs: request (Get help), agent (the desk), admin (configuration), reports. */
export type HdLevel = "request" | "agent" | "admin" | "reports";

async function holdsLevel(user: U, level: HdLevel): Promise<boolean> {
  switch (level) {
    case "request":
      return hdHolds(user, "helpdesk.request");
    case "agent":
      return isAgent(user);
    case "admin":
      return isHelpdeskAdmin(user);
    case "reports":
      return canReadReports(user);
  }
}

/**
 * The guard at the top of every helpdesk route: same-origin, signed in
 * (401), licensed (402), then the level's permission (403). Returns the user
 * or the response to return.
 */
export async function helpdeskGate(level: HdLevel): Promise<SessionUser | NextResponse> {
  const cross = await crossOriginRejection();
  if (cross) return cross;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (!(await helpdeskLicensed())) return NextResponse.json({ error: HD_LICENCE_ERROR }, { status: 402 });
  let ok: boolean;
  try {
    ok = await holdsLevel(user, level);
  } catch {
    return NextResponse.json({ error: "Could not evaluate permissions. Try again shortly." }, { status: 503 });
  }
  if (!ok) return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  return user;
}

/** For pages: the signed-in user's helpdesk standing in one call. */
export async function helpdeskCapabilities(user: U): Promise<{
  licensed: boolean;
  request: boolean;
  agent: boolean;
  agent_all: boolean;
  admin: boolean;
  reports: boolean;
}> {
  const licensed = await helpdeskLicensed();
  if (!licensed) return { licensed, request: false, agent: false, agent_all: false, admin: false, reports: false };
  const [request, agent, agentAll, admin, reports] = await Promise.all([
    hdHolds(user, "helpdesk.request"),
    isAgent(user),
    hasAgentAll(user),
    isHelpdeskAdmin(user),
    canReadReports(user),
  ]);
  return { licensed, request, agent, agent_all: agentAll, admin, reports };
}

/** JSON body helper with a size limit (bytes). Null on bad JSON or too big. */
export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 256 * 1024): Promise<T | null> {
  const text = await req.text().catch(() => "");
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

// --- Rate limits ---------------------------------------------------------------
//
// In-memory, per process (like lib/rate-limit): a cost and abuse backstop on
// requester posting, not a security boundary.

const hdBuckets = new Map<string, { count: number; resetAt: number }>();

/** True when `key` has used more than `max` in the current `windowMs`. */
export function hdRateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  let w = hdBuckets.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + windowMs };
    hdBuckets.set(key, w);
  }
  w.count++;
  if (hdBuckets.size > 20_000) for (const [k, v] of hdBuckets) if (now >= v.resetAt) hdBuckets.delete(k);
  return w.count > max;
}

/** A requester's new requests: 10 a minute, 60 an hour. */
export function requestCreateLimited(userId: number): boolean {
  return hdRateLimited(`hd-new-m:${userId}`, 10, 60_000) || hdRateLimited(`hd-new-h:${userId}`, 60, 3_600_000);
}

/** Messages on requests and tickets: 30 a minute per person. */
export function messagePostLimited(userId: number): boolean {
  return hdRateLimited(`hd-msg:${userId}`, 30, 60_000);
}

/** Uploads: 30 a minute per person. */
export function uploadLimited(userId: number): boolean {
  return hdRateLimited(`hd-up:${userId}`, 30, 60_000);
}

export function tooMany(): NextResponse {
  return NextResponse.json({ error: "Too many requests. Wait a moment and try again." }, { status: 429 });
}
