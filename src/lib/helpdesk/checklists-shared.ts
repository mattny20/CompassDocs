// Helpdesk 1.19.2: checklists (agent W3), the shapes and checks the server
// and the desk share. Pure: safe in client components.
//
// A template is a reusable list (Desk settings → Checklists): items with a
// title, an optional Required flag, an optional owner team and an optional
// due offset in business days. A ticket gets a copy when a checklist is
// added by hand, by its request type, or by a workflow task step. Required
// items that are not ticked block solving (CHECKLIST_BLOCK_PREFIX starts the
// refusal on every solve path, so the desk can tell it from other 409s).

export const CHECKLIST_LIMITS = {
  name: 120,
  itemTitle: 300,
  items: 50,
  /** Business days a due offset may count (0 = the day it's added). */
  dueDays: 60,
  /** Checklists one ticket may hold. */
  perTicket: 10,
  /** Templates in the library. */
  templates: 200,
  /** Request types one template may name. */
  requestTypes: 50,
  /** Templates one workflow task may add. */
  perTask: 5,
} as const;

export type HdChecklistSource = "manual" | "request_type" | "workflow";

export interface HdChecklistTemplateItem {
  /** Stable within the template (the editor's list key). */
  key: string;
  title: string;
  required?: boolean;
  /** The team that owns the item (shown on the ticket). */
  team_id?: number | null;
  /** Due this many business days after the checklist is added, in the owner team's calendar (else the ticket's). */
  due_days?: number | null;
}

export interface HdChecklistTemplate {
  id: number;
  name: string;
  items: HdChecklistTemplateItem[];
  request_type_ids: number[];
  created_at: string;
  updated_at: string;
}

/** A row of the settings list: what adds it automatically, and how often it was added. */
export interface HdChecklistTemplateRow extends HdChecklistTemplate {
  used: number;
  /** "Request type Move desks", "New starter workflow · task Laptop and accounts". */
  added_to: string[];
}

export interface HdChecklistTemplateInput {
  name: string;
  items: HdChecklistTemplateItem[];
  request_type_ids: number[];
}

export interface HdTicketChecklistItem {
  id: number;
  title: string;
  required: boolean;
  team_id: number | null;
  team_name: string | null;
  /** YYYY-MM-DD in the counting calendar's zone. */
  due_date: string | null;
  due_at: string | null;
  done: boolean;
  done_at: string | null;
  done_by_name: string;
}

export interface HdTicketChecklist {
  id: number;
  name: string;
  template_id: number | null;
  source: HdChecklistSource;
  added_by_name: string;
  created_at: string;
  items: HdTicketChecklistItem[];
  done: number;
  total: number;
  required_open: number;
}

export interface HdTicketChecklists {
  checklists: HdTicketChecklist[];
  /** The caller may tick, add items and add checklists (works the ticket, not merged). */
  can_edit: boolean;
  /** The caller may remove a checklist (also changes status: removing one could skip the solve check). */
  can_remove: boolean;
}

/** The start of every refusal to solve because of required items. */
export const CHECKLIST_BLOCK_PREFIX = "Finish the required checklist items first";

/** The refusal sentence, naming up to three open items. */
export function checklistBlockMessage(open: { title: string }[]): string {
  const names = open.slice(0, 3).map((o) => `"${o.title}"`);
  const more = open.length > 3 ? ` and ${open.length - 3} more` : "";
  return `${CHECKLIST_BLOCK_PREFIX}: ${names.join(", ")}${more}.`;
}

/**
 * Does moving `from` → `to` count as solving for the checklist check? Only
 * leaving the open statuses for solved or closed, as lib/helpdesk/tickets
 * updateTicket checks it (solved → closed never asks).
 */
export function solvesForChecklists(from: string, to: string | null | undefined): boolean {
  return (to === "solved" || to === "closed") && ["new", "open", "pending", "on_hold"].includes(from);
}

/** Is this error message a checklist refusal? */
export function isChecklistBlock(message: string | null | undefined): boolean {
  return typeof message === "string" && message.startsWith(CHECKLIST_BLOCK_PREFIX);
}

export const CHECKLIST_SOURCE_LABEL: Record<HdChecklistSource, string> = {
  manual: "Added by hand",
  request_type: "Added by the request type",
  workflow: "Added by the workflow",
};

/** "Due in 2 business days" for the editor. */
export function dueDaysLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return "No due date";
  if (days === 0) return "Due the day it's added";
  return `Due in ${days} business ${days === 1 ? "day" : "days"}`;
}

export const DUE_DAY_CHOICES = [0, 1, 2, 3, 5, 10, 15, 20] as const;

// --- Checks -----------------------------------------------------------------------

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A new item key not in `taken`. */
export function newItemKey(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 1; ; i++) {
    const k = `i${i}`;
    if (!used.has(k)) return k;
  }
}

/** Check a template body (create, or an update merged over the stored one). */
export function checkTemplateInput(raw: unknown): Checked<HdChecklistTemplateInput> {
  if (!isObj(raw)) return { ok: false, error: "Send the checklist as { name, items, request_type_ids }." };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { ok: false, error: "Give the checklist a name." };
  if (name.length > CHECKLIST_LIMITS.name) return { ok: false, error: `Keep the name under ${CHECKLIST_LIMITS.name} characters.` };
  if (!Array.isArray(raw.items)) return { ok: false, error: "Add at least one item." };
  if (raw.items.length === 0) return { ok: false, error: "Add at least one item." };
  if (raw.items.length > CHECKLIST_LIMITS.items) return { ok: false, error: `A checklist holds up to ${CHECKLIST_LIMITS.items} items.` };
  const items: HdChecklistTemplateItem[] = [];
  const keys = new Set<string>();
  for (const [i, r] of raw.items.entries()) {
    const where = `Item ${i + 1}`;
    if (!isObj(r)) return { ok: false, error: `${where} must be an object.` };
    const title = typeof r.title === "string" ? r.title.trim().replace(/\s+/g, " ") : "";
    if (!title) return { ok: false, error: `${where} needs a title.` };
    if (title.length > CHECKLIST_LIMITS.itemTitle) return { ok: false, error: `${where} is longer than ${CHECKLIST_LIMITS.itemTitle} characters.` };
    let key = typeof r.key === "string" && KEY_RE.test(r.key) ? r.key : "";
    if (!key || keys.has(key)) key = newItemKey([...keys, ...raw.items.map((x) => (isObj(x) && typeof x.key === "string" ? x.key : ""))]);
    keys.add(key);
    const item: HdChecklistTemplateItem = { key, title };
    if (r.required === true) item.required = true;
    else if (r.required !== undefined && r.required !== false && r.required !== null) return { ok: false, error: `${where}: Required is yes or no.` };
    if (r.team_id !== undefined && r.team_id !== null && r.team_id !== 0) {
      const t = posInt(r.team_id);
      if (!t) return { ok: false, error: `${where}: pick the team that owns it.` };
      item.team_id = t;
    }
    if (r.due_days !== undefined && r.due_days !== null && r.due_days !== "") {
      const d = r.due_days;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > CHECKLIST_LIMITS.dueDays) {
        return { ok: false, error: `${where}: the due date is 0 to ${CHECKLIST_LIMITS.dueDays} business days after it's added.` };
      }
      item.due_days = d;
    }
    items.push(item);
  }
  const rts: number[] = [];
  if (raw.request_type_ids !== undefined && raw.request_type_ids !== null) {
    if (!Array.isArray(raw.request_type_ids)) return { ok: false, error: "Request types are a list of ids." };
    for (const v of raw.request_type_ids) {
      const id = posInt(v);
      if (!id) return { ok: false, error: "Request types are a list of ids." };
      if (!rts.includes(id)) rts.push(id);
    }
    if (rts.length > CHECKLIST_LIMITS.requestTypes) return { ok: false, error: `Up to ${CHECKLIST_LIMITS.requestTypes} request types.` };
  }
  return { ok: true, value: { name, items, request_type_ids: rts } };
}

/** A workflow task's `checklist_ids` (shape only; lib/helpdesk/checklists checks they exist). Undefined when none. */
export function checkTaskChecklistIds(raw: unknown, where: string): Checked<number[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: `${where}: the checklists are a list of ids.` };
  const ids: number[] = [];
  for (const v of raw) {
    const id = posInt(v);
    if (!id) return { ok: false, error: `${where}: the checklists are a list of ids.` };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > CHECKLIST_LIMITS.perTask) return { ok: false, error: `${where}: a task adds up to ${CHECKLIST_LIMITS.perTask} checklists.` };
  return { ok: true, value: ids.length ? ids : undefined };
}
