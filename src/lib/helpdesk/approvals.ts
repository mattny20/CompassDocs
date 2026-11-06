// Helpdesk 1.19.0: approvals. Who an approval step asks, who may read and
// decide one, and the approver's view of the request (its answers and
// opening message, never internal notes).
//
// Who is asked (the row's approver_kind, lib/helpdesk/types):
//   user     the person the step names
//   manager  the requester's manager from the directory ("Reports to": the
//            built-in people field `manager`, directory_person_links), as
//            approver_user_id. Nobody there (no linked entry, no manager,
//            or the manager has no active account): approver_user_id NULL
//            and approver_team_id = the request type's team, whose leads
//            decide (any member when it has none), or, with no team at
//            all (approver_team_id NULL too), the helpdesk admins; the
//            engine says so in a system message on the request
//   team     any one member of the team
//   space    the "Request access" step with no Policy owner on the space:
//            anyone holding space.manage_members globally
// A team or user row whose team or account was deleted (the ids are ON
// DELETE SET NULL) is the helpdesk admins' until the workflow sweep moves
// it to a stand-in (engine reassignOrphanedApprovals), so it never waits
// for nobody.
// The requester never decides their own request, whatever their teams.
//
// Deciding goes through the engine (decideApproval → engine.decide), under
// the run's row lock, so two approvers clicking at once record one
// decision and the second is told it was already decided.
//
// Server-only.

import "server-only";
import { hq, hqOne } from "./db-core";
import type { HdQueryable } from "./db-core";
import { answerRows } from "./request-types";
import type { HdFormField, HdFormAnswers } from "./types";
import type { HdApprovalCard, HdApprovalDecisionB, HdApproverKindB } from "./types";

export const APPROVAL_NOTE_MAX = 2_000;
export const QUESTION_MAX = 5_000;

// --- Resolution ----------------------------------------------------------------------

/**
 * The requester's manager: the first "Reports to" of their directory entry
 * whose entry is visible and linked to an active account other than theirs.
 * Routing, not reading: the directory's per-viewer field visibility does
 * not apply (the approver is told why they are asked, nothing more).
 */
export async function resolveManager(requesterId: number | null, client?: HdQueryable): Promise<{ user_id: number; name: string } | null> {
  if (!requesterId) return null;
  const r = await hqOne<{ user_id: number; name: string }>(
    `SELECT u.id AS user_id, coalesce(nullif(u.name, ''), u.username) AS name
       FROM users r
       JOIN directory_person_links l ON l.person_id = r.directory_person_id AND l.field_key = 'manager'
       JOIN directory_people t ON t.id = l.target_id AND t.hidden = 0
       JOIN users u ON u.directory_person_id = t.id AND u.status = 'active'
      WHERE r.id = $1 AND u.id <> r.id
      ORDER BY l.sort, t.name, t.id, u.id
      LIMIT 1`,
    [requesterId],
    client
  );
  return r ?? null;
}

/** A team's leads with active accounts. */
export async function teamLeadIds(teamId: number, client?: HdQueryable): Promise<number[]> {
  const rows = await hq<{ user_id: number }>(
    `SELECT m.user_id FROM hd_team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active'
      WHERE m.team_id = $1 AND m.role = 'lead' ORDER BY m.user_id`,
    [teamId],
    client
  );
  return rows.map((r) => r.user_id);
}

/** The space's Policy owner (spaces.policy_defaults.owner_user_id), when an active account. */
export async function spaceOwner(spaceId: number, client?: HdQueryable): Promise<{ user_id: number; name: string } | null> {
  const r = await hqOne<{ user_id: number; name: string }>(
    `SELECT u.id AS user_id, coalesce(nullif(u.name, ''), u.username) AS name
       FROM spaces s JOIN users u ON u.id = (s.policy_defaults->>'owner_user_id')::int AND u.status = 'active'
      WHERE s.id = $1`,
    [spaceId],
    client
  );
  return r ?? null;
}

/**
 * SQL: does the user in `userCol` hold `permission` globally (directly or
 * through a group)? Both arguments are written by this module.
 */
const HOLDS_GLOBALLY = (permission: "space.manage_members" | "helpdesk.admin", userCol: string) => `EXISTS (
  SELECT 1 FROM role_assignments ra
    JOIN role_permissions rp ON rp.role_id = ra.role_id AND rp.permission = '${permission}'
   WHERE ra.scope_type = 'global'
     AND (ra.user_id = ${userCol}
          OR ra.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = ${userCol})))`;

/**
 * SQL over the alias `a` (hd_approvals): is the user in `userCol` one the
 * row waits for? Not the requester check, not the decision: see
 * MAY_DECIDE. `userCol` is a placeholder or column written here, never
 * user input.
 */
const ASKS = (userCol: string) => `(
  (a.approver_kind IN ('user', 'manager') AND a.approver_user_id = ${userCol})
  OR (a.approver_kind = 'manager' AND a.approver_user_id IS NULL AND a.approver_team_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM hd_team_members m WHERE m.team_id = a.approver_team_id AND m.user_id = ${userCol}
                   AND (m.role = 'lead' OR NOT EXISTS (
                          SELECT 1 FROM hd_team_members l WHERE l.team_id = a.approver_team_id AND l.role = 'lead'))))
  OR (a.approver_kind = 'manager' AND a.approver_user_id IS NULL AND a.approver_team_id IS NULL
      AND ${HOLDS_GLOBALLY("helpdesk.admin", userCol)})
  OR (a.approver_kind = 'team' AND a.approver_team_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM hd_team_members m WHERE m.team_id = a.approver_team_id AND m.user_id = ${userCol}))
  OR (a.approver_kind = 'space' AND ${HOLDS_GLOBALLY("space.manage_members", userCol)})
  OR (a.approver_kind IN ('team', 'user') AND a.approver_team_id IS NULL AND a.approver_user_id IS NULL
      AND ${HOLDS_GLOBALLY("helpdesk.admin", userCol)})
)`;

/** SQL over `a`, `t` (the request) and `r` (the run): may `userCol` decide this row now? */
const MAY_DECIDE = (userCol: string) => `(
  a.decision = 'pending' AND r.state IN ('running', 'waiting')
  AND t.requester_id IS DISTINCT FROM ${userCol} AND ${ASKS(userCol)}
)`;

/** SQL over `a` and `t`: may `userCol` read this approval (asked by it, or decided it; never the requester's own)? */
const MAY_READ = (userCol: string) => `(
  t.requester_id IS DISTINCT FROM ${userCol} AND (a.decided_by = ${userCol} OR ${ASKS(userCol)})
)`;

/**
 * The people an approval waits for, for notices: active accounts, the
 * requester left out, at most 50 (a "space" row in a large workspace asks
 * whoever manages space access, not everyone with a key).
 */
export async function approverUserIds(approvalId: number): Promise<number[]> {
  const rows = await hq<{ id: number }>(
    `SELECT u.id FROM hd_approvals a
       JOIN hd_tickets t ON t.id = a.ticket_id
       JOIN users u ON u.status = 'active' AND u.id IS DISTINCT FROM t.requester_id
      WHERE a.id = $1 AND ${ASKS("u.id")}
      ORDER BY u.id LIMIT 50`,
    [approvalId]
  );
  return rows.map((r) => r.id);
}

/** Is this person asked by (or the decider of) any approval of the ticket? Ticket reads use it (lib/helpdesk/access isApproverOf). */
export async function isApproverFor(userId: number, ticketId: number): Promise<boolean> {
  const r = await hqOne(
    `SELECT 1 FROM hd_approvals a JOIN hd_tickets t ON t.id = a.ticket_id
      WHERE a.ticket_id = $1 AND ${MAY_READ("$2::int")} LIMIT 1`,
    [ticketId, userId]
  );
  return Boolean(r);
}

// --- The approver's view -------------------------------------------------------------

interface CardRow {
  id: number;
  decision: HdApprovalDecisionB;
  approver_kind: HdApproverKindB;
  approver_user_id: number | null;
  team_name: string | null;
  step_title: string | null;
  ticket_id: number;
  ticket_number: number;
  subject: string;
  request_type_title: string | null;
  requester_id: number | null;
  requester_name: string;
  created_at: string;
  decided_at: string | null;
  decided_by_name: string;
  note: string;
  form: HdFormField[] | null;
  form_answers: HdFormAnswers;
  body: string | null;
  can_decide: boolean;
  decided_by: number | null;
  space_name: string | null;
}

const CARD_SELECT = (userCol: string) => `
  SELECT a.id, a.decision, a.approver_kind, a.approver_user_id, tm.name AS team_name,
         s.result->>'title' AS step_title,
         t.id AS ticket_id, t.number AS ticket_number, t.subject, rt.title AS request_type_title,
         t.requester_id, t.requester_name, a.created_at, a.decided_at, a.decided_by_name, a.note,
         rt.form, t.form_answers, a.decided_by, sp.name AS space_name,
         -- The opening message: the requester's own (or the ticket's very
         -- first message, for one raised on their behalf), never a reply
         -- held for review or returned (a Newbie's unsent draft).
         (SELECT m.body FROM hd_messages m
           WHERE m.ticket_id = t.id AND m.kind = 'public'
             AND coalesce(m.review_state, '') NOT IN ('pending', 'returned')
             AND (m.author_id IS NOT DISTINCT FROM t.requester_id
                  OR m.id = (SELECT min(f.id) FROM hd_messages f WHERE f.ticket_id = t.id))
           ORDER BY m.created_at, m.id LIMIT 1) AS body,
         ${MAY_DECIDE(userCol)} AS can_decide
    FROM hd_approvals a
    JOIN hd_workflow_steps s ON s.id = a.step_id
    JOIN hd_workflow_runs r ON r.id = a.run_id
    JOIN hd_tickets t ON t.id = a.ticket_id
    LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id
    LEFT JOIN hd_teams tm ON tm.id = a.approver_team_id
    LEFT JOIN spaces sp ON sp.id = CASE WHEN jsonb_typeof(s.result->'space_id') = 'number' THEN (s.result->>'space_id')::int END`;

function reasonFor(row: CardRow, userId: number): string {
  switch (row.approver_kind) {
    case "manager":
      return row.approver_user_id === userId ? "your direct report" : "standing in for their manager";
    case "team":
      return row.team_name ? `for ${row.team_name}` : "for your team";
    case "space":
      return "you manage space access";
    default:
      return row.space_name ? "you own the space" : "you are named";
  }
}

async function toCard(row: CardRow, userId: number): Promise<HdApprovalCard> {
  return {
    id: row.id,
    decision: row.decision,
    step_title: row.step_title ?? "Approval",
    reason: reasonFor(row, userId),
    ticket_number: row.ticket_number,
    subject: row.subject,
    request_type_title: row.request_type_title,
    requester_id: row.requester_id,
    requester_name: row.requester_name,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by_name: row.decided_by_name,
    note: row.note,
    // A "Request access" approval names its space, for whoever decides it
    // (or decided it): that is what they are approving.
    answers: [
      ...(row.space_name && (row.can_decide || row.decided_by === userId) ? [{ key: "_space", label: "Space", value: row.space_name }] : []),
      ...(await answerRows(row.form ?? [], row.form_answers ?? {})),
    ],
    body: (row.body ?? "").slice(0, 20_000),
    can_decide: row.can_decide,
  };
}

export type ApprovalListState = "pending" | "decided";

/**
 * The approvals asking this person: pending ones they can decide now
 * (oldest first), or the ones they decided (newest first, the last 90 days).
 */
export async function listMyApprovals(user: { id: number }, state: ApprovalListState = "pending", limit = 50): Promise<HdApprovalCard[]> {
  const lim = Math.max(1, Math.min(200, limit));
  const rows =
    state === "pending"
      ? await hq<CardRow>(`${CARD_SELECT("$1::int")} WHERE ${MAY_DECIDE("$1::int")} ORDER BY a.created_at, a.id LIMIT ${lim}`, [user.id])
      : await hq<CardRow>(
          `${CARD_SELECT("$1::int")} WHERE a.decided_by = $1 AND a.decided_at > now() - interval '90 days'
            ORDER BY a.decided_at DESC, a.id DESC LIMIT ${lim}`,
          [user.id]
        );
  const out: HdApprovalCard[] = [];
  for (const r of rows) out.push(await toCard(r, user.id));
  return out;
}

/** How many approvals wait for this person (the Get help badge, the dashboard row, HdCounts.approvals_waiting). */
export async function countMyPendingApprovals(user: { id: number }): Promise<number> {
  const r = await hqOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM hd_approvals a
       JOIN hd_workflow_runs r ON r.id = a.run_id
       JOIN hd_tickets t ON t.id = a.ticket_id
      WHERE ${MAY_DECIDE("$1::int")}`,
    [user.id]
  );
  return r?.n ?? 0;
}

/** One approval for this person, or undefined when they are not asked by it (the route answers 404). */
export async function getApprovalForUser(user: { id: number }, approvalId: number): Promise<HdApprovalCard | undefined> {
  const row = await hqOne<CardRow>(`${CARD_SELECT("$2::int")} WHERE a.id = $1 AND ${MAY_READ("$2::int")}`, [approvalId, user.id]);
  return row ? toCard(row, user.id) : undefined;
}

/**
 * The desk's Approvals view: pending approvals on requests in the agent's
 * queues (read-only for the agent unless they are asked too: can_decide).
 * `teams` is lib/helpdesk/access agentTeamIds.
 */
export async function listDeskApprovals(user: { id: number }, teams: number[] | "all", limit = 100): Promise<HdApprovalCard[]> {
  if (teams !== "all" && teams.length === 0) return [];
  const lim = Math.max(1, Math.min(200, limit));
  const rows = await hq<CardRow>(
    `${CARD_SELECT("$1::int")}
      WHERE a.decision = 'pending' AND r.state IN ('running', 'waiting')
        AND ($2::int[] IS NULL OR t.team_id = ANY($2::int[]))
      ORDER BY a.created_at, a.id LIMIT ${lim}`,
    [user.id, teams === "all" ? null : teams]
  );
  const out: HdApprovalCard[] = [];
  for (const r of rows) out.push(await toCard(r, user.id));
  return out;
}

// --- Decisions and questions ---------------------------------------------------------

export type DecisionInput = { decision?: unknown; note?: unknown };
export type DecisionOutcome =
  | { ok: true; approval: HdApprovalCard; run_state: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** Check a decision body: approved or declined, a note of at most 2,000 characters, required to decline. */
export function parseDecision(raw: DecisionInput): { ok: true; decision: "approved" | "declined"; note: string } | { ok: false; error: string } {
  const decision = raw.decision;
  if (decision !== "approved" && decision !== "declined") return { ok: false, error: "Approve or decline." };
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== "string") return { ok: false, error: "The note is text." };
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > APPROVAL_NOTE_MAX) return { ok: false, error: `The note is longer than ${APPROVAL_NOTE_MAX} characters.` };
  if (decision === "declined" && !note) return { ok: false, error: "Say why you're declining: the requester sees your note." };
  return { ok: true, decision, note };
}

/**
 * Decide an approval as this person. 404 when they are not asked by it;
 * 409 when it is already decided (or the run stopped). The engine records
 * the decision and moves the run on in one transaction under the run's
 * lock, then sends the notices.
 */
export async function decideApproval(
  user: { id: number; name: string; username: string },
  approvalId: number,
  raw: DecisionInput
): Promise<DecisionOutcome> {
  const visible = await getApprovalForUser(user, approvalId);
  if (!visible) return { ok: false, status: 404, error: "Not found." };
  const parsed = parseDecision(raw);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  if (!visible.can_decide) return { ok: false, status: 409, error: "This approval has already been decided." };
  const { decide } = await import("./engine");
  const result = await decide(approvalId, user, parsed.decision, parsed.note, (client) =>
    hqOne<{ ok: boolean }>(
      `SELECT ${MAY_DECIDE("$2::int")} AS ok FROM hd_approvals a
         JOIN hd_workflow_runs r ON r.id = a.run_id JOIN hd_tickets t ON t.id = a.ticket_id
        WHERE a.id = $1`,
      [approvalId, user.id],
      client
    ).then((r) => Boolean(r?.ok))
  );
  if (!result.ok) return result;
  return { ok: true, approval: (await getApprovalForUser(user, approvalId))!, run_state: result.run_state };
}

/**
 * "Ask a question": a public message on the request from the approver
 * (the requester reads it and answers in the conversation). Only while the
 * approver may still decide.
 */
export async function askQuestion(
  user: { id: number; name: string; username: string; email: string },
  approvalId: number,
  rawBody: unknown
): Promise<{ ok: true; message_id: number; ticket_id: number } | { ok: false; status: 400 | 404 | 409; error: string }> {
  const card = await getApprovalForUser(user, approvalId);
  if (!card) return { ok: false, status: 404, error: "Not found." };
  const body = typeof rawBody === "string" ? rawBody.trim() : "";
  if (!body) return { ok: false, status: 400, error: "Write your question." };
  if (body.length > QUESTION_MAX) return { ok: false, status: 400, error: `The question is longer than ${QUESTION_MAX} characters.` };
  if (!card.can_decide) return { ok: false, status: 409, error: "This approval has already been decided." };
  const row = await hqOne<{ id: number; ticket_id: number }>(
    `WITH m AS (
       INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via)
       SELECT a.ticket_id, $2, $3, $4, 'public', $5, 'portal' FROM hd_approvals a WHERE a.id = $1
       RETURNING id, ticket_id)
     UPDATE hd_tickets t SET updated_at = now() FROM m WHERE t.id = m.ticket_id RETURNING m.id, m.ticket_id`,
    [approvalId, user.id, user.name || user.username, user.email ?? "", body]
  );
  if (!row) return { ok: false, status: 404, error: "Not found." };
  return { ok: true, message_id: row.id, ticket_id: row.ticket_id };
}

// --- Rate limits ---------------------------------------------------------------------

const windows = new Map<string, { count: number; resetAt: number }>();

/**
 * Per-process limits on what an approver posts: decisions 60 and questions
 * 10 per ten minutes per person (the requester-posting limits' shape, a
 * backstop against a script, not a security boundary).
 */
export function approvalRateLimited(kind: "decide" | "question", userId: number, now = Date.now()): boolean {
  const max = kind === "decide" ? 60 : 10;
  const key = `${kind}:${userId}`;
  let w = windows.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + 600_000 };
    windows.set(key, w);
  }
  w.count++;
  if (windows.size > 10_000) for (const [k, v] of windows) if (now >= v.resetAt) windows.delete(k);
  return w.count > max;
}
