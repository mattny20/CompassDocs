// Helpdesk 1.20.5: "Before you solve" requirements, the shapes and checks the
// server and the desk share. Pure: safe in client components.
//
// A requirement set (Desk settings → Before you solve) names what a ticket
// needs before it can be solved: ticket fields that must be set (an owner, a
// team, a category, a tag, a linked asset, time logged, a reply sent) and
// closing fields the agent fills in, built with the request form's field
// types (lib/helpdesk/request-types HdFormField). A set applies to every
// ticket, or to chosen teams and request types; every switched-on set that
// matches a ticket applies. A ticket with something missing is refused on
// every solve path with one sentence (SOLVE_BLOCK_PREFIX starts it, so the
// desk can tell it from a checklist's or a task hand-off's 409).

import type { HdFormAnswers, HdFormField } from "./types";
import type { HdSolveCustomField } from "./custom-fields-shared";

export const SOLVE_REQ_LIMITS = {
  name: 80,
  /** Requirement sets. */
  sets: 50,
  /** Teams, and request types, one set may name. */
  scope: 50,
  /** Closing fields in one set (a dialog, not a form page). */
  fields: 20,
} as const;

/** What a ticket already carries that a set may require. Kept in the order the dialog lists them. */
// 1.20.6: "subcategory", next to the category (lib/helpdesk/categories).
export const SOLVE_TICKET_FIELDS = ["assignee", "team", "category", "subcategory", "tag", "asset", "time", "reply"] as const;
export type HdSolveTicketField = (typeof SOLVE_TICKET_FIELDS)[number];

/** As the settings page names each one (a noun phrase the refusal sentence can list). */
export const SOLVE_TICKET_FIELD_LABEL: Record<HdSolveTicketField, string> = {
  assignee: "An owner",
  team: "A team",
  category: "A category",
  subcategory: "A sub-category",
  tag: "At least one tag",
  asset: "A linked asset",
  time: "Time logged",
  reply: "A reply sent to the requester",
};

export const SOLVE_TICKET_FIELD_HELP: Record<HdSolveTicketField, string> = {
  assignee: "Someone owns the ticket.",
  team: "The ticket belongs to a team.",
  category: "The ticket has a category.",
  subcategory: "The ticket has a sub-category. A ticket whose category has no sub-categories passes.",
  tag: "The ticket has one tag or more.",
  asset: "A device or other asset is linked to the ticket.",
  time: "Someone has logged time on the ticket.",
  reply: "An agent has replied to the requester. A reply waiting for review doesn't count until it's approved.",
};

export function isSolveTicketField(v: unknown): v is HdSolveTicketField {
  return typeof v === "string" && (SOLVE_TICKET_FIELDS as readonly string[]).includes(v);
}

export interface HdSolveRequirementSet {
  id: number;
  name: string;
  enabled: boolean;
  /** Empty: every team (and tickets with no team). */
  team_ids: number[];
  /** Empty: every request type (and tickets with none). */
  request_type_ids: number[];
  ticket_fields: HdSolveTicketField[];
  /** 1.20.6: custom fields (lib/helpdesk/custom-fields) that must be filled in, by id. One that isn't assigned to the ticket's team is not asked for. */
  custom_field_ids: number[];
  /** The closing fields, each required or optional. */
  fields: HdFormField[];
  created_at: string;
  updated_at: string;
}

export interface HdSolveRequirementSetInput {
  name: string;
  enabled: boolean;
  team_ids: number[];
  request_type_ids: number[];
  ticket_fields: HdSolveTicketField[];
  custom_field_ids: number[];
  fields: HdFormField[];
}

/** One answer kept on a ticket, with the words it was asked in (a later edit of the set never rewrites it). */
export interface HdSolveDetail {
  set_id: number;
  set_name: string;
  key: string;
  label: string;
  type: HdFormField["type"];
  value: HdFormAnswers[string];
  /** The answer as a person reads it (an option's label, a person's name, Yes). */
  text: string;
  answered_by_name: string;
  answered_at: string;
}

export type HdSolveMissing =
  | { kind: "ticket_field"; field: HdSolveTicketField; label: string }
  /** 1.20.6: a custom field of the ticket's team with no value. */
  | { kind: "custom_field"; field_id: number; key: string; label: string }
  | { kind: "closing_field"; set_id: number; set_name: string; key: string; label: string }
  // 1.20.6 (lib/helpdesk/desk-calendar): the ticket carries an event whose setup is not marked complete. Asked of every
  // event ticket, with or without a requirement set. `key` names what to send: event.setup_complete (the API, the connector).
  | { kind: "event_setup"; key: "setup_complete"; label: string };

/** What a solve of this ticket needs now: GET /api/helpdesk/tickets/[number]/solve-requirements. */
export interface HdSolveCheck {
  /** Some switched-on set matches the ticket. */
  applies: boolean;
  sets: {
    id: number;
    name: string;
    ticket_fields: { field: HdSolveTicketField; label: string; met: boolean }[];
    /** 1.20.6: the custom fields the set requires that apply to this ticket, each filled in or not. */
    custom_fields: HdSolveCustomField[];
    fields: HdFormField[];
  }[];
  /** What a solve would be refused for, in order. Empty: it would go through. */
  missing: HdSolveMissing[];
  /** The refusal sentence, or null. */
  error: string | null;
  /** Optional closing fields with no answer yet: the desk offers them once more, the server never refuses for them. */
  optional_open: number;
  /** The answers kept so far, keyed "<set id>:<field key>". */
  answers: HdFormAnswers;
  /** user-type answers' names, keyed like `answers`. */
  answer_names: Record<string, string>;
  /** The ticket as it stands, for the dialog's quick setters. */
  ticket: { team_id: number | null; team_name: string | null; assignee_id: number | null; category: string; subcategory?: string; tags: string[] };
  /** 1.20.6: the ticket's event while its setup is not marked complete (the dialog's "Setup complete" tick box names it); else absent. */
  event_setup?: import("./desk-calendar-shared").HdTicketEvent | null;
}

/** How a qualified answer key is spelt: "<set id>:<field key>". A bare field key answers every matching set that has it. */
export const solveAnswerKey = (setId: number, key: string) => `${setId}:${key}`;

/** The start of every refusal to solve because of a requirement set. */
export const SOLVE_BLOCK_PREFIX = "Before you solve, this ticket needs";
/** The `code` on the 409 body. */
export const SOLVE_BLOCK_CODE = "solve_requirements";

const lowerFirst = (s: string) => (/^[A-Z][a-z ]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** "an owner, a linked asset, Resolution code and Root cause" (closing fields keep their capitals). */
function listMissing(missing: HdSolveMissing[]): string {
  const names: string[] = [];
  for (const m of missing) {
    const n = m.kind === "closing_field" ? m.label : lowerFirst(m.label);
    if (!names.includes(n)) names.push(n);
  }
  const shown = names.slice(0, 4);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** The refusal sentence, naming up to four things. */
export function solveBlockMessage(missing: HdSolveMissing[]): string {
  return `${SOLVE_BLOCK_PREFIX}: ${listMissing(missing)}.`;
}

/** Is this error message a "Before you solve" refusal? */
export function isSolveRequirementBlock(message: string | null | undefined): boolean {
  return typeof message === "string" && message.startsWith(SOLVE_BLOCK_PREFIX);
}

/**
 * Does moving `from` → `to` count as solving? Only leaving the open statuses
 * for solved or closed, as lib/helpdesk/tickets updateTicket checks it
 * (solved → closed never asks). The same test as checklists'.
 */
export function solvesForRequirements(from: string, to: string | null | undefined): boolean {
  return (to === "solved" || to === "closed") && ["new", "open", "pending", "on_hold"].includes(from);
}

/**
 * Does the set apply to a ticket of this team and request type? No teams
 * and no request types chosen: every ticket. Both chosen: the ticket must
 * match both.
 */
export function solveSetMatches(
  set: Pick<HdSolveRequirementSet, "team_ids" | "request_type_ids">,
  ticket: { team_id: number | null; request_type_id: number | null }
): boolean {
  if (set.team_ids.length && (ticket.team_id === null || !set.team_ids.includes(ticket.team_id))) return false;
  if (set.request_type_ids.length && (ticket.request_type_id === null || !set.request_type_ids.includes(ticket.request_type_id))) return false;
  return true;
}

/** "All tickets" / "IT · Laptop request, VPN access" for the settings list. */
export function solveScopeLabel(
  set: Pick<HdSolveRequirementSet, "team_ids" | "request_type_ids">,
  teams: { id: number; name: string }[],
  types: { id: number; title: string }[]
): string {
  const t = set.team_ids.map((id) => teams.find((x) => x.id === id)?.name).filter((x): x is string => !!x);
  const r = set.request_type_ids.map((id) => types.find((x) => x.id === id)?.title).filter((x): x is string => !!x);
  if (!set.team_ids.length && !set.request_type_ids.length) return "All tickets";
  const short = (xs: string[]) => (xs.length > 3 ? `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more` : xs.join(", "));
  return [t.length ? short(t) : "", r.length ? short(r) : ""].filter(Boolean).join(" · ") || "Nothing it names still exists";
}

// --- Checks -----------------------------------------------------------------------

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function idList(raw: unknown, what: string): Checked<number[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: `${what} are a list of ids.` };
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return { ok: false, error: `${what} are a list of ids.` };
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > SOLVE_REQ_LIMITS.scope) return { ok: false, error: `Up to ${SOLVE_REQ_LIMITS.scope} ${what.toLowerCase()}.` };
  return { ok: true, value: out };
}

/**
 * Check a set's body, apart from its closing fields (the server checks
 * those with lib/helpdesk/request-types validateFormFields, so there is one
 * form definition check).
 */
export function checkSolveSetInput(raw: unknown): Checked<Omit<HdSolveRequirementSetInput, "fields" | "custom_field_ids">> {
  if (!isObj(raw)) return { ok: false, error: "Send the requirement set as { name, enabled, team_ids, request_type_ids, ticket_fields, fields }." };
  const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: "Give the requirement set a name." };
  if (name.length > SOLVE_REQ_LIMITS.name) return { ok: false, error: `Keep the name under ${SOLVE_REQ_LIMITS.name} characters.` };
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return { ok: false, error: "On is true or false." };
  const teams = idList(raw.team_ids, "Teams");
  if (!teams.ok) return teams;
  const types = idList(raw.request_type_ids, "Request types");
  if (!types.ok) return types;
  const fields: HdSolveTicketField[] = [];
  if (raw.ticket_fields !== undefined && raw.ticket_fields !== null) {
    if (!Array.isArray(raw.ticket_fields)) return { ok: false, error: "Ticket fields are a list." };
    for (const v of raw.ticket_fields) {
      if (!isSolveTicketField(v)) return { ok: false, error: `Ticket fields are any of: ${SOLVE_TICKET_FIELDS.join(", ")}.` };
      if (!fields.includes(v)) fields.push(v);
    }
  }
  // Kept in the listed order, whatever order they were sent in.
  fields.sort((a, b) => SOLVE_TICKET_FIELDS.indexOf(a) - SOLVE_TICKET_FIELDS.indexOf(b));
  return { ok: true, value: { name, enabled: raw.enabled === true, team_ids: teams.value, request_type_ids: types.value, ticket_fields: fields } };
}

/** 1.20.6: the custom fields a set requires (`custom_field_ids`), checked apart so the check above answers what it always has. */
export function checkSolveCustomFieldIds(raw: unknown): Checked<number[]> {
  return idList(isObj(raw) ? raw.custom_field_ids : undefined, "Custom fields");
}
