// Policy sets (D3, 1.14.0): the limits, the request parsing, the 400
// sentences and the copy the three routes and the wave-2 page share.
//
// A set is a named, ordered bundle of policies assigned to people, groups or
// everyone as one unit, and to every new account on day one when it
// auto-assigns. The word is "set" in every label and sentence; "pack" only
// ever appears inside an example name an admin types. Pure: no database and
// no server-only import, so the page takes the copy and the limits from
// here and the test pins every sentence the routes answer with.

import { policyNoun } from "./audience";
import type { PolicySetInput, PolicySetPatch, PolicySetProgress, PolicySetTarget } from "./types";

/** policy_sets.name: 1..120 characters after trimming, unique (case-insensitively) among active sets. */
export const SET_NAME_MAX = 120;
/** policy_sets.description, trimmed. */
export const SET_DESCRIPTION_MAX = 1000;
/** A set holds 1..100 policies (more is a programme, not a set). */
export const SET_DOCS_MAX = 100;
/** An assignment names at most this many people and this many groups (the roster's cap). */
export const SET_TARGET_IDS_MAX = 200;

// The 409 / 404 / 400 sentences the routes answer with (the data layer throws them as PolicySetError).
export const SET_NAME_TAKEN = "A set with that name exists.";
export const SET_NOT_FOUND = "Not found.";
export const SET_DEACTIVATED = "This set is deactivated. Reactivate it to assign it.";
export const SET_DOCS_INVALID = "Every policy in a set must be a published document that is not retired.";
export const SET_TARGET_EMPTY = "Name at least one person or group, or assign to everyone.";
export const SET_NOTHING_TO_CHANGE = "Nothing to change.";
export const SET_NAME_REQUIRED = `Enter a set name of up to ${SET_NAME_MAX} characters.`;
export const SET_DESCRIPTION_TOO_LONG = `Keep the description under ${SET_DESCRIPTION_MAX} characters.`;
export const SET_DOCS_RANGE = `Send doc_ids: 1 to ${SET_DOCS_MAX} document ids.`;
export const SET_DOCS_INTEGERS = "doc_ids must be positive integers.";
export const SET_TARGET_RANGE = `Send up to ${SET_TARGET_IDS_MAX} user_ids and ${SET_TARGET_IDS_MAX} group_ids.`;
export const SET_TARGET_INTEGERS = "user_ids and group_ids must be positive integers.";

// --- The page's copy (wave 2 renders it; the spec's words) -----------------------

export const SET_PAGE_INTRO =
  "Group policies into a set, assigned to every new joiner automatically or to people and groups as one unit.";
/** An example only: the Field carries the label "Set name" (STYLEGUIDE §Forms: a placeholder never repeats the label). */
export const SET_NAME_PLACEHOLDER = "New starter onboarding";
export const SET_PICKER_PLACEHOLDER = "Add policies in order…";
export const SET_AUTO_ASSIGN_LABEL = "Auto-assign to new joiners";
export const SET_ASSIGN_PEOPLE_PLACEHOLDER = "Add people…";
export const SET_ASSIGN_GROUPS_PLACEHOLDER = "Add groups…";
export const SET_ASSIGN_PRIMARY = "Assign set";
export const SET_ASSIGN_EVERYONE = "Assign to everyone";
export const SET_DELETE_BODY = "Policies and confirmations stay; only the set is removed. This cannot be undone.";
export const SET_DEACTIVATED_TOAST = "Set deactivated · Undo";

/** The confirmDialog before "Assign to everyone": 'Assign "New starter onboarding" (8 policies) to every active member?' */
export function assignEveryoneConfirm(name: string, policies: number): string {
  return `Assign "${name}" (${policies} ${policyNoun(policies)}) to every active member?`;
}

/** The assign dialog's line for members not yet requiring confirmation: 'These 2 documents will start requiring confirmation'. */
export function switchedOnLine(n: number): string {
  return n === 1 ? "This document will start requiring confirmation" : `These ${n} documents will start requiring confirmation`;
}

/** The warning when the set is assigned narrower than members already asking everyone who can see their space. */
export function notNarrowedLine(n: number): string {
  return n === 1
    ? "This policy currently applies to everyone who can see its space; assigning the set will not narrow it"
    : `These ${n} policies currently apply to everyone who can see their space; assigning the set will not narrow them`;
}

/** The set row's progress text: "87% · 6 overdue" ("Nobody asked yet" when no member asks anyone). */
export function progressText(p: PolicySetProgress): string {
  if (p.required === 0) return "Nobody asked yet";
  return p.overdue > 0 ? `${p.pct}% · ${p.overdue} overdue` : `${p.pct}%`;
}

/** The My policies group label (wave 2): "New starter onboarding · 3 of 8 done". */
export function setGroupLabel(name: string, done: number, total: number): string {
  return `${name} · ${done} of ${total} done`;
}

// --- The CSV column the matrix and roster exports carry ---------------------------

/** The header cell: the attention agent appends it after its own columns in both CSVs. */
export const POLICY_SET_CSV_COLUMN = "set";

/** The cell: the policy's active sets by name, "; " between them, '' when none. */
export function policySetCsvCell(names: string[] | undefined | null): string {
  return (names ?? []).join("; ");
}

// --- Request parsing ---------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Positive safe integers, deduped in order; null when any entry is not one. */
function idList(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** The set name as stored: trimmed, inner whitespace collapsed; '' when unusable. */
export function normaliseSetName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

/** POST /api/admin/compliance/sets: { name, description?, doc_ids, assign_new_members? }. */
export function parseSetInput(body: unknown): Parsed<PolicySetInput> {
  const b = asObject(body);
  if (!b) return { ok: false, error: "Send a JSON object." };
  const name = normaliseSetName(b.name);
  if (!name || name.length > SET_NAME_MAX) return { ok: false, error: SET_NAME_REQUIRED };
  const description = typeof b.description === "string" ? b.description.trim() : "";
  if (description.length > SET_DESCRIPTION_MAX) return { ok: false, error: SET_DESCRIPTION_TOO_LONG };
  if (!Array.isArray(b.doc_ids)) return { ok: false, error: SET_DOCS_RANGE };
  const doc_ids = idList(b.doc_ids);
  if (!doc_ids) return { ok: false, error: SET_DOCS_INTEGERS };
  if (doc_ids.length < 1 || doc_ids.length > SET_DOCS_MAX) return { ok: false, error: SET_DOCS_RANGE };
  if (b.assign_new_members !== undefined && typeof b.assign_new_members !== "boolean") {
    return { ok: false, error: "'assign_new_members' must be true or false." };
  }
  return { ok: true, value: { name, description, doc_ids, assign_new_members: b.assign_new_members !== false } };
}

/** PATCH /api/admin/compliance/sets/[id]: any subset of { name, description, doc_ids, assign_new_members, active }; at least one. */
export function parseSetPatch(body: unknown): Parsed<PolicySetPatch> {
  const b = asObject(body);
  if (!b) return { ok: false, error: "Send a JSON object." };
  const patch: PolicySetPatch = {};
  if (b.name !== undefined) {
    const name = normaliseSetName(b.name);
    if (!name || name.length > SET_NAME_MAX) return { ok: false, error: SET_NAME_REQUIRED };
    patch.name = name;
  }
  if (b.description !== undefined) {
    const description = typeof b.description === "string" ? b.description.trim() : "";
    if (description.length > SET_DESCRIPTION_MAX) return { ok: false, error: SET_DESCRIPTION_TOO_LONG };
    patch.description = description;
  }
  if (b.doc_ids !== undefined) {
    if (!Array.isArray(b.doc_ids)) return { ok: false, error: SET_DOCS_RANGE };
    const doc_ids = idList(b.doc_ids);
    if (!doc_ids) return { ok: false, error: SET_DOCS_INTEGERS };
    if (doc_ids.length < 1 || doc_ids.length > SET_DOCS_MAX) return { ok: false, error: SET_DOCS_RANGE };
    patch.doc_ids = doc_ids;
  }
  for (const key of ["assign_new_members", "active"] as const) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== "boolean") return { ok: false, error: `'${key}' must be true or false.` };
    patch[key] = b[key] as boolean;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: SET_NOTHING_TO_CHANGE };
  return { ok: true, value: patch };
}

/** POST /api/admin/compliance/sets/[id]: { user_ids?, group_ids?, everyone? }; `everyone: true` makes the lists moot. */
export function parseSetTarget(body: unknown): Parsed<PolicySetTarget> {
  const b = asObject(body);
  if (!b) return { ok: false, error: "Send a JSON object." };
  if (b.everyone !== undefined && typeof b.everyone !== "boolean") return { ok: false, error: "'everyone' must be true or false." };
  const everyone = b.everyone === true;
  const lists: number[][] = [];
  for (const key of ["user_ids", "group_ids"] as const) {
    if (b[key] === undefined || b[key] === null) {
      lists.push([]);
      continue;
    }
    if (!Array.isArray(b[key])) return { ok: false, error: SET_TARGET_RANGE };
    const ids = idList(b[key]);
    if (!ids) return { ok: false, error: SET_TARGET_INTEGERS };
    if (ids.length > SET_TARGET_IDS_MAX) return { ok: false, error: SET_TARGET_RANGE };
    lists.push(ids);
  }
  const [user_ids, group_ids] = lists;
  if (!everyone && user_ids.length === 0 && group_ids.length === 0) return { ok: false, error: SET_TARGET_EMPTY };
  return { ok: true, value: everyone ? { user_ids: [], group_ids: [], everyone: true } : { user_ids, group_ids, everyone: false } };
}
