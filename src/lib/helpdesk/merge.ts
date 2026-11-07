// Helpdesk 1.19.1: merging tickets (agent V2). Duplicates are combined into
// one ticket the agent picks to keep; the others close with a link to it.
//
//   checks    every ticket must be one the agent works (canWorkTicket; a
//             ticket outside their queues answers like one that does not
//             exist) and in a team where they hold tickets.merge. Refused,
//             with a reason per ticket: a workflow task, a request whose
//             workflow is running, a ticket already merged elsewhere, a
//             closed ticket to keep, a newbie's reply still held for review,
//             a ticket on legal hold merged into one that is not (its
//             messages and files would lose the hold's protection from
//             retention and account removal, lib/helpdesk/retention).
//   one tx    rows locked in id order (FOR NO KEY UPDATE, so V3's CC inserts
//             referencing them don't wait on us). Each merged ticket's
//             messages, attachments, time entries and running timers move
//             to the kept one, keeping their times (hd_messages.merged_from
//             records "from #1051"); its CCs
//             and followers move (lib/helpdesk/ccs, V3); its requester
//             becomes a CC; tags are unioned. The merged ticket is closed
//             with merged_into and a "Merged into #1049" line. The kept
//             ticket keeps its number, SLA, assignee and status.
//   after     requesters of merged tickets hear of it when the agent asked
//             (a public note on their request, and hd_merged by email
//             through the notification policy); one audit row
//             helpdesk.ticket.merged. Closing does not run the solve hooks:
//             no survey or "solved" mail for a duplicate.
//
// Repeating a merge that already happened (the same tickets into the same
// one) changes nothing and answers ok. Undo-safe where possible: moved
// messages carry merged_from and the audit row lists the moved
// attachments, so the move can be reversed by hand. Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { hq, hqOne, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import { mdInline } from "./md-inline";
import { canWorkTicket } from "./access";
import { hdCan } from "./roles";
import { cleanTicketTags, getTicketByNumber, parseTicketNumber, TICKET_LIMITS } from "./tickets";
import { addCcs, moveCcs, moveFollowers } from "./ccs";
import { listNumbers, mergedNote, MERGE_MAX, type HdMergeInfo } from "./merge-shared";
import type { HdTicket, HdTicketRow } from "./types";
import type { Role } from "../types";

export const MERGE_LIMITS = {
  /** Tickets merged into one at a time. */
  max: MERGE_MAX,
  /** How far a reply follows merged_into (a merged ticket's target merged again). */
  hops: 5,
} as const;

export interface MergeActor {
  id: number;
  role: Role;
  name: string;
}

export interface MergeRefusal {
  number: number;
  reason: string;
}

export class HdMergeError extends Error {
  constructor(
    message: string,
    public status = 400,
    public refusals: MergeRefusal[] = []
  ) {
    super(message);
  }
}

export interface MergeInput {
  keep: number;
  merge: number[];
  notify: boolean;
}

export interface MergeResult {
  keep: { id: number; number: number; subject: string };
  merged: { id: number; number: number }[];
  /** Nothing changed: these tickets were already merged into `keep`. */
  already: boolean;
  moved: { messages: number; attachments: number; ccs: number; followers: number; requesters_ccd: number; time_entries: number; timers: number };
  /** For the audit row: undo by hand. */
  attachment_ids: number[];
}

/** Parse and check the body's shape. Throws HdMergeError(400). */
export function validateMergeInput(raw: Record<string, unknown>): MergeInput {
  const keep = parseTicketNumber(raw.keep as string | number);
  if (!keep) throw new HdMergeError("Choose the ticket to keep.");
  if (!Array.isArray(raw.merge) || raw.merge.length === 0) throw new HdMergeError("Choose at least one ticket to merge into it.");
  if (raw.merge.length > MERGE_LIMITS.max) throw new HdMergeError(`Up to ${MERGE_LIMITS.max} tickets at a time.`);
  const merge: number[] = [];
  for (const v of raw.merge) {
    const n = parseTicketNumber(v as string | number);
    if (!n) throw new HdMergeError("Ticket numbers only, like 1051.");
    if (n === keep) throw new HdMergeError(`#${keep} can't be merged into itself.`);
    if (!merge.includes(n)) merge.push(n);
  }
  if (raw.notify !== undefined && typeof raw.notify !== "boolean") throw new HdMergeError("notify must be true or false.");
  return { keep, merge, notify: raw.notify !== false };
}

async function runActive(ticketId: number, client?: HdQueryable): Promise<boolean> {
  const r = await hqOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM hd_workflow_runs WHERE ticket_id = $1 AND state IN ('running', 'waiting', 'blocked')`,
    [ticketId],
    client
  );
  return (r?.n ?? 0) > 0;
}

/**
 * Why `t` can't take part in a merge (as the one kept, or merged in), or
 * null. Access first: a ticket the agent doesn't work reads "not found".
 */
async function refusalFor(
  user: MergeActor,
  t: HdTicket | undefined,
  number: number,
  role: "keep" | "merge",
  keep: HdTicket | null
): Promise<string | null> {
  const keepId = keep?.id ?? null;
  if (!t || !(await canWorkTicket(user, t))) return `#${number} wasn't found in your queues.`;
  if (!(await hdCan(user, "tickets.merge", { teamId: t.team_id }))) {
    return t.team_name ? `You can't merge tickets in ${t.team_name}.` : "You can't merge this ticket.";
  }
  if (t.source === "workflow" || t.parent_ticket_id) return `#${number} is a task in a workflow, so it can't be merged.`;
  if (t.in_workflow || (await runActive(t.id))) return `#${number} has a workflow running. Let it finish or stop it first.`;
  const mergedInto = (t as HdTicketRow & { merged_into?: number | null }).merged_into ?? null;
  if (mergedInto && !(role === "merge" && mergedInto === keepId)) {
    const into = await hqOne<{ number: number }>("SELECT number FROM hd_tickets WHERE id = $1", [mergedInto]);
    return `#${number} was already merged into #${into?.number ?? "another ticket"}.`;
  }
  if (role === "keep" && t.status === "closed") return `#${number} is closed. Keep an open ticket, or reopen it first.`;
  const held = await hqOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND review_state = 'pending'",
    [t.id]
  );
  if ((held?.n ?? 0) > 0) return `#${number} has a reply waiting for review. Approve or return it first.`;
  if (role === "merge" && keep && isHeld(t) && !isHeld(keep)) return legalHoldRefusal(number, keep.number);
  return null;
}

/** hd_tickets.legal_hold (lib/helpdesk/retention-schema), read off the row. */
const isHeld = (t: object) => Number((t as { legal_hold?: number | null }).legal_hold ?? 0) === 1;

function legalHoldRefusal(number: number, keepNumber: number): string {
  return `#${number} is on legal hold. Take it off hold or put #${keepNumber} on hold first.`;
}

/** Load and check every ticket. Throws HdMergeError with every refusal (403 when only permissions, 404 when only unknown, else 409). */
export async function checkMerge(user: MergeActor, input: MergeInput): Promise<{ keep: HdTicket; merge: HdTicket[]; already: HdTicket[] }> {
  const keep = await getTicketByNumber(input.keep);
  const refusals: MergeRefusal[] = [];
  const keepWhy = await refusalFor(user, keep, input.keep, "keep", null);
  if (keepWhy) refusals.push({ number: input.keep, reason: keepWhy });
  const merge: HdTicket[] = [];
  const already: HdTicket[] = [];
  for (const n of input.merge) {
    const t = await getTicketByNumber(n);
    const why = await refusalFor(user, t, n, "merge", keep ?? null);
    if (why) refusals.push({ number: n, reason: why });
    else if (t && keep && (t as HdTicketRow & { merged_into?: number | null }).merged_into === keep.id) already.push(t);
    else if (t) merge.push(t);
  }
  if (refusals.length) {
    const all = (re: RegExp) => refusals.every((r) => re.test(r.reason));
    const status = all(/wasn't found/) ? 404 : all(/^You can't/) ? 403 : 409;
    const more = refusals.length > 1 ? ` (and ${refusals.length - 1} more)` : "";
    throw new HdMergeError(`${refusals[0].reason}${more}`, status, refusals);
  }
  return { keep: keep!, merge, already };
}

type LockedRow = HdTicketRow & { merged_into: number | null };

/**
 * Merge `input.merge` into `input.keep` as `user`. Checks first (throws
 * HdMergeError), then one transaction, then the requesters' notices and
 * the audit row's facts (the route writes the row). Never sends a solve
 * notice or survey for a merged ticket.
 */
export async function mergeTickets(user: MergeActor, input: MergeInput, ctx: { origin?: string } = {}): Promise<MergeResult> {
  const checked = await checkMerge(user, input);
  const keep = checked.keep;
  if (!checked.merge.length) {
    return {
      keep: { id: keep.id, number: keep.number, subject: keep.subject },
      merged: checked.already.map((t) => ({ id: t.id, number: t.number })),
      already: true,
      moved: { messages: 0, attachments: 0, ccs: 0, followers: 0, requesters_ccd: 0, time_entries: 0, timers: 0 },
      attachment_ids: [],
    };
  }
  const who = user.name || "Someone";
  const now = new Date();
  const res = await withTx(async (client) => {
    const ids = [keep.id, ...checked.merge.map((t) => t.id)].sort((a, b) => a - b);
    const locked = await hq<LockedRow>(`SELECT * FROM hd_tickets WHERE id = ANY($1::int[]) ORDER BY id FOR NO KEY UPDATE`, [ids], client);
    const byId = new Map(locked.map((r) => [r.id, r]));
    const k = byId.get(keep.id);
    // Re-checked under the locks: a concurrent merge got there first.
    if (!k || k.merged_into || k.status === "closed") throw new HdMergeError(`#${keep.number} changed while merging. Try again.`, 409);
    // 1.19.4 (C7): a ticket moved to the recycle bin meanwhile is neither kept nor merged.
    const binned = locked.find((r) => (r as { deleted_at?: string | null }).deleted_at);
    if (binned) throw new HdMergeError(`#${binned.number} was moved to the recycle bin while merging. Try again.`, 409);
    const moved = { messages: 0, attachments: 0, ccs: 0, followers: 0, requesters_ccd: 0, time_entries: 0, timers: 0 };
    const attachmentIds: number[] = [];
    const merged: { id: number; number: number; requester_id: number | null }[] = [];
    let tags = [...(k.tags ?? [])];
    for (const t of checked.merge) {
      const m = byId.get(t.id);
      if (!m) continue;
      if (m.merged_into) {
        if (m.merged_into === k.id) continue; // a concurrent identical merge
        throw new HdMergeError(`#${m.number} was merged elsewhere while merging. Try again.`, 409);
      }
      // Re-checked under the locks: a hold set or lifted meanwhile.
      if (isHeld(m) && !isHeld(k)) {
        const reason = legalHoldRefusal(m.number, k.number);
        throw new HdMergeError(reason, 409, [{ number: m.number, reason }]);
      }
      moved.messages += (
        await client.query(`UPDATE hd_messages SET ticket_id = $2, merged_from = COALESCE(merged_from, $3) WHERE ticket_id = $1`, [m.id, k.id, m.number])
      ).rowCount ?? 0;
      const att = await client.query<{ id: string | number }>(`UPDATE hd_attachments SET ticket_id = $2 WHERE ticket_id = $1 RETURNING id`, [m.id, k.id]);
      moved.attachments += att.rowCount ?? 0;
      attachmentIds.push(...att.rows.map((r) => Number(r.id)));
      // Time logged on the duplicate counts on the kept ticket; a running timer keeps running there.
      moved.time_entries += (await client.query("UPDATE hd_time_entries SET ticket_id = $2 WHERE ticket_id = $1", [m.id, k.id])).rowCount ?? 0;
      moved.timers += (await client.query("UPDATE hd_timers SET ticket_id = $2 WHERE ticket_id = $1", [m.id, k.id])).rowCount ?? 0;
      // 1.19.2: its checklists carry on on the kept ticket (agent W3, lib/helpdesk/checklists moveChecklistsTx).
      await (await import("./checklists")).moveChecklistsTx(client, m.id, k.id);
      // 1.19.3: its linked assets too, every one, even past ten (lib/helpdesk/assets moveAssetLinksTx).
      await (await import("./assets")).moveAssetLinksTx(client, m.id, k.id);
      // 1.19.4: where it lives in Teams or Slack too: desk replies keep reaching that chat (lib/helpdesk/chat/privacy).
      await (await import("./chat/privacy")).moveChatTx(client, m.id, k.id);
      moved.ccs += await moveCcs(m.id, k.id, client);
      moved.followers += await moveFollowers(m.id, k.id, client);
      // The merged ticket's requester follows the conversation as a CC
      // (addCcs skips the kept ticket's own requester and duplicates).
      if (m.requester_id || m.requester_email) {
        const r = await addCcs(
          k.id,
          [m.requester_id ? { userId: m.requester_id, name: m.requester_name } : { email: m.requester_email, name: m.requester_name }],
          { userId: user.id, name: who, role: user.role, via: "merge" },
          client
        );
        moved.requesters_ccd += r.added.length;
      }
      for (const tag of m.tags ?? []) if (!tags.includes(tag)) tags.push(tag);
      await client.query(
        `UPDATE hd_tickets SET status = 'closed', merged_into = $2, closed_at = $3, solved_at = COALESCE(solved_at, $3),
                updated_at = $3 WHERE id = $1`,
        [m.id, k.id, now]
      );
      await insertLine(client, m.id, user, "system", `Merged into #${k.number}`, now);
      merged.push({ id: m.id, number: m.number, requester_id: m.requester_id });
    }
    if (!merged.length) return null;
    // A union over the tag limit keeps the kept ticket's own first.
    tags = cleanTicketTags(tags.slice(0, TICKET_LIMITS.tags)) ?? k.tags ?? [];
    await client.query(`UPDATE hd_tickets SET tags = $2, updated_at = $3 WHERE id = $1`, [k.id, tags, now]);
    await insertLine(client, k.id, user, "internal", `${mdInline(who)} merged ${listNumbers(merged.map((m) => m.number))} into this ticket`, now);
    return { merged, moved, attachmentIds };
  });
  if (!res) {
    return {
      keep: { id: keep.id, number: keep.number, subject: keep.subject },
      merged: [],
      already: true,
      moved: { messages: 0, attachments: 0, ccs: 0, followers: 0, requesters_ccd: 0, time_entries: 0, timers: 0 },
      attachment_ids: [],
    };
  }
  // 1.19.2: a major incident's own ticket merged away ends the incident (agent W1, lib/helpdesk/incidents).
  for (const m of res.merged) await (await import("./incidents")).onIncidentTicketEnded(m.id, who);
  if (input.notify) {
    const { addSystemMessage } = await import("./messages");
    const { notifyMerged } = await import("./notify");
    for (const m of res.merged) {
      await addSystemMessage(m.id, mergedNote(keep.number), { author: { id: user.id, name: who } }).catch((e) =>
        console.error("[helpdesk] merge note:", e)
      );
      void notifyMerged(m.id, keep.number, { origin: ctx.origin, actorId: user.id, actorName: who });
    }
  }
  // 1.19.4: webhooks hear that each merged ticket was closed (ticket.updated, then ticket.solved when it was still
  // open), and of the kept ticket's tags when the merge added any (C2, lib/helpdesk/webhooks; never throws).
  {
    const { emitHelpdeskWebhookEvent } = await import("./webhooks");
    const hookActor = { id: user.id, name: who };
    for (const m of res.merged) {
      const was = checked.merge.find((t) => t.id === m.id)?.status;
      await emitHelpdeskWebhookEvent("ticket.updated", { ticketId: m.id, changed: ["status"], actor: hookActor, origin: ctx.origin });
      if (was !== "solved" && was !== "closed") await emitHelpdeskWebhookEvent("ticket.solved", { ticketId: m.id, actor: hookActor, origin: ctx.origin });
    }
    const after = await hqOne<{ tags: string[] }>("SELECT tags FROM hd_tickets WHERE id = $1", [keep.id]);
    if (after && JSON.stringify(after.tags ?? []) !== JSON.stringify(keep.tags ?? [])) {
      await emitHelpdeskWebhookEvent("ticket.updated", { ticketId: keep.id, changed: ["tags"], actor: hookActor, origin: ctx.origin });
    }
  }
  return {
    keep: { id: keep.id, number: keep.number, subject: keep.subject },
    merged: res.merged.map((m) => ({ id: m.id, number: m.number })),
    already: false,
    moved: res.moved,
    attachment_ids: res.attachmentIds,
  };
}

export { listNumbers, mergedNote };

async function insertLine(client: PoolClient, ticketId: number, user: MergeActor, kind: "system" | "internal", body: string, at: Date): Promise<void> {
  await client.query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at) VALUES ($1, $2, $3, $4, $5, 'system', $6)`,
    [ticketId, user.id, user.name, kind, body, at]
  );
}

// --- Reads -------------------------------------------------------------------------

export type { HdMergeInfo };

/** What the ticket pane shows about merges (agents only). */
export async function mergeInfo(ticketId: number): Promise<HdMergeInfo> {
  const [into, mergedIn, origins] = await Promise.all([
    // 1.19.4 (C7): a kept ticket in the recycle bin is "a deleted ticket"; binned sources aren't listed.
    hqOne<{ number: number; subject: string; deleted: boolean }>(
      `SELECT CASE WHEN p.deleted_at IS NULL THEN p.number ELSE 0 END AS number, CASE WHEN p.deleted_at IS NULL THEN p.subject ELSE '' END AS subject,
              (p.deleted_at IS NOT NULL) AS deleted
         FROM hd_tickets t JOIN hd_tickets p ON p.id = t.merged_into WHERE t.id = $1`,
      [ticketId]
    ),
    hq<{ number: number; subject: string }>("SELECT number, subject FROM hd_tickets WHERE merged_into = $1 AND deleted_at IS NULL ORDER BY number", [ticketId]),
    hq<{ id: number; merged_from: number }>("SELECT id, merged_from FROM hd_messages WHERE ticket_id = $1 AND merged_from IS NOT NULL", [ticketId]),
  ]);
  return {
    into: into ? (into.deleted ? { number: 0, subject: "", deleted: true } : { number: into.number, subject: into.subject }) : null,
    merged_in: mergedIn,
    message_origins: Object.fromEntries(origins.map((o) => [o.id, Number(o.merged_from)])),
  };
}

/**
 * Inbound email (lib/helpdesk/inbound): a reply on a merged ticket's thread
 * belongs to the ticket it was merged into (following a chain of merges).
 * Answers `t` itself when it was not merged.
 */
export async function mergedReplyTarget(t: HdTicketRow): Promise<HdTicketRow> {
  let cur = t as LockedRow;
  for (let i = 0; i < MERGE_LIMITS.hops && cur.merged_into; i++) {
    const next = await hqOne<LockedRow>("SELECT * FROM hd_tickets WHERE id = $1", [cur.merged_into]);
    if (!next) break;
    cur = next;
  }
  return cur;
}

/**
 * 1.19.1 (integration): a merged ticket is read-only for its conversation
 * and status. Its messages and people moved to the kept ticket, so a reply,
 * a note or a reopen here would land where nobody follows it. The refusal
 * names the ticket to work on instead; null when `t` was not merged.
 */
export async function mergedLock(t: HdTicketRow): Promise<string | null> {
  const into = (t as LockedRow).merged_into;
  if (!into) return null;
  const target = await mergedReplyTarget(t);
  // 1.19.4 (C7): never name a kept ticket that is in the recycle bin.
  if ((target as { deleted_at?: string | null }).deleted_at) return `#${t.number} was merged into a ticket that has since been deleted.`;
  const n = target.id !== t.id ? target.number : null;
  return n ? `#${t.number} was merged into #${n}. Reply and change its status on #${n}.` : `#${t.number} was merged into another ticket.`;
}
