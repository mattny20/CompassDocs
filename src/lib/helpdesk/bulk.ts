// Helpdesk 1.19.1: bulk edits from the queue (agent V2). One patch
// (status, priority, team, assignee, tags to add and remove) applied to up
// to BULK_MAX tickets, each on its own through the same path and checks as
// the ticket PATCH route: the agent must work the ticket and hold
// tickets.bulk in its team, then every changed field needs its own desk
// capability (lib/helpdesk/patch-caps patchRefusal), a workflow task asks
// for its hand-off before it is solved, and updateTicket writes the
// timeline line and runs the after-commit hooks. A ticket that fails a
// check is skipped with the reason and the rest carry on; the caller gets
// a result per ticket. Merged tickets are skipped (change the one they were
// merged into). Server-only.

import "server-only";
import { canWorkTicket } from "./access";
import { hdCan } from "./roles";
import { patchRefusal } from "./patch-caps";
import { cleanTicketTags, getTicketByNumber, HdTicketError, parseTicketNumber, TICKET_LIMITS, updateTicket, validateTicketPatch } from "./tickets";
import { BULK_MAX, type HdBulkResult } from "./merge-shared";
import type { HdTicket, HdTicketPatch } from "./types";
import type { SessionUser } from "../types";

export { BULK_MAX };
export type { HdBulkResult };

export class HdBulkError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface BulkInput {
  numbers: number[];
  /** The field changes (validated like PATCH). */
  fields: Pick<HdTicketPatch, "status" | "priority" | "team_id" | "assignee_id">;
  add_tags: string[];
  remove_tags: string[];
}

/** Parse and check the body. Throws HdBulkError(400). */
export function validateBulkInput(raw: Record<string, unknown>): BulkInput {
  if (!Array.isArray(raw.numbers) || raw.numbers.length === 0) throw new HdBulkError("Choose at least one ticket.");
  if (raw.numbers.length > BULK_MAX) throw new HdBulkError(`Up to ${BULK_MAX} tickets at a time.`);
  const numbers: number[] = [];
  for (const v of raw.numbers) {
    const n = parseTicketNumber(v as string | number);
    if (!n) throw new HdBulkError("Ticket numbers only, like 1051.");
    if (!numbers.includes(n)) numbers.push(n);
  }
  const p = raw.patch;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new HdBulkError("Send the change as patch: { status, priority, team_id, assignee_id, add_tags, remove_tags }.");
  const patch = p as Record<string, unknown>;
  const allowed = new Set(["status", "priority", "team_id", "assignee_id", "add_tags", "remove_tags"]);
  const unknown = Object.keys(patch).find((k) => !allowed.has(k));
  if (unknown) throw new HdBulkError(`A bulk edit can't change "${unknown.slice(0, 40)}".`);
  let fields: BulkInput["fields"];
  try {
    const v = validateTicketPatch({ status: patch.status, priority: patch.priority, team_id: patch.team_id, assignee_id: patch.assignee_id });
    fields = { status: v.status, priority: v.priority, team_id: v.team_id, assignee_id: v.assignee_id };
    for (const k of Object.keys(fields) as (keyof typeof fields)[]) if (fields[k] === undefined) delete fields[k];
  } catch (e) {
    if (e instanceof HdTicketError) throw new HdBulkError(e.message);
    throw e;
  }
  const tags = (k: "add_tags" | "remove_tags"): string[] => {
    if (patch[k] === undefined) return [];
    const t = cleanTicketTags(patch[k]);
    if (!t) throw new HdBulkError(`Up to ${TICKET_LIMITS.tags} tags of up to ${TICKET_LIMITS.tag} characters.`);
    return t;
  };
  const add_tags = tags("add_tags");
  const remove_tags = tags("remove_tags").filter((t) => !add_tags.includes(t));
  if (!Object.keys(fields).length && !add_tags.length && !remove_tags.length) throw new HdBulkError("Choose what to change.");
  return { numbers, fields, add_tags, remove_tags };
}

const FIELD_REFUSAL: Record<string, string> = {
  status: "You can't change the status of this ticket.",
  priority: "You can't change the priority of this ticket.",
  team_id: "You can't move this ticket to another team.",
  assignee_id: "You can't assign this ticket to that person.",
};

/** The first field this agent may not change on `t`, as a sentence, or null. */
async function fieldRefusal(user: SessionUser, t: HdTicket, patch: HdTicketPatch): Promise<string | null> {
  for (const f of ["status", "priority", "team_id"] as const) {
    if (patch[f] === undefined) continue;
    if (await patchRefusal(user, t, { [f]: patch[f] })) return FIELD_REFUSAL[f];
  }
  if (patch.assignee_id !== undefined) {
    // The assignee's check reads the team it lands in (a move in the same edit).
    if (await patchRefusal(user, t, { assignee_id: patch.assignee_id, team_id: patch.team_id })) return FIELD_REFUSAL.assignee_id;
  }
  return null;
}

/** One ticket: the PATCH route's checks and write. Never throws for the ticket's own problems. */
async function applyOne(user: SessionUser, number: number, input: BulkInput, origin: string | undefined): Promise<HdBulkResult> {
  const t = await getTicketByNumber(number);
  if (!t || !(await canWorkTicket(user, t))) return { number, ok: false, error: "Not found in your queues." };
  if (!(await hdCan(user, "tickets.bulk", { teamId: t.team_id }))) {
    return { number, ok: false, error: t.team_name ? `You can't bulk edit ${t.team_name}'s tickets.` : "You can't bulk edit this ticket." };
  }
  if (t.merged_into) return { number, ok: false, error: "Merged into another ticket. Change that one instead." };
  const patch: HdTicketPatch = { ...input.fields };
  if (input.add_tags.length || input.remove_tags.length) {
    const next = [...(t.tags ?? []).filter((x) => !input.remove_tags.includes(x)), ...input.add_tags.filter((x) => !(t.tags ?? []).includes(x))];
    if (next.length > TICKET_LIMITS.tags) return { number, ok: false, error: `It would have more than ${TICKET_LIMITS.tags} tags.` };
    patch.tags = next;
  }
  const refused = await fieldRefusal(user, t, patch);
  if (refused) return { number, ok: false, error: refused };
  // A workflow task asks for its hand-off before it is solved (as PATCH: 409 there).
  if (t.source === "workflow" && (patch.status === "solved" || patch.status === "closed") && patch.status !== t.status) {
    const { validateTaskSolve } = await import("./engine");
    const missing = await validateTaskSolve(t.id);
    if (missing) return { number, ok: false, error: missing.error };
  }
  try {
    const r = await updateTicket(t.id, patch, { id: user.id, name: user.name || user.username, role: user.role }, { origin });
    if (!r) return { number, ok: false, error: "Not found in your queues." };
    if (r.changed.includes("assignee_id")) {
      const { recordManualAssignment } = await import("./assignment/engine");
      void recordManualAssignment(r.ticket.id, {
        fromUserId: r.before.assignee_id,
        toUserId: r.ticket.assignee_id,
        teamId: r.ticket.team_id,
        actorId: user.id,
      });
    }
    return { number, ok: true, changed: r.changed };
  } catch (e) {
    if (e instanceof HdTicketError) return { number, ok: false, error: e.message };
    console.error("[helpdesk] bulk edit:", e);
    return { number, ok: false, error: "Couldn't change this ticket. Try again." };
  }
}

/** Apply a bulk edit, one ticket after another, in the order given. */
export async function bulkUpdate(user: SessionUser, input: BulkInput, ctx: { origin?: string } = {}): Promise<HdBulkResult[]> {
  const out: HdBulkResult[] = [];
  for (const n of input.numbers) out.push(await applyOne(user, n, input, ctx.origin));
  return out;
}
