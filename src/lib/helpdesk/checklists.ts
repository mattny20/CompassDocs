// Helpdesk 1.19.2: checklists on tickets (agent W3; schema in
// lib/helpdesk/checklists-schema, shapes in checklists-shared).
//
//   templates   Desk settings → Checklists: reusable lists of items (title,
//               Required, an optional owner team, an optional due offset in
//               business days). A template may name request types: every
//               new request of those types gets it (afterTicketCreated, via
//               addRequestTypeChecklists). A workflow task step may name
//               templates (checklist_ids): its task ticket gets them when it
//               starts (engine startTask → addTaskChecklistsTx).
//   on a ticket a copy of the template, made when it is added (by hand,
//               by the request type or by the workflow); a later template
//               edit never changes it. A ticket holds several. Each item's
//               due date is counted when the checklist is added: due_days
//               business days after that day, in the owner team's calendar
//               (else the ticket's team's), at the close of that day
//               (lib/helpdesk/business-waits-shared shiftBusinessDays,
//               agent L's calendars). Agents add one-off items too.
//   timeline    adding, removing, ticking and unticking leave an internal
//               (agent-only) line; the routes audit them.
//   solving     a required item that is not ticked blocks solving:
//               lib/helpdesk/tickets updateTicket asks checklistSolveBlockTx
//               inside its transaction, so the desk's Solve and `e`, Send and
//               set Solved, macros, bulk edit, automations, alert intake and
//               the Claude connector's hd_update_ticket are all refused with
//               the same sentence (CHECKLIST_BLOCK_PREFIX). The routes that
//               would post a reply first ask checklistSolveRefusal before
//               anything is written. A workflow's Finish step leaves the
//               request open with a note instead (engine evalFinish), and a
//               task's "Mark done" is refused (recordTaskOutcome).
//               Not blocked, by design: a declined request closed by its
//               workflow, a task recorded as "can't be done", merging (the
//               merged ticket is closed, not solved; its checklists move to
//               the kept ticket), and retention's auto-close (solved →
//               closed; it was already solved).
//   privacy     agents who work the ticket only. Requesters, CCs and portal
//               customers never read checklists: no requester route returns
//               them and every timeline line is internal. The Claude
//               connector's hd_read_ticket (agents) lists them.
//
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { hq, hqOne, withTx, type HdQueryable } from "./db-core";
import { hoursForTeam } from "./calendars";
import { shiftBusinessDays } from "./business-waits-shared";
import { wallClock } from "./sla";
import { HD_OPEN_STATUSES } from "./types";
// Names and titles in system-written notes are Markdown-escaped (1.19.4 review).
import { mdInline } from "./md-inline";
import type { HdStatus } from "./types";
import {
  checkTemplateInput,
  checklistBlockMessage,
  CHECKLIST_LIMITS,
  type HdChecklistSource,
  type HdChecklistTemplate,
  type HdChecklistTemplateInput,
  type HdChecklistTemplateRow,
  type HdTicketChecklist,
  type HdTicketChecklistItem,
} from "./checklists-shared";

export * from "./checklists-shared";

export class ChecklistError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface ChecklistActor {
  id: number | null;
  name: string;
}

// --- Templates ------------------------------------------------------------------------

const TEMPLATE_COLS = "id, name, items, request_type_ids, created_at, updated_at";

export async function listTemplates(): Promise<HdChecklistTemplate[]> {
  return hq<HdChecklistTemplate>(`SELECT ${TEMPLATE_COLS} FROM hd_checklist_templates ORDER BY lower(name), id`);
}

export async function getTemplate(id: number, client?: HdQueryable): Promise<HdChecklistTemplate | undefined> {
  return hqOne<HdChecklistTemplate>(`SELECT ${TEMPLATE_COLS} FROM hd_checklist_templates WHERE id = $1`, [id], client);
}

interface StepLike {
  kind?: string;
  key?: string;
  title?: string;
  checklist_ids?: number[];
  steps?: StepLike[];
}

/** Every task of a stored definition that names checklists, with its workflow. */
async function workflowUses(): Promise<{ workflow_id: number; workflow: string; task: string; ids: number[]; draft: boolean }[]> {
  const rows = await hq<{ id: number; title: string; definition: { steps?: StepLike[] } | null; draft: { steps?: StepLike[] } | null; published: number }>(
    "SELECT id, title, definition, draft, published FROM hd_workflows"
  );
  const out: { workflow_id: number; workflow: string; task: string; ids: number[]; draft: boolean }[] = [];
  const scan = (w: (typeof rows)[number], steps: StepLike[] | undefined, draft: boolean) => {
    for (const s of steps ?? []) {
      const tasks = s.kind === "task" ? [s] : s.kind === "parallel" ? s.steps ?? [] : [];
      for (const t of tasks) if (Array.isArray(t.checklist_ids) && t.checklist_ids.length) out.push({ workflow_id: w.id, workflow: w.title, task: t.title ?? "", ids: t.checklist_ids, draft });
    }
  };
  for (const w of rows) {
    if (w.published) scan(w, w.definition?.steps, false);
    if (w.draft) scan(w, w.draft.steps, true);
  }
  return out;
}

/** The settings list: each template, what adds it automatically, and how many tickets it was added to. */
export async function listTemplateRows(): Promise<HdChecklistTemplateRow[]> {
  const [templates, used, types, uses] = await Promise.all([
    listTemplates(),
    hq<{ template_id: number; n: number }>("SELECT template_id, count(*)::int AS n FROM hd_ticket_checklists WHERE template_id IS NOT NULL GROUP BY template_id"),
    hq<{ id: number; title: string }>("SELECT id, title FROM hd_request_types"),
    workflowUses(),
  ]);
  const usedBy = new Map(used.map((u) => [u.template_id, u.n]));
  const typeName = new Map(types.map((t) => [t.id, t.title]));
  return templates.map((t) => {
    const added: string[] = [];
    for (const id of t.request_type_ids ?? []) {
      const n = typeName.get(id);
      if (n) added.push(`Request type ${n}`);
    }
    for (const u of uses) {
      if (!u.draft && u.ids.includes(t.id)) {
        const line = `${/workflow$/i.test(u.workflow) ? u.workflow : `${u.workflow} workflow`} · task ${u.task}`;
        if (!added.includes(line)) added.push(line);
      }
    }
    return { ...t, request_type_ids: (t.request_type_ids ?? []).filter((id) => typeName.has(id)), used: usedBy.get(t.id) ?? 0, added_to: added };
  });
}

/** Teams and request types the input names exist. */
async function checkTemplateRefs(input: HdChecklistTemplateInput): Promise<void> {
  const teamIds = [...new Set(input.items.map((i) => i.team_id).filter((x): x is number => !!x))];
  if (teamIds.length) {
    const found = await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1::int[])", [teamIds]);
    if (found.length !== teamIds.length) throw new ChecklistError("One of the owner teams no longer exists. Pick another.");
  }
  if (input.request_type_ids.length) {
    const found = await hq<{ id: number }>("SELECT id FROM hd_request_types WHERE id = ANY($1::int[])", [input.request_type_ids]);
    if (found.length !== input.request_type_ids.length) throw new ChecklistError("One of the request types no longer exists.");
  }
}

function checked(raw: unknown): HdChecklistTemplateInput {
  const c = checkTemplateInput(raw);
  if (!c.ok) throw new ChecklistError(c.error);
  return c.value;
}

export async function createTemplate(raw: unknown, actor: ChecklistActor): Promise<HdChecklistTemplate> {
  const input = checked(raw);
  await checkTemplateRefs(input);
  const n = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_checklist_templates");
  if ((n?.n ?? 0) >= CHECKLIST_LIMITS.templates) throw new ChecklistError(`Up to ${CHECKLIST_LIMITS.templates} checklists. Delete one you no longer use.`, 409);
  return (await hqOne<HdChecklistTemplate>(
    `INSERT INTO hd_checklist_templates (name, items, request_type_ids, created_by) VALUES ($1, $2, $3, $4) RETURNING ${TEMPLATE_COLS}`,
    [input.name, JSON.stringify(input.items), input.request_type_ids, actor.id]
  ))!;
}

/** Update a template (name, items, request types). Tickets keep the copy they have. */
export async function updateTemplate(id: number, raw: unknown): Promise<{ before: HdChecklistTemplate; after: HdChecklistTemplate } | undefined> {
  const before = await getTemplate(id);
  if (!before) return undefined;
  const r = (raw ?? {}) as Record<string, unknown>;
  const input = checked({
    name: r.name ?? before.name,
    items: r.items ?? before.items,
    request_type_ids: r.request_type_ids ?? before.request_type_ids,
  });
  await checkTemplateRefs(input);
  const after = await hqOne<HdChecklistTemplate>(
    `UPDATE hd_checklist_templates SET name = $2, items = $3, request_type_ids = $4, updated_at = now() WHERE id = $1 RETURNING ${TEMPLATE_COLS}`,
    [id, input.name, JSON.stringify(input.items), input.request_type_ids]
  );
  return after ? { before, after } : undefined;
}

/** Delete a template. Refused while a workflow task adds it (409). Tickets keep their copies. */
export async function deleteTemplate(id: number): Promise<HdChecklistTemplate | undefined> {
  const t = await getTemplate(id);
  if (!t) return undefined;
  const use = (await workflowUses()).find((u) => u.ids.includes(id));
  if (!use) {
    // A run on its way walks the definition it pinned, which may still name it.
    const live = await liveRunUse(id);
    if (live) throw new ChecklistError(`A run of the ${live} workflow that's on its way still adds it. Delete it once that run has finished.`, 409);
  }
  if (use) {
    throw new ChecklistError(
      `The ${use.workflow} workflow adds it in "${use.task}"${use.draft ? " (in its draft)" : ""}. Take it off that task first.`,
      409
    );
  }
  return hqOne<HdChecklistTemplate>(`DELETE FROM hd_checklist_templates WHERE id = $1 RETURNING ${TEMPLATE_COLS}`, [id]);
}

/** The title of a live run's workflow whose pinned definition adds template `id`, or null. */
async function liveRunUse(id: number): Promise<string | null> {
  const r = await hqOne<{ title: string }>(
    `SELECT coalesce(r.current->>'workflow_title', w.title, 'workflow') AS title
       FROM hd_workflow_runs r LEFT JOIN hd_workflows w ON w.id = r.workflow_id
      WHERE r.state IN ('running', 'waiting', 'blocked')
        AND (jsonb_path_exists(r.current->'definition', '$.steps[*].checklist_ids[*] ? (@ == $id)', jsonb_build_object('id', $1::int))
          OR jsonb_path_exists(r.current->'definition', '$.steps[*].steps[*].checklist_ids[*] ? (@ == $id)', jsonb_build_object('id', $1::int)))
      LIMIT 1`,
    [id]
  );
  return r?.title ?? null;
}

/** For lib/helpdesk/workflows checkWorkflowRefs: the checklists a task names exist. Null when fine. */
export async function missingChecklistRef(ids: number[], taskTitle: string): Promise<string | null> {
  if (!ids.length) return null;
  const found = await hq<{ id: number }>("SELECT id FROM hd_checklist_templates WHERE id = ANY($1::int[])", [ids]);
  if (found.length === ids.length) return null;
  return `"${taskTitle}" adds a checklist that no longer exists. Pick it again in the task's Checklists.`;
}

// --- On a ticket -------------------------------------------------------------------------

type ItemRow = {
  id: number;
  checklist_id: number;
  title: string;
  required: number;
  team_id: number | null;
  team_name: string | null;
  due_date: string | null;
  due_at: string | null;
  done_at: string | null;
  done_by_name: string;
};

type ListRow = {
  id: number;
  name: string;
  template_id: number | null;
  source: HdChecklistSource;
  added_by_name: string;
  created_at: string;
};

const ITEM_SELECT = `SELECT i.id, i.checklist_id, i.title, i.required, i.team_id, tm.name AS team_name,
         to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.due_at, i.done_at, i.done_by_name
    FROM hd_ticket_checklist_items i LEFT JOIN hd_teams tm ON tm.id = i.team_id`;

function itemOut(r: ItemRow): HdTicketChecklistItem {
  return {
    id: r.id,
    title: r.title,
    required: r.required === 1,
    team_id: r.team_id,
    team_name: r.team_name,
    due_date: r.due_date,
    due_at: r.due_at,
    done: !!r.done_at,
    done_at: r.done_at,
    done_by_name: r.done_by_name,
  };
}

/** A ticket's checklists in the order they were added, items in order, with progress. */
export async function ticketChecklists(ticketId: number, client?: HdQueryable): Promise<HdTicketChecklist[]> {
  const lists = await hq<ListRow>(
    "SELECT id, name, template_id, source, added_by_name, created_at FROM hd_ticket_checklists WHERE ticket_id = $1 ORDER BY id",
    [ticketId],
    client
  );
  if (!lists.length) return [];
  const items = await hq<ItemRow>(`${ITEM_SELECT} WHERE i.ticket_id = $1 ORDER BY i.checklist_id, i.position, i.id`, [ticketId], client);
  return lists.map((l) => {
    const mine = items.filter((i) => i.checklist_id === l.id).map(itemOut);
    return {
      ...l,
      items: mine,
      done: mine.filter((i) => i.done).length,
      total: mine.length,
      required_open: mine.filter((i) => i.required && !i.done).length,
    };
  });
}

async function timeline(client: HdQueryable, ticketId: number, actor: ChecklistActor | null, body: string, now: Date): Promise<void> {
  await client.query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at) VALUES ($1, $2, $3, 'internal', $4, 'system', $5)`,
    [ticketId, actor?.id ?? null, actor?.name ?? "", body.slice(0, 2000), now]
  );
}

/** Local YYYY-MM-DD of `t` in `tz`. */
function localDate(t: number, tz: string): string {
  const w = wallClock(t, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/**
 * An item's due: `days` business days after the day it's added, in the
 * team's calendar, at that day's close. Added after the day's close, or on
 * a day that isn't a business day, it counts from the next business day,
 * so "due the day it's added" is never overdue the moment it's added.
 */
export async function itemDue(days: number, teamId: number | null, now: Date, client?: HdQueryable): Promise<{ date: string; at: Date } | null> {
  const hours = await hoursForTeam(teamId, client);
  const today = localDate(now.getTime(), hours.timezone);
  const first = shiftBusinessDays(today, 0, hours, "close");
  if (!first.date || first.at === null) return null;
  let anchor = first.date;
  if (first.date === today && first.at <= now.getTime()) {
    const next = shiftBusinessDays(today, 1, hours, "close");
    if (!next.date) return null;
    anchor = next.date;
  }
  const r = days === 0 && anchor === first.date ? first : shiftBusinessDays(anchor, days, hours, "close");
  return r.date && r.at !== null ? { date: r.date, at: new Date(r.at) } : null;
}

export interface AddChecklistOpts {
  source: HdChecklistSource;
  /** The workflow step key, for a task's checklist. */
  source_ref?: string;
  now?: Date;
  /** Who it's said to be by on the timeline when there is no actor ("The workflow"). */
  byLine?: string;
}

/**
 * Copy template `templateId` onto the ticket, in the caller's transaction.
 * The same template twice on one ticket is refused (409; automatic
 * additions answer `already` instead). Undefined when the template is gone.
 *
 * The ten-a-ticket limit (CHECKLIST_LIMITS.perTicket) is for adding: by
 * hand it is a 409 at ten or more; an automatic addition (request type,
 * workflow task) on a full ticket answers `full` and leaves an internal
 * line saying which checklist wasn't added and why (1.19.4). A merge may
 * leave a ticket with more than ten (moveChecklistsTx), as with assets; the
 * card and the solve gate read every one.
 */
export async function addChecklistTx(
  client: HdQueryable,
  ticketId: number,
  templateId: number,
  actor: ChecklistActor | null,
  opts: AddChecklistOpts
): Promise<{ checklist_id: number; name: string; already: boolean; full?: boolean } | undefined> {
  const tpl = await getTemplate(templateId, client);
  if (!tpl) return undefined;
  const t = await hqOne<{ id: number; team_id: number | null }>("SELECT id, team_id FROM hd_tickets WHERE id = $1", [ticketId], client);
  if (!t) return undefined;
  const existing = await hq<{ id: number; template_id: number | null }>("SELECT id, template_id FROM hd_ticket_checklists WHERE ticket_id = $1", [ticketId], client);
  const same = existing.find((e) => e.template_id === templateId);
  if (same) {
    if (opts.source === "manual") throw new ChecklistError(`"${tpl.name}" is already on this ticket.`, 409);
    return { checklist_id: same.id, name: tpl.name, already: true };
  }
  const now = opts.now ?? new Date();
  if (existing.length >= CHECKLIST_LIMITS.perTicket) {
    if (opts.source === "manual") throw new ChecklistError(`A ticket holds up to ${CHECKLIST_LIMITS.perTicket} checklists.`, 409);
    const by = opts.byLine || "An automatic rule";
    await timeline(client, ticketId, null, `${by} didn't add the checklist "${mdInline(tpl.name)}": a ticket holds up to ${CHECKLIST_LIMITS.perTicket} checklists. An agent can remove one and add it by hand.`, now);
    return { checklist_id: 0, name: tpl.name, already: false, full: true };
  }
  const c = await hqOne<{ id: number }>(
    `INSERT INTO hd_ticket_checklists (ticket_id, template_id, name, source, source_ref, added_by, added_by_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [ticketId, templateId, tpl.name, opts.source, opts.source_ref ?? "", actor?.id ?? null, actor?.name ?? "", now],
    client
  );
  const teams = new Set((await hq<{ id: number }>("SELECT id FROM hd_teams", [], client)).map((r) => r.id));
  for (const [i, item] of (tpl.items ?? []).entries()) {
    const team = item.team_id && teams.has(item.team_id) ? item.team_id : null;
    const due = item.due_days !== undefined && item.due_days !== null ? await itemDue(item.due_days, team ?? t.team_id, now, client) : null;
    await client.query(
      `INSERT INTO hd_ticket_checklist_items (checklist_id, ticket_id, position, title, required, team_id, due_date, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [c!.id, ticketId, i, item.title, item.required ? 1 : 0, team, due?.date ?? null, due?.at ?? null]
    );
  }
  const by = mdInline(actor?.name) || opts.byLine || "Someone";
  await timeline(client, ticketId, actor, `${by} added the checklist "${mdInline(tpl.name)}"`, now);
  return { checklist_id: c!.id, name: tpl.name, already: false };
}

/** Add a template by hand (an agent who works the ticket). */
export async function addChecklistToTicket(ticketId: number, templateId: number, actor: ChecklistActor) {
  const r = await withTx(async (client) => {
    await client.query("SELECT 1 FROM hd_tickets WHERE id = $1 FOR UPDATE", [ticketId]);
    return addChecklistTx(client, ticketId, templateId, actor, { source: "manual" });
  });
  if (!r) throw new ChecklistError("That checklist no longer exists.", 404);
  return r;
}

/** A new request's checklists from its request type (lib/helpdesk/events afterTicketCreated). Answers how many were added. */
export async function addRequestTypeChecklists(ticketId: number): Promise<number> {
  const t = await hqOne<{ request_type_id: number | null; rt_title: string | null }>(
    "SELECT t.request_type_id, rt.title AS rt_title FROM hd_tickets t LEFT JOIN hd_request_types rt ON rt.id = t.request_type_id WHERE t.id = $1",
    [ticketId]
  );
  if (!t?.request_type_id) return 0;
  const tpls = await hq<{ id: number }>("SELECT id FROM hd_checklist_templates WHERE $1 = ANY(request_type_ids) ORDER BY id", [t.request_type_id]);
  if (!tpls.length) return 0;
  return withTx(async (client) => {
    let n = 0;
    for (const tpl of tpls) {
      const r = await addChecklistTx(client, ticketId, tpl.id, null, { source: "request_type", byLine: `The request type ${mdInline(t.rt_title)}`.trim() });
      if (r && !r.already && !r.full) n++;
    }
    return n;
  });
}

/** A workflow task's checklists on its new task ticket (engine startTask, inside the run's transaction). */
export async function addTaskChecklistsTx(client: HdQueryable, taskTicketId: number, ids: number[] | undefined, stepKey: string, now: Date): Promise<void> {
  for (const id of ids ?? []) {
    const r = await addChecklistTx(client, taskTicketId, id, null, { source: "workflow", source_ref: stepKey, now, byLine: "The workflow" });
    if (!r) await timeline(client, taskTicketId, null, "The workflow's checklist for this task no longer exists, so none was added. Check the task in the workflow builder.", now);
  }
}

async function itemOn(client: HdQueryable, ticketId: number, itemId: number, lock = false) {
  return hqOne<ItemRow & { checklist_name: string }>(
    `SELECT c.name AS checklist_name, i.id, i.checklist_id, i.title, i.required, i.team_id, tm.name AS team_name,
            to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.due_at, i.done_at, i.done_by_name
       FROM hd_ticket_checklist_items i
       JOIN hd_ticket_checklists c ON c.id = i.checklist_id
       LEFT JOIN hd_teams tm ON tm.id = i.team_id
      WHERE i.id = $1 AND i.ticket_id = $2${lock ? " FOR UPDATE OF i" : ""}`,
    [itemId, ticketId],
    client
  );
}

/** Tick or untick an item. `changed` false when it already was. A timeline line when it changes. */
export async function setItemDone(
  ticketId: number,
  itemId: number,
  done: boolean,
  actor: ChecklistActor
): Promise<{ item: HdTicketChecklistItem; checklist: string; changed: boolean }> {
  const now = new Date();
  return withTx(async (client) => {
    // The ticket row first, as updateTicket takes it: a tick and a solve never interleave.
    await client.query("SELECT 1 FROM hd_tickets WHERE id = $1 FOR NO KEY UPDATE", [ticketId]);
    const it = await itemOn(client, ticketId, itemId, true);
    if (!it) throw new ChecklistError("That item isn't on this ticket.", 404);
    if (!!it.done_at === done) return { item: itemOut(it), checklist: it.checklist_name, changed: false };
    await client.query(
      "UPDATE hd_ticket_checklist_items SET done_at = $2, done_by = $3, done_by_name = $4 WHERE id = $1",
      done ? [itemId, now, actor.id, actor.name] : [itemId, null, null, ""]
    );
    await timeline(client, ticketId, actor, `${mdInline(actor.name) || "Someone"} ${done ? "ticked" : "unticked"} "${mdInline(it.title)}" (${mdInline(it.checklist_name)})`, now);
    const after = await itemOn(client, ticketId, itemId);
    return { item: itemOut(after!), checklist: it.checklist_name, changed: true };
  });
}

/** Add a one-off item (never required) to a ticket's checklist. */
export async function addItem(ticketId: number, checklistId: number, rawTitle: unknown, actor: ChecklistActor): Promise<{ item: HdTicketChecklistItem; checklist: string }> {
  const title = typeof rawTitle === "string" ? rawTitle.trim().replace(/\s+/g, " ") : "";
  if (!title) throw new ChecklistError("Write the item.");
  if (title.length > CHECKLIST_LIMITS.itemTitle) throw new ChecklistError(`Keep the item under ${CHECKLIST_LIMITS.itemTitle} characters.`);
  const now = new Date();
  return withTx(async (client) => {
    const c = await hqOne<{ id: number; name: string }>("SELECT id, name FROM hd_ticket_checklists WHERE id = $1 AND ticket_id = $2 FOR UPDATE", [checklistId, ticketId], client);
    if (!c) throw new ChecklistError("That checklist isn't on this ticket.", 404);
    const n = await hqOne<{ n: number; pos: number }>(
      "SELECT count(*)::int AS n, coalesce(max(position), -1)::int + 1 AS pos FROM hd_ticket_checklist_items WHERE checklist_id = $1",
      [checklistId],
      client
    );
    if ((n?.n ?? 0) >= CHECKLIST_LIMITS.items) throw new ChecklistError(`A checklist holds up to ${CHECKLIST_LIMITS.items} items.`, 409);
    const row = await hqOne<{ id: number }>(
      "INSERT INTO hd_ticket_checklist_items (checklist_id, ticket_id, position, title) VALUES ($1, $2, $3, $4) RETURNING id",
      [checklistId, ticketId, n?.pos ?? 0, title],
      client
    );
    await timeline(client, ticketId, actor, `${mdInline(actor.name) || "Someone"} added "${mdInline(title)}" to ${mdInline(c.name)}`, now);
    const it = await itemOn(client, ticketId, row!.id);
    return { item: itemOut(it!), checklist: c.name };
  });
}

/** Take a checklist off a ticket. */
export async function removeChecklist(ticketId: number, checklistId: number, actor: ChecklistActor): Promise<{ name: string; open_required: number } | undefined> {
  const now = new Date();
  return withTx(async (client) => {
    const c = await hqOne<{ id: number; name: string }>("SELECT id, name FROM hd_ticket_checklists WHERE id = $1 AND ticket_id = $2 FOR UPDATE", [checklistId, ticketId], client);
    if (!c) return undefined;
    const open = await hqOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM hd_ticket_checklist_items WHERE checklist_id = $1 AND required = 1 AND done_at IS NULL",
      [checklistId],
      client
    );
    await client.query("DELETE FROM hd_ticket_checklists WHERE id = $1", [checklistId]);
    await timeline(client, ticketId, actor, `${mdInline(actor.name) || "Someone"} removed the checklist "${mdInline(c.name)}"`, now);
    return { name: c.name, open_required: open?.n ?? 0 };
  });
}

// --- Solving ---------------------------------------------------------------------------

/** The required items on the ticket that are not ticked, in order. */
export async function requiredOpenItems(ticketId: number, client?: HdQueryable): Promise<{ id: number; title: string; checklist: string }[]> {
  return hq<{ id: number; title: string; checklist: string }>(
    `SELECT i.id, i.title, c.name AS checklist FROM hd_ticket_checklist_items i JOIN hd_ticket_checklists c ON c.id = i.checklist_id
      WHERE i.ticket_id = $1 AND i.required = 1 AND i.done_at IS NULL ORDER BY c.id, i.position, i.id`,
    [ticketId],
    client
  );
}

/** A workflow task recorded as "can't be done" closes whatever its checklist says. */
async function cantDoTask(ticketId: number, client?: HdQueryable): Promise<boolean> {
  const r = await hqOne<{ x: number }>(
    "SELECT 1 AS x FROM hd_workflow_steps WHERE task_ticket_id = $1 AND result->>'outcome' = 'cant_do' LIMIT 1",
    [ticketId],
    client
  );
  return !!r;
}

/**
 * May this ticket be solved as far as its checklists go? Null when yes;
 * otherwise the refusal ({ error, open }). The routes that would write a
 * reply first ask this; updateTicket enforces it (checklistSolveBlockTx).
 */
export async function checklistSolveRefusal(ticketId: number, client?: HdQueryable): Promise<null | { error: string; code: "checklist_required"; open: { id: number; title: string; checklist: string }[] }> {
  const open = await requiredOpenItems(ticketId, client);
  if (!open.length) return null;
  if (await cantDoTask(ticketId, client)) return null;
  return { error: checklistBlockMessage(open), code: "checklist_required", open };
}

/**
 * lib/helpdesk/tickets updateTicket, inside its transaction: leaving the open
 * statuses for solved or closed with a required item not ticked answers the
 * refusal sentence, which updateTicket throws as HdTicketError 409 (thrown
 * there, so the routes' instanceof sees the class they imported).
 */
export async function checklistSolveBlockTx(client: PoolClient, ticketId: number, from: HdStatus, to: HdStatus): Promise<string | null> {
  if ((to !== "solved" && to !== "closed") || !HD_OPEN_STATUSES.includes(from)) return null;
  return (await checklistSolveRefusal(ticketId, client))?.error ?? null;
}

// --- Merge, retention, the connector ----------------------------------------------------

/**
 * lib/helpdesk/merge, inside its transaction: the merged ticket's checklists
 * move to the kept ticket, except one from a template the kept ticket
 * already has (that copy stays on the merged ticket). Answers how many moved.
 * Every other one moves, even past CHECKLIST_LIMITS.perTicket: the limit is
 * for adding (addChecklistTx), as with assets (1.19.4), so a merge never
 * leaves required work behind on a closed ticket.
 */
export async function moveChecklistsTx(client: HdQueryable, fromId: number, toId: number): Promise<number> {
  const moved = await client.query<{ id: number }>(
    `UPDATE hd_ticket_checklists c SET ticket_id = $2
      WHERE c.ticket_id = $1
        AND (c.template_id IS NULL OR NOT EXISTS (SELECT 1 FROM hd_ticket_checklists k WHERE k.ticket_id = $2 AND k.template_id = c.template_id))
      RETURNING c.id`,
    [fromId, toId]
  );
  const ids = moved.rows.map((r) => r.id);
  if (ids.length) await client.query("UPDATE hd_ticket_checklist_items SET ticket_id = $2 WHERE checklist_id = ANY($1::int[])", [ids, toId]);
  return ids.length;
}

/** lib/helpdesk/retention anonymiseTicketTx: item titles may name the requester, so the checklists go. */
export async function anonymiseChecklistsTx(client: HdQueryable, ticketId: number): Promise<void> {
  await client.query("DELETE FROM hd_ticket_checklists WHERE ticket_id = $1", [ticketId]);
}

/** hd_read_ticket (agents): the checklists in short. */
export async function checklistsForMcp(ticketId: number) {
  const lists = await ticketChecklists(ticketId);
  return lists.map((c) => ({
    name: c.name,
    progress: `${c.done} of ${c.total} done`,
    required_open: c.required_open,
    items: c.items.map((i) => ({
      title: i.title,
      done: i.done,
      ...(i.required ? { required: true } : {}),
      ...(i.team_name ? { team: i.team_name } : {}),
      ...(i.due_date ? { due: i.due_date } : {}),
      ...(i.done ? { done_by: i.done_by_name, done_at: i.done_at } : {}),
    })),
  }));
}

/** The templates an agent may add by hand (the ticket's picker, the workflow builder). */
export async function templateOptions(): Promise<{ id: number; name: string; items: number; required: number }[]> {
  return (await listTemplates()).map((t) => ({ id: t.id, name: t.name, items: t.items.length, required: t.items.filter((i) => i.required).length }));
}

// --- The desk's view -----------------------------------------------------------------

/** May `user` change this ticket's checklists? Not on a merged or closed ticket. (The caller already checked canWorkTicket.) */
export function checklistsEditable(ticket: { status: HdStatus; merged_into?: number | null }): boolean {
  return !ticket.merged_into && ticket.status !== "closed";
}

/** The ticket's checklists for an agent who works it, what they may do, and the templates to add. */
export async function ticketChecklistView(
  user: { id: number; role: import("../types").Role },
  ticket: { id: number; team_id: number | null; status: HdStatus; merged_into?: number | null }
): Promise<import("./checklists-shared").HdTicketChecklists & { templates: Awaited<ReturnType<typeof templateOptions>>; solve_block: string | null }> {
  const { hdCan } = await import("./roles");
  const editable = checklistsEditable(ticket);
  const [checklists, templates, mayStatus] = await Promise.all([
    ticketChecklists(ticket.id),
    editable ? templateOptions() : Promise.resolve([]),
    editable ? hdCan(user, "tickets.change_status", { teamId: ticket.team_id }) : Promise.resolve(false),
  ]);
  // What a Solve would answer now (the desk asks before it stops a timer or posts anything).
  const solve_block = HD_OPEN_STATUSES.includes(ticket.status) ? (await checklistSolveRefusal(ticket.id))?.error ?? null : null;
  return { checklists, can_edit: editable, can_remove: editable && mayStatus, templates, solve_block };
}

// --- A workflow Finish held open by required items (engine evalFinish) ----------------

/** Who hears that a request's workflow finished but its checklist holds it open: the assignee, else the team's leads, else its members. */
export async function heldFinishRecipients(ticketId: number, client?: HdQueryable): Promise<number[]> {
  const t = await hqOne<{ assignee_id: number | null; team_id: number | null }>("SELECT assignee_id, team_id FROM hd_tickets WHERE id = $1", [ticketId], client);
  if (!t) return [];
  if (t.assignee_id) return [t.assignee_id];
  if (!t.team_id) return [];
  const members = await hq<{ user_id: number; role: string }>(
    "SELECT m.user_id, m.role FROM hd_team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active' WHERE m.team_id = $1",
    [t.team_id],
    client
  );
  const leads = members.filter((m) => m.role === "lead").map((m) => m.user_id);
  return leads.length ? leads : members.map((m) => m.user_id);
}

/**
 * lib/helpdesk/events afterTicketSolved: false when the request's workflow
 * ended at a Finish step with the survey turned off that its checklist held
 * open (engine evalFinish records it on the run), so the later solve keeps
 * the workflow's choice. Undefined otherwise.
 */
export async function heldFinishCsat(ticketId: number): Promise<false | undefined> {
  const r = await hqOne<{ csat: string | null }>(
    `SELECT current->'held_finish'->>'csat' AS csat FROM hd_workflow_runs
      WHERE ticket_id = $1 AND current ? 'held_finish' ORDER BY id DESC LIMIT 1`,
    [ticketId]
  );
  return r?.csat === "false" ? false : undefined;
}
