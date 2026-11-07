// Helpdesk 1.19.0: tickets. Creation (numbering from 1001, reply token,
// request-type defaults, SLA dues, the opening message), reads with the
// derived fields (in_workflow, sla_state, due_label), the field changes an
// agent makes (status with the SLA pause/resume, priority with re-timed
// dues, team, assignee, category, tags, subject) each leaving a timeline
// line, the desk's queue views and counts, and the requester's own list.
//
// Writes run in one transaction and call lib/helpdesk/events after it
// commits (workflow start and solve, notices, rules), never holding a
// client while those run. Server-only.

import "server-only";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { hq, hqOne, normalizeRow, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import { mdInline } from "./md-inline";
import { afterTicketCreated, afterTicketUpdated } from "./events";
import type { HdHookContext } from "./events";
import { computeDues, dueLabel, nextDue, pausesSla, resumedDues, resumesSla, slaState } from "./sla";
import { bankPausedBusiness, clockNotes, hoursForTeam, reprioritisedDues, slaPolicyForTeam, transferDues } from "./calendars";
import { agentTeamIds, hasAgentAll } from "./access";
import {
  HD_ACTIVE_RUN_STATES,
  HD_IN_WORKFLOW_LABEL,
  HD_OPEN_STATUSES,
  HD_PRIORITIES,
  HD_PRIORITY_LABEL,
  HD_SOURCES,
  HD_STATUS_LABEL,
  HD_STATUSES,
  HD_STATUS_LABEL_REQUESTER,
} from "./types";
import type {
  HdAttachment,
  HdCounts,
  HdFormAnswers,
  HdMessageVia,
  HdNamedView,
  HdPriority,
  HdRequestSummary,
  HdSource,
  HdStatus,
  HdTicket,
  HdTicketListRow,
  HdTicketPatch,
  HdTicketRow,
  HdTicketSort,
  HdView,
} from "./types";
import type { Role } from "../types";

export const TICKET_LIMITS = {
  subject: 200,
  body: 50_000,
  category: 60,
  tags: 20,
  tag: 40,
  attachments: 10,
  page: 100,
  q: 200,
} as const;

// --- Small validators ------------------------------------------------------------

export function isStatus(v: unknown): v is HdStatus {
  return typeof v === "string" && (HD_STATUSES as readonly string[]).includes(v);
}
export function isPriorityValue(v: unknown): v is HdPriority {
  return typeof v === "string" && (HD_PRIORITIES as readonly string[]).includes(v);
}
export function isSource(v: unknown): v is HdSource {
  return typeof v === "string" && (HD_SOURCES as readonly string[]).includes(v);
}

/** Lower-case, trimmed, de-duplicated tags; null when invalid. */
export function cleanTicketTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") return null;
    const v = t.trim().toLowerCase().replace(/\s+/g, "-");
    if (!v) continue;
    if (v.length > TICKET_LIMITS.tag) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out.length > TICKET_LIMITS.tags ? null : out;
}

/** Attachment refs ({id,name,size,type}) from a body; null when malformed. */
export function cleanAttachments(raw: unknown): HdAttachment[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > TICKET_LIMITS.attachments) return null;
  const out: HdAttachment[] = [];
  for (const a of raw as Record<string, unknown>[]) {
    if (!a || typeof a !== "object") return null;
    const id = Number(a.id);
    const size = Number(a.size);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(size) || size < 0) return null;
    out.push({
      id,
      name: String(a.name ?? "").slice(0, 255),
      size,
      type: String(a.type ?? "").slice(0, 100),
    });
  }
  return out;
}

/** A display reference: "1047" or "#1047" → 1047; null otherwise. */
export function parseTicketNumber(raw: string | number): number | null {
  const n = Number(String(raw).replace(/^#/, ""));
  return Number.isInteger(n) && n > 0 && n < 2_000_000_000 ? n : null;
}

export function newTicketReplyToken(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (const b of randomBytes(16)) s += alphabet[b % 36];
  return s;
}

// --- Reads -----------------------------------------------------------------------

const TICKET_SELECT = `
  SELECT t.*, tm.name AS team_name, a.name AS assignee_name, rt.title AS request_type_title, r.state AS workflow_state
    FROM hd_tickets t
    LEFT JOIN hd_teams tm ON tm.id = t.team_id
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id
    LEFT JOIN hd_workflow_runs r ON r.id = t.workflow_run_id`;

type JoinedRow = HdTicketRow & {
  team_name: string | null;
  assignee_name: string | null;
  request_type_title: string | null;
  workflow_state: HdTicket["workflow_state"];
};

/** Add the derived fields. */
export function decorateTicket(row: JoinedRow, tz: string, now = Date.now()): HdTicket {
  const in_workflow = !!row.workflow_state && HD_ACTIVE_RUN_STATES.includes(row.workflow_state);
  return {
    ...row,
    tags: row.tags ?? [],
    sla_paused_ms: Number(row.sla_paused_ms ?? 0),
    in_workflow,
    sla_state: slaState(row, now),
    due_label: dueLabel(row, now, tz),
  };
}

async function readTickets(where: string, params: unknown[], client?: HdQueryable): Promise<HdTicket[]> {
  const rows = await hq<JoinedRow>(`${TICKET_SELECT} WHERE ${where}`, params, client);
  if (!rows.length) return [];
  const tz = await teamTimezones(rows, client);
  return rows.map((r) => decorateTicket(r, tz(r.team_id)));
}

/** Each ticket's labels read in its team's calendar zone (lib/helpdesk/calendars). With `client`, read on it. */
async function teamTimezones(rows: { team_id: number | null }[], client?: HdQueryable): Promise<(teamId: number | null) => string> {
  const ids = [...new Set(rows.map((r) => r.team_id))];
  const zones = new Map<number | null, string>();
  for (const id of ids) zones.set(id, (await hoursForTeam(id, client)).timezone);
  return (teamId) => zones.get(teamId) ?? "UTC";
}

// 1.19.4 (C7, lib/helpdesk/recycle-bin): a ticket in the recycle bin
// (deleted_at set) is not found by these reads, so every route, tool and
// hook that loads a ticket by id or number treats it as gone. The bin's
// own reads use getTicketIncludingBinned.
export async function getTicketById(id: number, client?: HdQueryable): Promise<HdTicket | undefined> {
  return (await readTickets("t.id = $1 AND t.deleted_at IS NULL", [id], client))[0];
}

export async function getTicketByNumber(number: number, client?: HdQueryable): Promise<HdTicket | undefined> {
  return (await readTickets("t.number = $1 AND t.deleted_at IS NULL", [number], client))[0];
}

/** A ticket by number whether or not it is in the recycle bin (the bin's own reads only). */
export async function getTicketIncludingBinned(number: number, client?: HdQueryable): Promise<HdTicket | undefined> {
  return (await readTickets("t.number = $1", [number], client))[0];
}

/** The plain row (no joins), optionally locked FOR UPDATE inside a transaction. Not a binned ticket (1.19.4). */
export async function getTicketRow(id: number, client?: HdQueryable, lock = false): Promise<HdTicketRow | undefined> {
  return hqOne<HdTicketRow>(`SELECT * FROM hd_tickets WHERE id = $1 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`, [id], client);
}

/** A workflow request's child tickets (tasks). */
export async function listChildTickets(parentId: number): Promise<HdTicketListRow[]> {
  const tickets = await readTickets("t.parent_ticket_id = $1 AND t.deleted_at IS NULL ORDER BY t.id", [parentId]);
  return withClockNotes(tickets, tickets.map(listRow));
}

/** Add each row's clock note (agent L's clockNotes: one calendar snapshot for the page). Never throws. */
async function withClockNotes(tickets: HdClockNoteTicket[], rows: HdTicketListRow[]): Promise<HdTicketListRow[]> {
  if (!rows.length) return rows;
  try {
    const notes = await clockNotes(tickets);
    for (const r of rows) r.clock_note = notes.get(r.id) ?? null;
  } catch (e) {
    console.error("[helpdesk] clock notes:", e);
  }
  return rows;
}

type HdClockNoteTicket = Pick<
  HdTicketRow,
  "id" | "team_id" | "priority" | "status" | "first_reply_due" | "resolve_due" | "first_replied_at" | "sla_paused_at"
>;

/** What a queue row says about the integration behind an automated ticket ("Automated · Grafana"). */
function integrationRef(t: HdTicketRow): Record<string, unknown> {
  if (t.automated !== 1) return {};
  const ref = t.source_ref ?? {};
  const out: Record<string, unknown> = {};
  if (typeof ref.integration_kind === "string") out.integration_kind = ref.integration_kind;
  if (typeof ref.integration_name === "string") out.integration_name = ref.integration_name;
  return out;
}

export function listRow(t: HdTicket): HdTicketListRow {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    requester_id: t.requester_id,
    requester_name: t.requester_name,
    team_id: t.team_id,
    team_name: t.team_name,
    assignee_id: t.assignee_id,
    assignee_name: t.assignee_name,
    status: t.status,
    priority: t.priority,
    category: t.category,
    tags: t.tags,
    source: t.source,
    parent_ticket_id: t.parent_ticket_id,
    in_workflow: t.in_workflow,
    sla_state: t.sla_state,
    due_label: t.due_label,
    next_due: nextDue(t),
    created_at: t.created_at,
    updated_at: t.updated_at,
    automated: t.automated === 1 ? 1 : 0,
    source_ref: integrationRef(t),
  };
}

// --- Create ----------------------------------------------------------------------

export interface CreateTicketInput {
  subject: string;
  /** The opening message (markdown); '' = none. */
  body?: string;
  requester: { id: number | null; name: string; email: string };
  /** Who wrote the opening message; defaults to the requester. */
  author?: { id: number | null; name: string; email: string };
  via?: HdMessageVia;
  /** The opening message's kind (an agent's ticket on behalf can open with a note). */
  first_message_kind?: "public" | "internal";
  source?: HdSource;
  source_ref?: Record<string, unknown>;
  request_type_id?: number | null;
  answers?: HdFormAnswers;
  team_id?: number | null;
  assignee_id?: number | null;
  /** Defaults to the request type's sla_priority, else normal. */
  priority?: HdPriority;
  category?: string;
  tags?: string[];
  status?: HdStatus;
  parent_ticket_id?: number | null;
  workflow_run_id?: number | null;
  attachments?: HdAttachment[];
  email_message_id?: string | null;
  /** For tests and imports: the creation instant. */
  created_at?: Date;
}

/**
 * Insert a ticket (and its opening message) on `client`, inside the
 * caller's transaction. Runs no hooks: a caller using this (the workflow
 * engine creating task tickets) does its own after-commit work, or calls
 * afterTicketCreated itself.
 */
export async function insertTicketTx(client: PoolClient, input: CreateTicketInput): Promise<HdTicketRow> {
  const subject = input.subject.trim().slice(0, TICKET_LIMITS.subject) || "(no subject)";
  let teamId = input.team_id ?? null;
  let category = (input.category ?? "").trim().slice(0, TICKET_LIMITS.category);
  let priority: HdPriority = input.priority ?? "normal";
  if (input.request_type_id) {
    const rt = (
      await client.query<{ team_id: number | null; category: string; sla_priority: string }>(
        "SELECT team_id, category, sla_priority FROM hd_request_types WHERE id = $1",
        [input.request_type_id]
      )
    ).rows[0];
    if (rt) {
      if (input.team_id === undefined) teamId = rt.team_id;
      if (!category) category = rt.category;
      if (!input.priority && isPriorityValue(rt.sla_priority)) priority = rt.sla_priority;
    }
  }
  const createdAt = input.created_at ?? new Date();
  // The team's calendar and reply targets (its own, else the workspace's),
  // read on the caller's client: a workflow transaction must never need a
  // second pooled connection (the pool has five).
  const policy = await slaPolicyForTeam(priority, teamId, client);
  const hours = await hoursForTeam(teamId, client);
  const dues = policy ? computeDues(createdAt.getTime(), policy, hours) : null;
  const status: HdStatus = input.status ?? (input.assignee_id ? "open" : "new");
  let row: HdTicketRow | undefined;
  for (let attempt = 0; !row; attempt++) {
    try {
      await client.query("SAVEPOINT hd_ticket_insert");
      const res = await client.query(
        `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, assignee_id, status,
            priority, category, tags, request_type_id, form_answers, source, source_ref, parent_ticket_id, workflow_run_id,
            sla_policy_id, first_reply_due, resolve_due, reply_token, created_at, updated_at, solved_at, sla_paused_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $21,
                 CASE WHEN $7 IN ('solved', 'closed') THEN $21::timestamptz END,
                 CASE WHEN $7 IN ('pending', 'on_hold') THEN $21::timestamptz END)
         RETURNING *`,
        [
          subject,
          input.requester.id,
          input.requester.name.slice(0, 200),
          input.requester.email.slice(0, 320),
          teamId,
          input.assignee_id ?? null,
          status,
          priority,
          category,
          input.tags ?? [],
          input.request_type_id ?? null,
          JSON.stringify(input.answers ?? {}),
          input.source ?? "portal",
          JSON.stringify(input.source_ref ?? {}),
          input.parent_ticket_id ?? null,
          input.workflow_run_id ?? null,
          policy?.policy_id ?? null,
          dues?.first_reply_due ?? null,
          dues?.resolve_due ?? null,
          newTicketReplyToken(),
          createdAt,
        ]
      );
      await client.query("RELEASE SAVEPOINT hd_ticket_insert");
      row = normalizeRow<HdTicketRow>(res.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT hd_ticket_insert");
      // A reply-token clash (vanishingly rare) is retried with a new token.
      if ((e as { code?: string }).code !== "23505" || attempt >= 2) throw e;
    }
  }
  const body = (input.body ?? "").slice(0, TICKET_LIMITS.body);
  if (body.trim() || (input.attachments?.length ?? 0) > 0) {
    const author = input.author ?? input.requester;
    await client.query(
      `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via, attachments, email_message_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.id,
        author.id,
        author.name,
        author.email,
        input.first_message_kind ?? "public",
        body,
        input.via ?? "portal",
        JSON.stringify(input.attachments ?? []),
        input.email_message_id ?? null,
        createdAt,
      ]
    );
  }
  return row;
}

/**
 * Create a ticket and run the after-commit hooks (rules, workflow start for
 * a request type with a published workflow, the acknowledgement). Returns
 * the ticket as read after the hooks, so a rule's team or assignee shows.
 */
export async function createTicket(input: CreateTicketInput, ctx: HdHookContext = {}): Promise<HdTicket> {
  const row = await withTx((client) => insertTicketTx(client, input));
  await afterTicketCreated(row, ctx);
  return (await getTicketById(row.id))!;
}

// --- Update ----------------------------------------------------------------------

export class HdTicketError extends Error {
  /** 1.19.1: set by assertNotMergedTx when addMessage refused a message before writing anything (lib/helpdesk/inbound retries it once). */
  messageUnsent?: boolean;
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * 1.19.1: a merged ticket's conversation and status are read-only (as
 * lib/helpdesk/merge mergedLock). Asked on the row locked inside
 * addMessage's and updateTicket's transactions, so a reply or status change
 * racing a merge is refused under the lock the merge takes. Throws
 * HdTicketError(409) naming the kept ticket; `messageUnsent` (addMessage)
 * marks it as thrown before the message was written.
 */
export async function assertNotMergedTx(client: HdQueryable, row: HdTicketRow, opts: { messageUnsent?: boolean } = {}): Promise<void> {
  if (!row.merged_into) return;
  const into = await hqOne<{ number: number }>("SELECT number FROM hd_tickets WHERE id = $1", [row.merged_into], client);
  const n = into?.number;
  const e = new HdTicketError(n ? `#${row.number} was merged into #${n}. Reply and change its status on #${n}.` : `#${row.number} was merged into another ticket.`, 409);
  if (opts.messageUnsent) e.messageUnsent = true;
  throw e;
}

/** Validate a PATCH body. Throws HdTicketError on bad input. */
export function validateTicketPatch(raw: Record<string, unknown>): HdTicketPatch {
  const out: HdTicketPatch = {};
  if (raw.status !== undefined) {
    if (!isStatus(raw.status)) throw new HdTicketError("Unknown status.");
    out.status = raw.status;
  }
  if (raw.priority !== undefined) {
    if (!isPriorityValue(raw.priority)) throw new HdTicketError("Unknown priority.");
    out.priority = raw.priority;
  }
  for (const k of ["team_id", "assignee_id"] as const) {
    if (raw[k] === undefined) continue;
    if (raw[k] === null) out[k] = null;
    else {
      const n = Number(raw[k]);
      if (!Number.isInteger(n) || n <= 0) throw new HdTicketError(`${k} must be an id or null.`);
      out[k] = n;
    }
  }
  if (raw.category !== undefined) {
    if (typeof raw.category !== "string" || raw.category.length > TICKET_LIMITS.category) throw new HdTicketError("Category is too long.");
    out.category = raw.category.trim();
  }
  if (raw.tags !== undefined) {
    const tags = cleanTicketTags(raw.tags);
    if (!tags) throw new HdTicketError(`Up to ${TICKET_LIMITS.tags} tags of up to ${TICKET_LIMITS.tag} characters.`);
    out.tags = tags;
  }
  if (raw.subject !== undefined) {
    const s = typeof raw.subject === "string" ? raw.subject.trim() : "";
    if (!s || s.length > TICKET_LIMITS.subject) throw new HdTicketError("The subject must be 1 to 200 characters.");
    out.subject = s;
  }
  return out;
}

export interface UpdateActor {
  id: number | null;
  name: string;
  role?: Role;
  /**
   * "mcp": the change came through the Claude connector; each timeline line ends "via Claude" (1.19.1).
   * "api": an API token (1.19.4 C2), "via API".
   * "claude_desk": the agent applied a change Claude in the desk proposed; lines end "via Claude in the desk" (1.20.0).
   */
  via?: "mcp" | "api" | "claude_desk";
}

/** May `userId` be assigned a ticket of `teamId`: active, and a member of that team (any team when none) or an agent_all holder. */
export async function assignable(userId: number, teamId: number | null, client?: HdQueryable): Promise<boolean> {
  const u = await hqOne<{ id: number; role: Role }>("SELECT id, role FROM users WHERE id = $1 AND status = 'active'", [userId], client);
  if (!u) return false;
  const member = await hqOne(
    `SELECT 1 FROM hd_team_members WHERE user_id = $1 AND ($2::int IS NULL OR team_id = $2) LIMIT 1`,
    [userId, teamId],
    client
  );
  if (member) return true;
  return hasAgentAll(u);
}

export interface UpdateResult {
  ticket: HdTicket;
  changed: (keyof HdTicketPatch)[];
  before: HdTicketRow;
}

/**
 * Apply an agent's (or a rule's, or the engine's) field changes. One
 * transaction with the row locked; each change leaves a timeline line
 * (status: a requester-visible system message; the rest internal). Status:
 * solved/closed stamp their times, reopening clears them; pending/on_hold
 * pause the SLA clocks and leaving them resumes with the business time that
 * was left. Priority re-times the dues from creation under the new policy
 * (plus the time already paused). After commit: lib/helpdesk/events (solve,
 * assignment notice, rules). Throws HdTicketError on a bad team/assignee.
 */
export async function updateTicket(
  ticketId: number,
  patch: HdTicketPatch,
  actor: UpdateActor,
  ctx: HdHookContext = {}
): Promise<UpdateResult | undefined> {
  const now = new Date();
  const tx = await withTx(async (client) => {
    const before = await getTicketRow(ticketId, client, true);
    if (!before) return undefined;
    if (patch.status !== undefined && patch.status !== before.status) await assertNotMergedTx(client, before);
    const sets: string[] = [];
    const params: unknown[] = [ticketId];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    const changed: (keyof HdTicketPatch)[] = [];
    const lines: { kind: "system" | "internal"; body: string }[] = [];
    const who = actor.name || "Someone";
    // 1.19.4 review (Markdown): internal lines are Markdown in the desk, so the names and the
    // old subject in them are escaped. The status line (kind system) is drawn as plain text
    // in the desk and the portal, so it keeps the name as typed.
    const whoMd = mdInline(who);

    if (patch.subject !== undefined && patch.subject !== before.subject) {
      set("subject", patch.subject);
      changed.push("subject");
      lines.push({ kind: "internal", body: `${whoMd} renamed the ticket from "${mdInline(before.subject)}"` });
    }
    let teamId = before.team_id;
    if (patch.team_id !== undefined && patch.team_id !== before.team_id) {
      if (patch.team_id !== null) {
        const team = (await client.query<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [patch.team_id])).rows[0];
        if (!team) throw new HdTicketError("That team does not exist.");
        lines.push({ kind: "internal", body: `${whoMd} moved the ticket to ${mdInline(team.name)}` });
      } else lines.push({ kind: "internal", body: `${whoMd} took the ticket out of its team` });
      set("team_id", patch.team_id);
      teamId = patch.team_id;
      changed.push("team_id");
    }
    let assigneeChangedTo: number | null | undefined;
    if (patch.assignee_id !== undefined && patch.assignee_id !== before.assignee_id) {
      if (patch.assignee_id !== null) {
        if (!(await assignable(patch.assignee_id, teamId, client))) {
          throw new HdTicketError("That person is not an agent of this ticket's team.");
        }
        const name = (await client.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [patch.assignee_id])).rows[0]?.name ?? "";
        lines.push({
          kind: "internal",
          body: patch.assignee_id === actor.id ? `${whoMd} took the ticket` : `${whoMd} assigned the ticket to ${mdInline(name)}`,
        });
      } else lines.push({ kind: "internal", body: `${whoMd} unassigned the ticket` });
      set("assignee_id", patch.assignee_id);
      assigneeChangedTo = patch.assignee_id;
      changed.push("assignee_id");
    }
    if (patch.category !== undefined && patch.category !== before.category) {
      set("category", patch.category);
      changed.push("category");
      lines.push({ kind: "internal", body: patch.category ? `${whoMd} set the category to ${mdInline(patch.category)}` : `${whoMd} cleared the category` });
    }
    if (patch.tags !== undefined && JSON.stringify(patch.tags) !== JSON.stringify(before.tags ?? [])) {
      set("tags", patch.tags);
      changed.push("tags");
    }

    // Dues as they stand, then as team, priority and status move them. The
    // clocks count the ticket's team calendar against the team's targets
    // (lib/helpdesk/calendars, agent L).
    let firstDue = before.first_reply_due;
    let resolveDue = before.resolve_due;
    let duesMoved = false;
    let policyId = before.sla_policy_id;
    const priority = patch.priority ?? before.priority;
    let transferred = false;
    const hours = await hoursForTeam(teamId, client);
    if (patch.priority === undefined || patch.priority === before.priority) {
      if (changed.includes("team_id")) {
        // A team move keeps the business time used and counts the rest of the new team's target in its calendar.
        const tr = await transferDues(before, before.team_id, teamId, now, client);
        if (tr.changed || tr.sla_policy_id !== before.sla_policy_id) {
          firstDue = tr.first_reply_due?.toISOString() ?? null;
          resolveDue = tr.resolve_due?.toISOString() ?? null;
          policyId = tr.sla_policy_id;
          transferred = true;
        }
        // A breach stands: a move never clears one. A move that uses a target
        // up leaves its due at the move (tr.breached): the SLA sweep stamps
        // the breach within a minute and sends the breach notice, which a
        // stamp here would suppress.
      }
    }
    if (patch.priority !== undefined && patch.priority !== before.priority) {
      set("priority", patch.priority);
      changed.push("priority");
      lines.push({ kind: "internal", body: `${whoMd} changed the priority from ${HD_PRIORITY_LABEL[before.priority]} to ${HD_PRIORITY_LABEL[patch.priority]}` });
      // Business time already used is kept and counted against the new
      // target (lib/helpdesk/calendars reprioritisedDues): never from
      // wall-clock paused time, which would add whole nights and weekends.
      const d = await reprioritisedDues(before, { team: before.team_id, priority: before.priority }, { team: teamId, priority: patch.priority }, now, client);
      policyId = d.sla_policy_id;
      firstDue = d.first_reply_due;
      resolveDue = d.resolve_due;
      duesMoved = true;
    }
    let solved = false;
    if (patch.status !== undefined && patch.status !== before.status) {
      const to = patch.status;
      // A workflow task's required hand-off comes first, whatever solves it
      // (PATCH, a reply's then_status, a macro, an automation): 409.
      if (before.source === "workflow" && (to === "solved" || to === "closed") && HD_OPEN_STATUSES.includes(before.status)) {
        const { validateTaskSolve } = await import("./engine");
        const missing = await validateTaskSolve(ticketId, client);
        if (missing) throw new HdTicketError(missing.error, 409);
      }
      // 1.19.2: required checklist items block solving, whatever solves it (lib/helpdesk/checklists, agent W3): 409.
      const held = await (await import("./checklists")).checklistSolveBlockTx(client, ticketId, before.status, to);
      if (held) throw new HdTicketError(held, 409);
      set("status", to);
      changed.push("status");
      lines.push({ kind: "system", body: `${who} changed the status from ${HD_STATUS_LABEL[before.status]} to ${HD_STATUS_LABEL[to]}` });
      if ((to === "solved" || to === "closed") && !before.solved_at) set("solved_at", now);
      if (to === "closed") set("closed_at", now);
      // Leaving the open statuses for solved or closed is "solved" for the hooks.
      if ((to === "solved" || to === "closed") && HD_OPEN_STATUSES.includes(before.status)) solved = true;
      if (HD_OPEN_STATUSES.includes(to) && (before.status === "solved" || before.status === "closed")) {
        set("solved_at", null);
        set("closed_at", null);
      }
      if (pausesSla(before.status, to) && !before.sla_paused_at) set("sla_paused_at", now);
      if (resumesSla(before.status, to) && before.sla_paused_at) {
        const pausedAt = Date.parse(before.sla_paused_at);
        set("sla_paused_at", null);
        set("sla_paused_ms", Number(before.sla_paused_ms ?? 0) + Math.max(0, now.getTime() - pausedAt));
        // 1.19.1: the pause in business time too (lib/helpdesk/calendars bankPausedBusiness).
        await bankPausedBusiness(client, ticketId, now);
        if (HD_OPEN_STATUSES.includes(to)) {
          const policy = await slaPolicyForTeam(priority, teamId, client);
          if (policy) {
            const d = resumedDues({ first_reply_due: firstDue, resolve_due: resolveDue, first_replied_at: before.first_replied_at }, pausedAt, now.getTime(), policy, hours);
            firstDue = d.first_reply_due?.toISOString() ?? null;
            resolveDue = d.resolve_due?.toISOString() ?? null;
            duesMoved = true;
          }
        }
      }
    }
    if (duesMoved || transferred) {
      set("first_reply_due", firstDue);
      set("resolve_due", resolveDue);
      if (policyId !== before.sla_policy_id) set("sla_policy_id", policyId);
      set("sla_warned_at", null);
      // A re-prioritised due that moved into the future can breach again (a
      // team move never clears a breach; transferDues above).
      if (duesMoved && !transferred) {
        if (!firstDue || Date.parse(firstDue) > now.getTime()) set("first_reply_breached_at", null);
        if (!resolveDue || Date.parse(resolveDue) > now.getTime()) set("resolve_breached_at", null);
      }
    }
    if (!sets.length) return { before, changed, assigneeChangedTo, solved: false };
    set("updated_at", now);
    await client.query(`UPDATE hd_tickets SET ${sets.join(", ")} WHERE id = $1`, params);
    for (const l of lines) {
      await client.query(
        `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at)
         VALUES ($1, $2, $3, $4, $5, 'system', $6)`,
        [ticketId, actor.id, actor.name, l.kind, actor.via === "mcp" ? `${l.body} via Claude` : actor.via === "api" ? `${l.body} via API` : actor.via === "claude_desk" ? `${l.body} via Claude in the desk` : l.body, now]
      );
    }
    return { before, changed, assigneeChangedTo, solved };
  });
  if (!tx) return undefined;
  if (tx.changed.length) {
    const before = tx.before;
    const after = patch.status;
    await afterTicketUpdated(
      ticketId,
      {
        assigneeChangedTo: tx.assigneeChangedTo,
        solved: tx.solved,
        changed: tx.changed,
        team: tx.changed.includes("team_id") ? { from: before.team_id, to: patch.team_id ?? null, source: before.source } : undefined,
        reopened: after !== undefined && HD_OPEN_STATUSES.includes(after) && (before.status === "solved" || before.status === "closed"),
      },
      { actorId: actor.id, actorName: actor.name, ...ctx }
    );
  }
  return { ticket: (await getTicketById(ticketId))!, changed: tx.changed, before: tx.before };
}

/** Delete a ticket (admin). Its messages, runs and approvals go with it. */
export async function deleteTicket(ticketId: number): Promise<HdTicketRow | undefined> {
  // Never a ticket on legal hold (1.19.1, lib/helpdesk/retention; the route answers 409 first).
  const row = await hqOne<HdTicketRow>("DELETE FROM hd_tickets WHERE id = $1 AND legal_hold = 0 RETURNING *", [ticketId]);
  // 1.20.0: Claude in the desk chats that touched it go too (their links outlive the ticket for this).
  if (row) await (await import("./claude/chats")).purgeClaudeForTicket(ticketId);
  return row;
}

// --- The desk's queues -----------------------------------------------------------

export interface TicketListFilters {
  /**
   * A queue view, or "all" (every status: report drill-downs, the contact
   * card's earlier tickets). Omitted: "open", except that a search (`q`)
   * without a view looks through every status (the desk's global search).
   */
  view?: HdView | "all";
  team_id?: number;
  priority?: HdPriority;
  /** A user id, "me" or "none". */
  assignee?: number | "me" | "none";
  /** The requester's account (the contact card's "Earlier tickets"); still inside the caller's scope. */
  requester_id?: number;
  /** A requester without an account, by email (case-insensitive). */
  requester_email?: string;
  status?: HdStatus;
  /** "open": any of the open statuses (Reports' live measures). */
  status_group?: "open";
  request_type_id?: number;
  /** Raw sources (a channel group expands to several: trigger → doc, handbook, space_access, link). */
  sources?: HdSource[];
  tag?: string;
  /** '' = no category. */
  category?: string;
  /** The requester's directory entry ('' = none recorded). */
  department?: string;
  office?: string;
  /** people: opened by a person; automated: by an alert or API intake. */
  origin?: "people" | "automated";
  /** "YYYY-MM-DD", inclusive, in the default calendar's zone. */
  created_from?: string;
  created_to?: string;
  solved_from?: string;
  solved_to?: string;
  /** "ever": missed a reply or resolution target; "now": open and past a running target. */
  breached?: "ever" | "now";
  /** The requester is (yes) or is not (no) on today's VIP list (agent O's contact cards). */
  vip?: "yes" | "no";
  /** The intake integration that opened it; "none" = opened by no integration. */
  integration_id?: number | "none";
  q?: string;
  sort?: HdTicketSort;
  limit?: number;
  offset?: number;
  /** Only the total, no rows (saved views' counts, 1.19.1). */
  countOnly?: boolean;
}

const OPEN_SQL = "t.status IN ('new', 'open', 'pending', 'on_hold')";
const OVERDUE_SQL = `(${OPEN_SQL} AND t.sla_paused_at IS NULL AND (
    (t.first_replied_at IS NULL AND t.first_reply_due < now()) OR t.resolve_due < now()))`;
const IN_WORKFLOW_SQL = `(EXISTS (SELECT 1 FROM hd_workflow_runs wr WHERE wr.id = t.workflow_run_id AND wr.state IN ('running', 'waiting', 'blocked')))`;

/** The scope predicate for an agent: their teams' tickets and tickets assigned to them; everything with agent_all. */
function scopeSql(teams: number[] | "all", userId: number, params: unknown[]): string {
  // 1.19.4 (C7): a ticket in the recycle bin is in no queue, view, count or search.
  if (teams === "all") return "t.deleted_at IS NULL";
  params.push(teams, userId);
  return `(t.deleted_at IS NULL AND (t.team_id = ANY($${params.length - 1}::int[]) OR t.assignee_id = $${params.length}))`;
}

function viewSql(view: HdView, userId: number, params: unknown[], tz: string): string {
  if (typeof view === "object") {
    params.push(view.team_id);
    return `(${OPEN_SQL} AND t.team_id = $${params.length})`;
  }
  switch (view) {
    case "mine":
      params.push(userId);
      return `(${OPEN_SQL} AND t.assignee_id = $${params.length})`;
    case "unassigned":
      return `(${OPEN_SQL} AND t.assignee_id IS NULL)`;
    case "open":
      return OPEN_SQL;
    case "overdue":
      return OVERDUE_SQL;
    case "workflow":
      return `(${OPEN_SQL} AND (${IN_WORKFLOW_SQL} OR t.parent_ticket_id IS NOT NULL))`;
    case "waiting":
      return "t.status IN ('pending', 'on_hold')";
    case "solved_week":
      params.push(tz);
      // 1.19.1: a ticket merged into another was closed, not solved.
      return `(t.status IN ('solved', 'closed') AND t.merged_into IS NULL AND t.solved_at >= (date_trunc('week', now() AT TIME ZONE $${params.length}) AT TIME ZONE $${params.length}))`;
  }
}

const SORT_SQL: Record<HdTicketSort, string> = {
  updated: "t.updated_at DESC, t.id DESC",
  created: "t.created_at DESC, t.id DESC",
  number: "t.number DESC",
  priority: "array_position(ARRAY['urgent','high','normal','low'], t.priority), t.updated_at DESC",
  due: "(CASE WHEN t.first_replied_at IS NULL AND t.first_reply_due IS NOT NULL THEN t.first_reply_due ELSE t.resolve_due END) ASC NULLS LAST, t.id",
};

/** A channel name (Reports' channels) or a raw source → the sources it covers; null when unknown. */
export function channelSources(raw: string): HdSource[] | null {
  if (raw === "trigger") return ["doc", "handbook", "space_access", "link"];
  return (HD_SOURCES as readonly string[]).includes(raw) ? [raw as HdSource] : null;
}

export function parseView(raw: string | null | undefined): HdView | "all" | null {
  if (!raw) return null;
  if (raw === "all") return "all";
  const m = /^team:(\d+)$/.exec(raw);
  if (m) return { team_id: Number(m[1]) };
  return (["mine", "unassigned", "open", "overdue", "workflow", "waiting", "solved_week"] as const).includes(raw as HdNamedView)
    ? (raw as HdNamedView)
    : null;
}

/** The desk's queue: the caller's scope, a view, the filters. */
export async function listTickets(
  user: { id: number; role: Role },
  f: TicketListFilters = {}
): Promise<{ rows: HdTicketListRow[]; total: number }> {
  // An agent in no team still sees what is assigned to them (scopeSql).
  const teams = await agentTeamIds(user);
  // "This week" in the default calendar's zone; each row's label in its team's.
  const { timezone } = await hoursForTeam(null);
  const params: unknown[] = [];
  const where: string[] = [scopeSql(teams, user.id, params)];
  const q = (f.q ?? "").trim().slice(0, TICKET_LIMITS.q);
  // A search without a view looks through every status (solved and closed too).
  const view = f.view ?? (q ? "all" : "open");
  if (view !== "all") where.push(viewSql(view, user.id, params, timezone));
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.status_group === "open") where.push(OPEN_SQL);
  if (f.request_type_id) where.push(`t.request_type_id = ${bind(f.request_type_id)}`);
  if (f.sources?.length) where.push(`t.source = ANY(${bind(f.sources)}::text[])`);
  if (f.tag) where.push(`${bind(f.tag)} = ANY(t.tags)`);
  if (f.category !== undefined) where.push(`COALESCE(t.category, '') = ${bind(f.category)}`);
  if (f.origin) where.push(f.origin === "automated" ? "COALESCE(t.automated, 0) = 1" : "COALESCE(t.automated, 0) = 0");
  for (const k of ["department", "office"] as const) {
    if (f[k] === undefined) continue;
    where.push(`COALESCE((SELECT dp.${k} FROM users ru JOIN directory_people dp ON dp.id = ru.directory_person_id AND dp.hidden = 0
                           WHERE ru.id = t.requester_id), '') = ${bind(f[k])}`);
  }
  if (f.requester_email) where.push(`lower(t.requester_email) = lower(${bind(f.requester_email)})`);
  // Inclusive days in the helpdesk's zone: [from 00:00, to + 1 day 00:00).
  const day = (col: string, d: string | undefined, end: boolean) => {
    if (!d) return;
    const tz = bind(timezone);
    where.push(end ? `${col} < ((${bind(d)}::date + 1)::timestamp AT TIME ZONE ${tz})` : `${col} >= (${bind(d)}::date::timestamp AT TIME ZONE ${tz})`);
  };
  day("t.created_at", f.created_from, false);
  day("t.created_at", f.created_to, true);
  day("t.solved_at", f.solved_from, false);
  day("t.solved_at", f.solved_to, true);
  // 1.19.1: a merged ticket was closed, not solved (the reports leave it out, so their drill-downs do too).
  if (f.solved_from || f.solved_to) where.push("t.merged_into IS NULL");
  if (f.breached === "ever") where.push("(t.first_reply_breached_at IS NOT NULL OR t.resolve_breached_at IS NOT NULL)");
  if (f.breached === "now") where.push(OVERDUE_SQL);
  if (f.integration_id === "none") where.push("t.integration_id IS NULL");
  else if (f.integration_id) where.push(`t.integration_id = ${bind(f.integration_id)}`);
  if (f.team_id) {
    params.push(f.team_id);
    where.push(`t.team_id = $${params.length}`);
  }
  if (f.priority) {
    params.push(f.priority);
    where.push(`t.priority = $${params.length}`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`t.status = $${params.length}`);
  }
  if (f.requester_id) {
    params.push(f.requester_id);
    where.push(`t.requester_id = $${params.length}`);
  }
  if (f.assignee === "none") where.push("t.assignee_id IS NULL");
  else if (f.assignee !== undefined) {
    params.push(f.assignee === "me" ? user.id : f.assignee);
    where.push(`t.assignee_id = $${params.length}`);
  }
  if (q) {
    const num = parseTicketNumber(q);
    params.push(`%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    const like = `$${params.length}`;
    let clause = `(t.subject ILIKE ${like} OR t.requester_name ILIKE ${like} OR t.requester_email ILIKE ${like}
      OR EXISTS (SELECT 1 FROM hd_messages m WHERE m.ticket_id = t.id AND m.kind <> 'system' AND m.body ILIKE ${like})`;
    if (num) {
      params.push(num);
      clause += ` OR t.number = $${params.length}`;
    }
    where.push(clause + ")");
  }
  if (f.vip) {
    // Today's VIP list among the requesters these filters reach (as Reports reads it).
    const cand = await hq<{ id: number }>(
      `SELECT DISTINCT t.requester_id AS id FROM hd_tickets t WHERE ${where.join(" AND ")} AND t.requester_id IS NOT NULL LIMIT 50000`,
      params
    );
    const { vipsAmong } = await import("./analytics/hours");
    const vips = await vipsAmong(cand.map((r) => Number(r.id)));
    where.push(f.vip === "yes" ? `t.requester_id = ANY(${bind(vips)}::int[])` : `(t.requester_id IS NULL OR NOT (t.requester_id = ANY(${bind(vips)}::int[])))`);
  }
  const limit = Math.min(Math.max(1, f.limit ?? 50), TICKET_LIMITS.page);
  const offset = Math.max(0, f.offset ?? 0);
  const whereSql = where.join(" AND ");
  const total = (await hqOne<{ n: number }>(`SELECT count(*)::int AS n FROM hd_tickets t WHERE ${whereSql}`, params))?.n ?? 0;
  if (f.countOnly) return { rows: [], total }; // saved views' counts (1.19.1, lib/helpdesk/saved-views)
  params.push(limit, offset);
  const rows = await hq<JoinedRow>(
    `${TICKET_SELECT} WHERE ${whereSql} ORDER BY ${SORT_SQL[f.sort ?? "updated"]} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const now = Date.now();
  const tz = await teamTimezones(rows);
  const out = await withClockNotes(
    rows,
    rows.map((r) => listRow(decorateTicket(r, tz(r.team_id), now)))
  );
  // VIP requesters (agent O), one batch call.
  try {
    const { vipMap } = await import("./contact-cards");
    const vips = await vipMap(out.map((r) => r.requester_id));
    for (const r of out) {
      const v = r.requester_id != null ? vips.get(r.requester_id) : undefined;
      if (v?.vip) {
        r.requester_vip = true;
        r.requester_vip_reason = v.reason;
      }
    }
  } catch (e) {
    console.error("[helpdesk] vip:", e);
  }
  // 1.19.2: major incident chips (agent W1, lib/helpdesk/incidents), one batch call.
  try {
    const chips = await (await import("./incidents")).incidentChips(out.map((r) => r.id));
    for (const r of out) if (chips.has(r.id)) r.incident = chips.get(r.id);
  } catch (e) {
    console.error("[helpdesk] incident chips:", e);
  }
  return { rows: out, total };
}

/** The view counts, the team counts and the headline tiles, for the caller's scope. */
export async function countViews(user: { id: number; role: Role }): Promise<HdCounts> {
  const teams = await agentTeamIds(user);
  const { timezone } = await hoursForTeam(null);
  const params: unknown[] = [];
  const scope = scopeSql(teams, user.id, params);
  const views: HdNamedView[] = ["mine", "unassigned", "open", "overdue", "workflow", "waiting", "solved_week"];
  const cols = views.map((v) => `count(*) FILTER (WHERE ${viewSql(v, user.id, params, timezone)})::int AS ${v}`);
  const row = (await hqOne<Record<HdNamedView, number>>(`SELECT ${cols.join(", ")} FROM hd_tickets t WHERE ${scope}`, params))!;
  const teamParams: unknown[] = teams === "all" ? [] : [teams];
  const teamScope = teams === "all" ? "TRUE" : "tm.id = ANY($1::int[])";
  const teamRows = await hq<{ team_id: number; name: string; icon: string; open: number }>(
    `SELECT tm.id AS team_id, tm.name, tm.icon,
            (SELECT count(*)::int FROM hd_tickets t WHERE t.team_id = tm.id AND ${OPEN_SQL} AND t.deleted_at IS NULL) AS open
       FROM hd_teams tm WHERE ${teamScope} ORDER BY tm.position, tm.name`,
    teamParams
  );
  const hp: unknown[] = [];
  const hscope = scopeSql(teams, user.id, hp);
  const head = await hqOne<{ median: number | null; good: number; answered: number }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t.first_replied_at - t.created_at)) / 60)
              FILTER (WHERE t.first_replied_at IS NOT NULL AND t.created_at > now() - interval '30 days') AS median,
            count(*) FILTER (WHERE t.csat_score >= 4 AND t.csat_at > now() - interval '30 days')::int AS good,
            count(*) FILTER (WHERE t.csat_score IS NOT NULL AND t.csat_at > now() - interval '30 days')::int AS answered
       FROM hd_tickets t WHERE ${hscope}`,
    hp
  );
  let approvalsWaiting = 0;
  try {
    const { countMyPendingApprovals } = await import("./approvals");
    approvalsWaiting = await countMyPendingApprovals(user);
  } catch {
    /* a failing count never fails the counts */
  }
  let reviewsPending = 0;
  try {
    const { pendingReviewCount } = await import("./review");
    reviewsPending = await pendingReviewCount(user);
  } catch {
    /* as above */
  }
  return {
    views: row,
    teams: teamRows,
    headline: {
      open: row.open,
      overdue: row.overdue,
      first_reply_median_minutes: head?.median != null ? Math.round(Number(head.median)) : null,
      csat_percent: head && head.answered ? Math.round((head.good / head.answered) * 100) : null,
    },
    approvals_waiting: approvalsWaiting,
    reviews_pending: reviewsPending,
  };
}

// --- The requester's own list ------------------------------------------------------

/** A requester's own requests (not workflow task tickets), newest activity first. */
export async function listMyRequests(
  userId: number,
  opts: { status?: "open" | "solved"; limit?: number; includeCopied?: boolean } = {}
): Promise<HdRequestSummary[]> {
  const where = [
    // includeCopied (1.19.1, agent V3): requests the person is a CC of too.
    opts.includeCopied ? "(t.requester_id = $1 OR t.id IN (SELECT c.ticket_id FROM hd_ticket_ccs c WHERE c.user_id = $1))" : "t.requester_id = $1",
    "t.parent_ticket_id IS NULL",
    // 1.19.4 (C7): a binned ticket leaves My requests and CC views.
    "t.deleted_at IS NULL",
  ];
  if (opts.status === "open") where.push(OPEN_SQL);
  if (opts.status === "solved") where.push("t.status IN ('solved', 'closed')");
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const rows = await hq<JoinedRow & { last_public_author: string | null; last_public_at: string | null }>(
    `SELECT x.*, lm.author_name AS last_public_author, lm.created_at AS last_public_at
       FROM (${TICKET_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.updated_at DESC, t.id DESC LIMIT ${limit}) x
       LEFT JOIN LATERAL (SELECT author_name, created_at FROM hd_messages m
                           WHERE m.ticket_id = x.id AND m.kind = 'public'
                             -- A newbie's reply held for review (or returned) was never sent.
                             AND COALESCE(m.review_state, '') NOT IN ('pending', 'returned')
                           ORDER BY m.created_at DESC, m.id DESC LIMIT 1) lm ON TRUE
      ORDER BY x.updated_at DESC, x.id DESC`,
    [userId]
  );
  const tz = await teamTimezones(rows);
  const out = rows.map((r) => {
    const t = decorateTicket(r, tz(r.team_id));
    return {
      number: t.number,
      subject: t.subject,
      status: t.status,
      status_label: t.in_workflow ? HD_IN_WORKFLOW_LABEL : HD_STATUS_LABEL_REQUESTER[t.status],
      in_workflow: t.in_workflow,
      team_name: t.team_name,
      request_type_title: t.request_type_title,
      source: t.source,
      created_at: t.created_at,
      updated_at: t.updated_at,
      solved_at: t.solved_at,
      csat_score: t.csat_score,
      last_public_author: r.last_public_author,
      last_public_at: r.last_public_at,
      current_step: null as HdRequestSummary["current_step"],
      _in_workflow_id: t.in_workflow ? t.id : null,
    };
  });
  // Where a request in a workflow is now (B's tracker), for "step 3 of 4: IT is setting it up".
  const inWorkflow = out.filter((x) => x._in_workflow_id !== null);
  if (inWorkflow.length) {
    const { getWorkflowProgress } = await import("./engine");
    const { currentStep } = await import("./detail");
    for (const x of inWorkflow) x.current_step = currentStep(await getWorkflowProgress(x._in_workflow_id!, "requester").catch(() => null));
  }
  return out.map(({ _in_workflow_id: _drop, ...rest }) => rest);
}

/** Requests waiting on this requester (status pending, theirs): the Get help badge. */
export async function countWaitingOnRequester(userId: number): Promise<number> {
  const row = await hqOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM hd_tickets WHERE requester_id = $1 AND status = 'pending' AND parent_ticket_id IS NULL AND deleted_at IS NULL",
    [userId]
  );
  return row?.n ?? 0;
}

/** Earlier tickets of a requester (the requester card). */
export async function requesterHistory(requesterId: number | null, email: string, exceptId: number): Promise<{ count: number; last_at: string | null }> {
  const row = await hqOne<{ n: number; last_at: string | null }>(
    `SELECT count(*)::int AS n, max(created_at) AS last_at FROM hd_tickets
      WHERE id <> $3 AND parent_ticket_id IS NULL AND deleted_at IS NULL
        AND (($1::int IS NOT NULL AND requester_id = $1) OR ($1::int IS NULL AND $2 <> '' AND lower(requester_email) = lower($2)))`,
    [requesterId, email, exceptId]
  );
  return { count: row?.n ?? 0, last_at: row?.last_at ?? null };
}

/** The default calendar's timezone, for callers that format dates. */
export async function helpdeskTimezone(): Promise<string> {
  return (await hoursForTeam(null)).timezone;
}
