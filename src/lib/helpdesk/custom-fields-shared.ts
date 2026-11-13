// Helpdesk 1.20.6: custom fields, the shapes and checks the server and the
// desk share. Pure: safe in client components.
//
// A desk admin defines fields (Desk settings → Custom fields): a label, a
// stable key, a kind (the request form's field types, lib/helpdesk/types
// HdFormFieldType, so there is one set of kinds), a help line, options for a
// choice, the teams it is assigned to (one or more, or every team) and who
// sees it: agents only, or agents and requesters ("Public"). A ticket shows
// the fields of its team; a ticket with no team shows the "All teams" fields
// only. Values stay with the ticket when it moves team: a field that is not
// assigned to the current team is simply not shown.

import type { HdFormAnswers, HdFormField, HdFormFieldType, HdFormOption } from "./types";

export const CUSTOM_FIELD_LIMITS = {
  /** Fields in a workspace, archived ones included. */
  fields: 100,
  label: 80,
  key: 40,
  help: 500,
  /** Options of one choice field (the request form's limit). */
  options: 50,
  /** Teams one field may name; past that, choose All teams. */
  teams: 100,
} as const;

export const CUSTOM_FIELD_VISIBILITIES = ["agent", "public"] as const;
export type HdCustomFieldVisibility = (typeof CUSTOM_FIELD_VISIBILITIES)[number];

export const CUSTOM_FIELD_VISIBILITY_LABEL: Record<HdCustomFieldVisibility, string> = {
  agent: "Agent only",
  public: "Public",
};

export const CUSTOM_FIELD_VISIBILITY_HELP: Record<HdCustomFieldVisibility, string> = {
  agent: "Only agents see it. It never reaches the requester.",
  public: "Agents and requesters see it. The requester sees it on their request once it has a value. Only agents fill it in.",
};

/**
 * The kinds the settings page offers, in its order. "choice" (the request
 * form's radio cards) is the same thing on a ticket as "select", so the page
 * offers one "Pick one"; the API takes either.
 */
export const CUSTOM_FIELD_KINDS: readonly HdFormFieldType[] = ["text", "textarea", "select", "checkbox", "date", "datetime", "number", "user"];

export const CUSTOM_FIELD_KIND_LABEL: Record<HdFormFieldType, string> = {
  text: "Short text",
  textarea: "Long text",
  select: "Pick one",
  choice: "Pick one",
  checkbox: "Yes / no",
  date: "Date",
  // 1.20.6: the kind the event calendar added to the forms (a wall-clock "2026-11-20T14:00").
  datetime: "Date and time",
  number: "Number",
  user: "A person",
};

export const isChoiceKind = (t: HdFormFieldType) => t === "choice" || t === "select";

/** Kinds whose stored values read the same, so a field may switch between them while tickets hold values. */
export function sameValueShape(a: HdFormFieldType, b: HdFormFieldType): boolean {
  if (a === b) return true;
  if (isChoiceKind(a) && isChoiceKind(b)) return true;
  return (a === "text" || a === "textarea") && (b === "text" || b === "textarea");
}

export type HdCustomValue = HdFormAnswers[string];

export interface HdCustomField {
  id: number;
  /** Stable: made from the first label, unique, never changed. The API, webhooks and the Claude connector use it. */
  key: string;
  label: string;
  type: HdFormFieldType;
  help: string;
  /** For a choice; [] otherwise. */
  options: HdFormOption[];
  /** Every team, and tickets with no team. */
  all_teams: boolean;
  /** The teams it is assigned to when not all_teams. */
  team_ids: number[];
  visibility: HdCustomFieldVisibility;
  position: number;
  /** Archived: its values are kept, it is no longer shown or edited. */
  archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A field on a ticket with its value: the side panel's block, hd_read_ticket. */
export interface HdTicketCustomField {
  id: number;
  key: string;
  label: string;
  type: HdFormFieldType;
  help: string;
  options: HdFormOption[];
  visibility: HdCustomFieldVisibility;
  /** null: not filled in. */
  value: HdCustomValue;
  /** The value as a person reads it (an option's label, a person's name, Yes); "" when not filled in. */
  text: string;
}

/** A Public field's value as a requester reads it (Get help, the customer portal). */
export interface HdPublicDetail {
  key: string;
  label: string;
  type: HdFormFieldType;
  /** As read: an option's label, a person's name, Yes or No, a date as YYYY-MM-DD. */
  value: string;
}

/** A custom field a "Before you solve" requirement set asks for (lib/helpdesk/solve-requirements), as its dialog draws it. */
export interface HdSolveCustomField {
  id: number;
  key: string;
  label: string;
  type: HdFormFieldType;
  help: string;
  options: HdFormOption[];
  /** It has a value (one sent with the solve counts). */
  met: boolean;
}

/** Is the field shown on a ticket of this team? Archived: never. No team: the "All teams" fields only. */
export function customFieldApplies(f: Pick<HdCustomField, "all_teams" | "team_ids" | "archived">, teamId: number | null): boolean {
  if (f.archived) return false;
  if (f.all_teams) return true;
  return teamId !== null && f.team_ids.includes(teamId);
}

/** The field as the request form's field shape, for its validators and its control. */
export function customFieldAsFormField(f: Pick<HdCustomField, "key" | "label" | "type" | "help" | "options">, required = false): HdFormField {
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    ...(required ? { required: true } : {}),
    ...(isChoiceKind(f.type) ? { options: f.options } : {}),
    ...(f.help ? { help: f.help } : {}),
  };
}

/** A key from a label: lower-case letters, digits and underscores, starting with a letter, unique among `taken`. */
export function customFieldKeyFrom(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = label
    // Accents fold to their letter ("é" → "e") before anything that isn't a letter or a digit becomes "_".
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, CUSTOM_FIELD_LIMITS.key - 6)
    .replace(/_+$/, "");
  if (!/^[a-z]/.test(base)) base = base ? `f_${base}` : "field";
  let k = base;
  let n = 2;
  while (used.has(k)) k = `${base}_${n++}`;
  return k;
}

/** "All teams" / "IT Support, Facilities" / "IT Support, Facilities and 2 more" for the settings list. */
export function customFieldTeamsLabel(f: Pick<HdCustomField, "all_teams" | "team_ids">, teams: { id: number; name: string }[]): string {
  if (f.all_teams) return "All teams";
  const names = f.team_ids.map((id) => teams.find((t) => t.id === id)?.name).filter((x): x is string => !!x);
  if (!names.length) return "No team";
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
}

/** A value as a person reads it. `names`: people's names for "A person" values; `kept`: the words stored when it was set. */
export function customValueText(
  f: Pick<HdCustomField, "type" | "options">,
  value: HdCustomValue | undefined,
  opts: { names?: Map<number, string>; kept?: string } = {}
): string {
  if (value === undefined || value === null || value === "") return "";
  if (f.type === "checkbox") return value === true ? "Yes" : "No";
  if (isChoiceKind(f.type)) return f.options.find((o) => o.value === String(value))?.label ?? (opts.kept || String(value));
  if (f.type === "user") return opts.names?.get(Number(value)) ?? (opts.kept || `Person #${value}`);
  if (f.type === "datetime") return String(value).replace("T", " "); // as request-types answerText reads it
  return String(value);
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Check who sees a field and which teams it is assigned to (the rest of the body is the request form's field check). */
export function checkCustomFieldScope(raw: unknown): Checked<{ visibility: HdCustomFieldVisibility; all_teams: boolean; team_ids: number[] }> {
  if (!isObj(raw)) return { ok: false, error: "Send the field as { label, type, options, help, visibility, all_teams, team_ids }." };
  const visibility = raw.visibility === undefined || raw.visibility === null ? "agent" : raw.visibility;
  if (visibility !== "agent" && visibility !== "public") return { ok: false, error: 'Visibility is "agent" (agents only) or "public" (agents and requesters).' };
  if (raw.all_teams !== undefined && typeof raw.all_teams !== "boolean") return { ok: false, error: "all_teams is true or false." };
  const ids: number[] = [];
  if (raw.team_ids !== undefined && raw.team_ids !== null) {
    if (!Array.isArray(raw.team_ids)) return { ok: false, error: "Teams are a list of ids." };
    for (const v of raw.team_ids) {
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return { ok: false, error: "Teams are a list of ids." };
      if (!ids.includes(v)) ids.push(v);
    }
  }
  if (ids.length > CUSTOM_FIELD_LIMITS.teams) return { ok: false, error: `Up to ${CUSTOM_FIELD_LIMITS.teams} teams. Choose All teams instead.` };
  // Left out: every team, unless teams are named.
  const all = raw.all_teams === undefined ? ids.length === 0 : raw.all_teams;
  if (!all && !ids.length) return { ok: false, error: "Pick at least one team, or choose All teams." };
  return { ok: true, value: { visibility, all_teams: all, team_ids: all ? [] : ids } };
}
