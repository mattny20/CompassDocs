// Helpdesk automations (1.19.0): "When <event> If <conditions> Then
// <actions>" rules an admin keeps in order under Desk → Settings →
// Automations.
//
//   events      ticket_created, ticket_updated, requester_message,
//               sla_nearing, sla_breached
//   conditions  every list given must match (any value within a list):
//               teams, categories, priorities, request types, sources, and
//               keywords (any word in the subject or the body; whole words,
//               any case). No conditions = every ticket.
//   actions     set team / assignee / priority / status / category, add
//               tags, add an internal note, send a macro's reply, notify
//               (the assignee, the team or one person)
//
// Rules run in position order and each sees what the earlier ones did.
// Loop protection, two layers: every write a rule makes carries
// `fromAutomation`, which lib/helpdesk/events honours by running no rules
// for it, so a rule's own change cannot retrigger anything; and a chain
// guard (AsyncLocalStorage) caps nesting at MAX_DEPTH and runs each rule at
// most once per chain, for any path that reaches runAutomations again
// without that flag. A rule whose actions would change nothing (the fields
// already hold its values, and it has no note, macro or notice) is skipped
// rather than counted as a run, so "ticket_updated" rules settle.
// Server-only.

import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { hq, hqOne } from "./db-core";
import { logEvent } from "../log";
import { cleanTags, validateMacroActions } from "./macros";
import { HD_PRIORITIES, HD_SOURCES, HD_STATUSES } from "./types";
import type {
  HdAutomation,
  HdAutomationActions,
  HdAutomationConditions,
  HdAutomationEvent,
  HdPriority,
  HdSource,
  HdStatus,
  HdTicketPatch,
  HdTicketRow,
} from "./types";

export const HD_AUTOMATION_EVENTS: readonly HdAutomationEvent[] = [
  "ticket_created",
  "ticket_updated",
  "requester_message",
  "sla_nearing",
  "sla_breached",
];

export const HD_AUTOMATION_EVENT_LABEL: Record<HdAutomationEvent, string> = {
  ticket_created: "A ticket is created",
  ticket_updated: "A ticket is updated",
  requester_message: "The requester sends a message",
  sla_nearing: "An SLA target is close",
  sla_breached: "An SLA target is missed",
};

export const AUTOMATION_LIMITS = { name: 120, rules: 200, list: 50, keyword: 60, note: 5000, category: 80 } as const;

/** Nested rule runs allowed in one chain. */
export const MAX_DEPTH = 3;

// --- Matching (pure) -------------------------------------------------------------

export interface MatchTarget {
  team_id: number | null;
  category: string;
  priority: HdPriority;
  request_type_id: number | null;
  source: HdSource;
  subject: string;
  /** The body the keywords are looked for in (the triggering message, or the opening one). */
  body: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive: "vpn" matches "VPN keeps dropping", not "vpnclient". */
export function keywordHit(keywords: string[], text: string): boolean {
  return keywords.some((k) => {
    const w = k.trim();
    if (!w) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, "iu").test(text);
  });
}

export function automationMatches(c: HdAutomationConditions, t: MatchTarget): boolean {
  const has = <T>(list: T[] | undefined): list is T[] => Array.isArray(list) && list.length > 0;
  if (has(c.team_ids) && (t.team_id === null || !c.team_ids.includes(t.team_id))) return false;
  if (has(c.categories) && !c.categories.some((x) => x.toLowerCase() === t.category.toLowerCase())) return false;
  if (has(c.priorities) && !c.priorities.includes(t.priority)) return false;
  if (has(c.request_type_ids) && (t.request_type_id === null || !c.request_type_ids.includes(t.request_type_id))) return false;
  if (has(c.sources) && !c.sources.includes(t.source)) return false;
  if (has(c.keywords) && !keywordHit(c.keywords, `${t.subject}\n${t.body}`)) return false;
  return true;
}

/** The field changes a rule would make to this ticket, without the ones it already has. */
export function effectivePatch(a: HdAutomationActions, t: Pick<HdTicketRow, "team_id" | "assignee_id" | "priority" | "status" | "category" | "tags">): HdTicketPatch {
  const p: HdTicketPatch = {};
  if (a.team_id !== undefined && a.team_id !== t.team_id) p.team_id = a.team_id;
  if (a.assignee_id !== undefined && a.assignee_id !== t.assignee_id) p.assignee_id = a.assignee_id;
  if (a.priority !== undefined && a.priority !== t.priority) p.priority = a.priority;
  if (a.status !== undefined && a.status !== t.status) p.status = a.status;
  if (a.category !== undefined && a.category !== t.category) p.category = a.category;
  if (a.tags_add?.length) {
    const next = [...t.tags];
    for (const tag of a.tags_add) if (!next.includes(tag)) next.push(tag);
    if (next.length !== t.tags.length) p.tags = next;
  }
  return p;
}

// --- Validation ------------------------------------------------------------------

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function idList(raw: unknown, what: string): Checked<number[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length > AUTOMATION_LIMITS.list) return { ok: false, error: `${what} must be a list.` };
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `${what} must be a list of ids.` };
    if (!out.includes(n)) out.push(n);
  }
  return { ok: true, value: out.length ? out : undefined };
}

function enumList<T extends string>(raw: unknown, allowed: readonly T[], what: string): Checked<T[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length > AUTOMATION_LIMITS.list) return { ok: false, error: `${what} must be a list.` };
  const out: T[] = [];
  for (const v of raw) {
    if (!allowed.includes(v as T)) return { ok: false, error: `Unknown ${what.toLowerCase()}: ${String(v).slice(0, 40)}.` };
    if (!out.includes(v as T)) out.push(v as T);
  }
  return { ok: true, value: out.length ? out : undefined };
}

function strList(raw: unknown, max: number, what: string): Checked<string[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length > AUTOMATION_LIMITS.list) return { ok: false, error: `${what} must be a list.` };
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return { ok: false, error: `${what} must be words.` };
    const s = v.trim();
    if (!s) continue;
    if (s.length > max) return { ok: false, error: `Keep each of ${what.toLowerCase()} under ${max} characters.` };
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return { ok: true, value: out.length ? out : undefined };
}

export function validateConditions(raw: unknown): Checked<HdAutomationConditions> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Conditions must be an object." };
  const c = raw as Record<string, unknown>;
  const known = ["team_ids", "categories", "priorities", "request_type_ids", "keywords", "sources"];
  for (const k of Object.keys(c)) if (!known.includes(k)) return { ok: false, error: `Unknown condition: ${k}.` };
  const out: HdAutomationConditions = {};
  const steps: [keyof HdAutomationConditions, Checked<unknown>][] = [
    ["team_ids", idList(c.team_ids, "Teams")],
    ["request_type_ids", idList(c.request_type_ids, "Request types")],
    ["priorities", enumList(c.priorities, HD_PRIORITIES, "Priorities")],
    ["sources", enumList(c.sources, HD_SOURCES, "Sources")],
    ["categories", strList(c.categories, AUTOMATION_LIMITS.category, "Categories")],
    ["keywords", strList(c.keywords, AUTOMATION_LIMITS.keyword, "Keywords")],
  ];
  for (const [k, r] of steps) {
    if (!r.ok) return r;
    if (r.value !== undefined) (out as Record<string, unknown>)[k] = r.value;
  }
  return { ok: true, value: out };
}

export function validateActions(raw: unknown): Checked<HdAutomationActions> {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Choose at least one action." };
  const a = raw as Record<string, unknown>;
  const known = ["team_id", "assignee_id", "priority", "status", "category", "tags_add", "internal_note", "macro_id", "notify"];
  for (const k of Object.keys(a)) if (!known.includes(k)) return { ok: false, error: `Unknown action: ${k}.` };
  const out: HdAutomationActions = {};
  const id = (v: unknown, what: string): Checked<number | undefined> => {
    if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? { ok: true, value: n } : { ok: false, error: `Unknown ${what}.` };
  };
  for (const [k, what] of [["team_id", "team"], ["assignee_id", "assignee"], ["macro_id", "macro"]] as const) {
    const r = id(a[k], what);
    if (!r.ok) return r;
    if (r.value !== undefined) out[k] = r.value;
  }
  if (a.priority !== undefined && a.priority !== null && a.priority !== "") {
    if (!(HD_PRIORITIES as readonly string[]).includes(String(a.priority))) return { ok: false, error: "Unknown priority." };
    out.priority = a.priority as HdPriority;
  }
  if (a.status !== undefined && a.status !== null && a.status !== "") {
    if (!(HD_STATUSES as readonly string[]).includes(String(a.status))) return { ok: false, error: "Unknown status." };
    out.status = a.status as HdStatus;
  }
  if (a.category !== undefined && a.category !== null) {
    if (typeof a.category !== "string" || a.category.trim().length > AUTOMATION_LIMITS.category) return { ok: false, error: "The category is too long." };
    out.category = a.category.trim();
  }
  if (a.tags_add !== undefined && a.tags_add !== null) {
    const tags = cleanTags(a.tags_add);
    if (!tags) return { ok: false, error: "Tags must be a list of short words." };
    if (tags.length) out.tags_add = tags;
  }
  if (a.internal_note !== undefined && a.internal_note !== null && a.internal_note !== "") {
    if (typeof a.internal_note !== "string" || a.internal_note.length > AUTOMATION_LIMITS.note) return { ok: false, error: "The note is too long." };
    if (a.internal_note.trim()) out.internal_note = a.internal_note.trim();
  }
  if (a.notify !== undefined && a.notify !== null && a.notify !== "") {
    if (a.notify === "assignee" || a.notify === "team") out.notify = a.notify;
    else if (typeof a.notify === "object" && a.notify && Number.isInteger(Number((a.notify as { user_id?: unknown }).user_id)) && Number((a.notify as { user_id?: unknown }).user_id) > 0) {
      out.notify = { user_id: Number((a.notify as { user_id: unknown }).user_id) };
    } else return { ok: false, error: "Notify the assignee, the team or one person." };
  }
  if (!Object.keys(out).length) return { ok: false, error: "Choose at least one action." };
  // The field-change part has the same rules as a macro's.
  const m = validateMacroActions({ status: out.status, priority: out.priority, team_id: out.team_id, tags_add: out.tags_add });
  if (!m.ok) return m;
  return { ok: true, value: out };
}

export interface AutomationInput {
  name: string;
  event: HdAutomationEvent;
  conditions: HdAutomationConditions;
  actions: HdAutomationActions;
  active: number;
  position?: number;
}

/** Validate a create (or, `partial`, an update) body, checking that named teams, people, macros and request types exist. */
export async function validateAutomationInput(raw: Record<string, unknown>, partial = false): Promise<Checked<Partial<AutomationInput>>> {
  const out: Partial<AutomationInput> = {};
  if (!partial || raw.name !== undefined) {
    if (typeof raw.name !== "string" || !raw.name.trim()) return { ok: false, error: "Give the automation a name." };
    if (raw.name.trim().length > AUTOMATION_LIMITS.name) return { ok: false, error: `Keep the name under ${AUTOMATION_LIMITS.name} characters.` };
    out.name = raw.name.trim();
  }
  if (!partial || raw.event !== undefined) {
    if (!HD_AUTOMATION_EVENTS.includes(raw.event as HdAutomationEvent)) return { ok: false, error: "Choose when the automation runs." };
    out.event = raw.event as HdAutomationEvent;
  }
  if (!partial || raw.conditions !== undefined) {
    const c = validateConditions(raw.conditions);
    if (!c.ok) return c;
    out.conditions = c.value;
  }
  if (!partial || raw.actions !== undefined) {
    const a = validateActions(raw.actions);
    if (!a.ok) return a;
    out.actions = a.value;
  }
  if (raw.active !== undefined) out.active = raw.active === true || raw.active === 1 ? 1 : 0;
  else if (!partial) out.active = 1;
  if (raw.position !== undefined) {
    const p = Number(raw.position);
    if (!Number.isInteger(p) || p < 0 || p > 10_000) return { ok: false, error: "Bad position." };
    out.position = p;
  }
  // References must exist.
  const teamIds = [...(out.conditions?.team_ids ?? []), ...(out.actions?.team_id ? [out.actions.team_id] : [])];
  if (teamIds.length) {
    const n = await hq("SELECT id FROM hd_teams WHERE id = ANY($1)", [teamIds]);
    if (n.length !== new Set(teamIds).size) return { ok: false, error: "Unknown team." };
  }
  if (out.conditions?.request_type_ids?.length) {
    const n = await hq("SELECT id FROM hd_request_types WHERE id = ANY($1)", [out.conditions.request_type_ids]);
    if (n.length !== out.conditions.request_type_ids.length) return { ok: false, error: "Unknown request type." };
  }
  if (out.actions?.macro_id) {
    // A rule sends shared macros only, never someone's personal one.
    const { ensureMacroSchema } = await import("./macros");
    await ensureMacroSchema();
    if (!(await hqOne("SELECT 1 FROM hd_macros WHERE id = $1 AND owner_id IS NULL", [out.actions.macro_id]))) return { ok: false, error: "Unknown macro." };
  }
  const people = [out.actions?.assignee_id, typeof out.actions?.notify === "object" ? out.actions.notify.user_id : undefined].filter((x): x is number => !!x);
  if (people.length) {
    const n = await hq("SELECT id FROM users WHERE id = ANY($1) AND status = 'active'", [people]);
    if (n.length !== new Set(people).size) return { ok: false, error: "Unknown person." };
  }
  return { ok: true, value: out };
}

// --- Storage ---------------------------------------------------------------------

const COLS = "id, name, event, conditions, actions, active, position, created_at, updated_at, last_run_at";

export async function listAutomations(): Promise<HdAutomation[]> {
  return hq<HdAutomation>(`SELECT ${COLS} FROM hd_automations ORDER BY position, id`);
}

export async function getAutomation(id: number): Promise<HdAutomation | undefined> {
  return hqOne<HdAutomation>(`SELECT ${COLS} FROM hd_automations WHERE id = $1`, [id]);
}

export class AutomationLimitError extends Error {}

export async function createAutomation(input: AutomationInput): Promise<HdAutomation> {
  const n = await hqOne<{ n: number; max: number | null }>("SELECT count(*)::int AS n, max(position) AS max FROM hd_automations");
  if ((n?.n ?? 0) >= AUTOMATION_LIMITS.rules) throw new AutomationLimitError(`A workspace can keep up to ${AUTOMATION_LIMITS.rules} automations.`);
  const position = input.position ?? (n?.max ?? -1) + 1;
  return (await hqOne<HdAutomation>(
    `INSERT INTO hd_automations (name, event, conditions, actions, active, position) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
    [input.name, input.event, JSON.stringify(input.conditions), JSON.stringify(input.actions), input.active, position]
  ))!;
}

export async function updateAutomation(id: number, patch: Partial<AutomationInput>): Promise<HdAutomation | undefined> {
  const cur = await getAutomation(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  return hqOne<HdAutomation>(
    `UPDATE hd_automations SET name = $2, event = $3, conditions = $4, actions = $5, active = $6, position = $7, updated_at = now()
      WHERE id = $1 RETURNING ${COLS}`,
    [id, next.name, next.event, JSON.stringify(next.conditions), JSON.stringify(next.actions), next.active, next.position]
  );
}

export async function deleteAutomation(id: number): Promise<HdAutomation | undefined> {
  return hqOne<HdAutomation>(`DELETE FROM hd_automations WHERE id = $1 RETURNING ${COLS}`, [id]);
}

// --- Running ---------------------------------------------------------------------

interface Chain {
  depth: number;
  fired: Set<string>;
}

const chainStore = new AsyncLocalStorage<Chain>();

export interface RunResult {
  /** The automations that acted, in order. */
  ran: number[];
  /** Why the run stopped early, when it did. */
  stopped?: "depth";
}

async function matchTarget(event: HdAutomationEvent, t: HdTicketRow): Promise<MatchTarget> {
  // The body: the requester's latest public message for requester_message,
  // otherwise the opening message.
  const msg =
    event === "requester_message"
      ? await hqOne<{ body: string }>(
          `SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'public'
              AND (author_id = $2 OR ($2::int IS NULL AND lower(author_email) = lower($3)))
            ORDER BY created_at DESC, id DESC LIMIT 1`,
          [t.id, t.requester_id, t.requester_email]
        )
      : await hqOne<{ body: string }>(
          "SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind <> 'system' ORDER BY created_at, id LIMIT 1",
          [t.id]
        );
  return {
    team_id: t.team_id,
    category: t.category,
    priority: t.priority,
    request_type_id: t.request_type_id,
    source: t.source,
    subject: t.subject,
    body: msg?.body ?? "",
  };
}

/**
 * Run the active rules of `event` on one ticket (after the write that
 * caused it committed). Never throws: a failing rule is logged and the next
 * one runs.
 */
export async function runAutomations(event: HdAutomationEvent, ticketId: number): Promise<RunResult> {
  const parent = chainStore.getStore();
  const chain: Chain = parent ? { depth: parent.depth + 1, fired: parent.fired } : { depth: 0, fired: new Set() };
  if (chain.depth >= MAX_DEPTH) {
    logEvent("warn", "helpdesk.automation_loop_stopped", { event, ticket_id: ticketId, depth: chain.depth });
    return { ran: [], stopped: "depth" };
  }
  return chainStore.run(chain, async () => {
    const result: RunResult = { ran: [] };
    let rules: HdAutomation[];
    try {
      rules = await hq<HdAutomation>(`SELECT ${COLS} FROM hd_automations WHERE event = $1 AND active = 1 ORDER BY position, id`, [event]);
    } catch (e) {
      logEvent("error", "helpdesk.automation_failed", { event, error: String(e) });
      return result;
    }
    for (const rule of rules) {
      const key = `${rule.id}:${ticketId}`;
      if (chain.fired.has(key)) continue;
      try {
        const t = await hqOne<HdTicketRow>("SELECT * FROM hd_tickets WHERE id = $1", [ticketId]);
        if (!t) break;
        if (!automationMatches(rule.conditions ?? {}, await matchTarget(event, t))) continue;
        const acted = await applyRule(rule, t);
        if (!acted) continue;
        chain.fired.add(key);
        result.ran.push(rule.id);
        await hq("UPDATE hd_automations SET last_run_at = now() WHERE id = $1", [rule.id]);
      } catch (e) {
        logEvent("error", "helpdesk.automation_failed", { automation: rule.id, ticket_id: ticketId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return result;
  });
}

/** Apply one rule's actions. Answers whether it did anything. Exported for tests (1.19.2, W3). */
export async function applyRule(rule: HdAutomation, t: HdTicketRow): Promise<boolean> {
  const a = rule.actions ?? {};
  const patch = effectivePatch(a, t);
  const actor = { id: null, name: `Automation: ${rule.name}` };
  const ctx = { fromAutomation: true, actorName: actor.name };
  let acted = false;
  if (Object.keys(patch).length) {
    const { updateTicket } = await import("./tickets");
    // Refusals peel off only what was refused, then the rest applies: a blocked
    // solve (1.19.2, required checklist items, agent W3) drops the status alone;
    // an assignee who is not on the team, or a team that was deleted, drops the
    // assignee and team. At most three tries (each drops something).
    let left: typeof patch = { ...patch };
    for (let attempt = 0; attempt < 3 && Object.keys(left).length; attempt++) {
      try {
        await updateTicket(t.id, left, actor, ctx);
        acted = true;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logEvent("warn", "helpdesk.automation_patch_refused", { automation: rule.id, error: msg });
        const next = { ...left };
        // 1.20.5: a "Before you solve" requirement set refuses the solve the same way (lib/helpdesk/solve-requirements).
        if ((await import("./checklists-shared")).isChecklistBlock(msg) || (await import("./solve-requirements-shared")).isSolveRequirementBlock(msg)) delete next.status;
        else {
          delete next.assignee_id;
          delete next.team_id;
        }
        if (Object.keys(next).length === Object.keys(left).length) throw e;
        left = next;
      }
    }
  }
  if (a.internal_note) {
    const { addMessage } = await import("./messages");
    await addMessage(
      t.id,
      { kind: "internal", body: a.internal_note, author: { id: null, name: actor.name, email: "" }, via: "system", asRequester: false },
      ctx
    );
    acted = true;
  }
  if (a.macro_id) {
    const { applyMacroToTicket } = await import("./macros");
    const r = await applyMacroToTicket(t.id, a.macro_id, { id: null, name: actor.name, email: "" }, { fromAutomation: true });
    if (r.ok) acted = true;
  }
  if (a.notify) {
    const { notifyFromAutomation } = await import("./notify");
    await notifyFromAutomation(t.id, a.notify, rule.name);
    acted = true;
  }
  return acted;
}

/** For tests: whether a run is inside a rule chain right now. */
export function currentChainDepth(): number | null {
  return chainStore.getStore()?.depth ?? null;
}
