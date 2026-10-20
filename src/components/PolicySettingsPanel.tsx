"use client";

// The Settings tab of a policy's Read confirmation page (C2, 1.12.0): the
// per-policy settings as stacked cards with one Save row, the page's only
// primary action. Every card is its own component taking the shared form
// model { s, set, errors }: Confirmation statement (C2: the sentence on
// the card at the end of the document, and the typed-signature switch),
// Who must confirm (D1, 1.13.0: everyone who can see the space, or the
// groups, people and roles named, minus exclusions; the two switches; the
// live "Applies to 412 people" line), Deadline (E1: inherit, days after
// assignment or a fixed date, with "Also move existing deadlines"),
// Reminders (E2: the cadence and the policy owner), Re-confirmation (G1:
// how often everyone is asked again, the next date and the effective date)
// and Lifecycle (G3: the policy that replaces this one, Retire policy… and
// Un-retire).
//
// The save PATCHes /api/documents/[id]/ack-settings with the fields that
// changed since the last clean state (so a stored next date that has
// already passed is never re-judged by a save that did not touch it); the
// route answers what the document now holds, which becomes the clean state
// (STYLEGUIDE §Forms: markClean before applying the response). Retire and
// Un-retire are not form fields: they POST at once, ask first (formDialog /
// confirmDialog, awaited before any busy state) and refresh the route, and
// the card follows the server's answer. "Also move existing deadlines" is
// not a form field either: it PATCHes the rule as the card holds it with
// move_existing and tells with Undo (the inverse move: the previous rule
// re-applied the same way), never asks.

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Archive, ArchiveRestore, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { confirmDialog, formDialog } from "@/components/Dialog";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";
import { Field, Select, Textarea, TextInput, Toggle, rangeError } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import { Tooltip } from "@/components/Tooltip";
import { RECONFIRM_LABEL, RECONFIRM_REASON_TOO_SHORT, askReconfirm } from "@/components/ReconfirmButton";
import { RECERT_OPTIONS, addMonths, nextRecertDate, recertOptionLabel } from "@/lib/ack-recert";
import { AUDIENCE_ROLES, audienceSavedToast } from "@/lib/audience";
import { DUE_FIELDS, DUE_RANGES, audienceDueHelper, inheritLabel } from "@/lib/ack-due";
import type { DefaultsOrigin, DueRule, PolicyDefaults, PolicyDefaultsKey } from "@/lib/ack-due";
import type { AudienceMode, AudienceRule } from "@/lib/types";
import { useAction } from "@/lib/use-action";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";

/** The server enforces the same limit (the ack-settings route). */
export const STATEMENT_MAX = 500;

/** The Lifecycle card's two actions (STYLEGUIDE §Vocabulary: the same words on the portal row). */
export const RETIRE_LABEL = "Retire policy…";
export const UNRETIRE_LABEL = "Un-retire";
/** The inline validation line of the next-date field; the route answers the same rule with 400. */
export const NEXT_DATE_PAST = "The next re-confirmation date cannot be in the past.";
/** A targeted audience with nobody named; the route refuses the same way. */
export const AUDIENCE_EMPTY = "Name at least one group, person or role.";
/** An edited fixed deadline before today; the route refuses the same way. */
export const DUE_DATE_PAST = "The deadline cannot be in the past.";
/** The Deadline card's secondary action. */
export const MOVE_EXISTING_LABEL = "Also move existing deadlines";
/** The rule line under the People picker (D1), word for word. */
export const PEOPLE_ACCESS_RULE =
  'People must be able to see this document\'s space. Someone who cannot is shown as "No access" in the preview and is not required until access is granted in Space settings.';

/** The audience as the route answers it (D1). */
export interface PolicyAudienceInitial {
  audience_mode: AudienceMode;
  rules: AudienceRule[];
  exclude_stewards: boolean;
  assign_new_members: boolean;
}

/** One resolution of the defaults cascade: the numbers and where each came from. */
export interface ResolvedForCard {
  values: PolicyDefaults;
  origin: Record<PolicyDefaultsKey, DefaultsOrigin>;
}

/** The four reminder numbers the Reminders card edits (policy_settings' columns). */
export type ReminderKey = "remind_before_days" | "remind_every_days" | "escalate_after_days" | "nudge_every_days";
/** The spec's labels, the unit in brackets (TextInput has no suffix). */
export const REMINDER_FIELDS: readonly { key: ReminderKey; label: string }[] = [
  { key: "remind_before_days", label: "Remind before due (days)" },
  { key: "remind_every_days", label: "Remind every (days while overdue)" },
  { key: "escalate_after_days", label: "Escalate after (days overdue)" },
  { key: "nudge_every_days", label: "Nudge without a deadline every (days, 0 = never)" },
];
const REMINDER_KEYS: readonly ReminderKey[] = REMINDER_FIELDS.map((f) => f.key);

/** What the page hands the panel: the document's own values and what the cards need to show them. */
export interface PolicySettingsInitial {
  /** The policy's own statement; null = the workspace default. */
  statement: string | null;
  /** The workspace default (Program settings), shown as the placeholder. */
  statement_default: string;
  signature: boolean;
  /** Re-confirmation (G1): the interval in months (null = never), the stored next date (ISO) and the effective date ('YYYY-MM-DD'). */
  recert_months: number | null;
  next_recert_at: string | null;
  effective_at: string | null;
  /** The marker (ack_revision_at): the first cycle is dated from it, and the warn line compares it with the interval. */
  marker: string;
  /** The workspace's interval (Program settings): its option is suffixed "(workspace default)". */
  recert_default: number | null;
  /** Lifecycle (G3): the replacement, with its title for the chip (null once it is in the Trash), and the picker's options. */
  superseded_by: number | null;
  superseded_by_title: string | null;
  replacements: PickerOption[];
  /** documents.ack_required: only a policy that asks for confirmation can be retired. */
  required: boolean;
  /** The retirement, when the policy is retired. */
  retired: { at: string; by: string; reason: string } | null;
  /** The standing for the Retire question: "42 of 50 people have confirmed version 12". */
  summary: { current: number; eligible: number; rev: number | null };
  /** The signed-in person, named on the card right after they retire the policy. */
  viewerName: string;
  /** Who must confirm (D1). */
  audience: PolicyAudienceInitial;
  /** The Groups picker's options (sublabel Entra / Google / Manual) and the People picker's (sublabel the username). */
  groups: PickerOption[];
  people: PickerOption[];
  /** The policy's own deadline rule (E1): both null = inherit. */
  rule: DueRule;
  /** The cascade with the policy's layer (the effective numbers) and the space for the inherit label. */
  defaults: ResolvedForCard & { space: { id: number; name: string } | null };
  /** The cascade without the policy's layer: what a blank field inherits. */
  inherited: ResolvedForCard;
  /** The policy's own reminder numbers (E2): null = inherit. */
  reminders: Record<ReminderKey, number | null>;
  /** The policy owner (E2): null = whoever switched the requirement on, else the space's approvers. */
  owner_user_id: number | null;
  owner_name: string | null;
  /** Whoever switched the requirement on: the owner picker's placeholder. */
  requested_by: { id: number; name: string } | null;
}

/** The Deadline card's radio. */
export type DueMode = "inherit" | "days" | "fixed";

/** The form as edited; '' for the statement means "use the default", '' for a date or a number means none / inherit. */
export interface PolicySettingsForm {
  statement: string;
  signature: boolean;
  recert_months: number | null;
  /** 'YYYY-MM-DD' (the UTC day of the stored instant), or ''. */
  next_recert_at: string;
  /** 'YYYY-MM-DD', or ''. */
  effective_at: string;
  superseded_by: number | null;
  audience_mode: AudienceMode;
  /** The include rules as the pickers hold them: group ids, user ids, role names. */
  groups: number[];
  people: number[];
  roles: string[];
  /** The Exclude picker lists groups and people in one box: a group keeps its id, a person travels as -id (see excludeId). */
  excludes: number[];
  /** Rules the card cannot show (an exclude of a role, set through the API): carried unchanged so a save never drops them. */
  other_rules: AudienceRule[];
  exclude_stewards: boolean;
  assign_new_members: boolean;
  due_mode: DueMode;
  /** Digits, or '' (judged only in 'days' mode). */
  due_days: string;
  /** 'YYYY-MM-DD', or '' (judged only in 'fixed' mode). */
  due_at: string;
  remind_before_days: string;
  remind_every_days: string;
  escalate_after_days: string;
  nudge_every_days: string;
  owner_user_id: number | null;
}

/** The model every card takes: the values, one setter, the field errors. */
export interface PolicySettingsModel {
  s: PolicySettingsForm;
  set: <K extends keyof PolicySettingsForm>(key: K, value: PolicySettingsForm[K]) => void;
  errors: Partial<Record<keyof PolicySettingsForm | "audience", string | undefined>>;
}

/** What GET and PATCH /ack-settings answer (the parts the form reads back). */
interface SettingsAnswer {
  statement: string | null;
  signature: boolean;
  recert_months: number | null;
  next_recert_at: string | null;
  effective_at: string | null;
  marker: string | null;
  recert_default: number | null;
  superseded_by: number | null;
  superseded_by_title: string | null;
  audience_mode: AudienceMode;
  rules: AudienceRule[];
  exclude_stewards: boolean;
  assign_new_members: boolean;
  due_days: number | null;
  due_at: string | null;
  remind_before_days: number | null;
  remind_every_days: number | null;
  escalate_after_days: number | null;
  nudge_every_days: number | null;
  owner_user_id: number | null;
  owner_name: string | null;
  requested_by: { id: number; name: string } | null;
  defaults: ResolvedForCard & { space: { id: number; name: string } | null };
  inherited: ResolvedForCard;
  /** PATCH only: the deadlines this call moved, and the audience's counts when it was saved. */
  moved?: number;
  added?: number;
  closed?: number;
  reopened?: number;
}

/** 'YYYY-MM-DD' of an instant, in UTC: what a date-only input holds and what the route reads it as. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole calendar months from one moment to another, at least one ("People last re-confirmed 18 months ago"). */
function monthsBetween(from: Date, to: Date): number {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(1, months);
}

/** The Exclude picker's one id space: a group as its id, a person as the negative of theirs. */
function excludeId(rule: AudienceRule): number | null {
  const n = Number(rule.ref);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (rule.kind === "group") return n;
  if (rule.kind === "user") return -n;
  return null;
}

/** The saved rules as the pickers hold them, and the rest carried as they are. */
function splitRules(rules: AudienceRule[]) {
  const out = { groups: [] as number[], people: [] as number[], roles: [] as string[], excludes: [] as number[], other: [] as AudienceRule[] };
  for (const r of rules) {
    const n = Number(r.ref);
    if (r.effect === "include" && r.kind === "group" && Number.isInteger(n) && n > 0) out.groups.push(n);
    else if (r.effect === "include" && r.kind === "user" && Number.isInteger(n) && n > 0) out.people.push(n);
    else if (r.effect === "include" && r.kind === "role" && (AUDIENCE_ROLES as readonly string[]).includes(r.ref)) out.roles.push(r.ref);
    else {
      const id = r.effect === "exclude" ? excludeId(r) : null;
      if (id !== null) out.excludes.push(id);
      else out.other.push(r);
    }
  }
  // The roles in their fixed order, so the rules' JSON is stable.
  out.roles = AUDIENCE_ROLES.filter((role) => out.roles.includes(role));
  return out;
}

/** The rules a save sends: the pickers' choices in a fixed order, then what the card could not show. */
export function rulesFromForm(s: PolicySettingsForm): AudienceRule[] {
  const rules: AudienceRule[] = [];
  for (const id of s.groups) rules.push({ kind: "group", ref: String(id), effect: "include" });
  for (const id of s.people) rules.push({ kind: "user", ref: String(id), effect: "include" });
  for (const role of AUDIENCE_ROLES) if (s.roles.includes(role)) rules.push({ kind: "role", ref: role, effect: "include" });
  for (const id of s.excludes) {
    rules.push(id > 0 ? { kind: "group", ref: String(id), effect: "exclude" } : { kind: "user", ref: String(-id), effect: "exclude" });
  }
  return rules.concat(s.other_rules);
}

/** The deadline rule a save sends. */
export function ruleFromForm(s: PolicySettingsForm): DueRule {
  if (s.due_mode === "days") return { due_days: Number(s.due_days), due_at: null };
  if (s.due_mode === "fixed") return { due_days: null, due_at: s.due_at || null };
  return { due_days: null, due_at: null };
}

/** The Deadline card's fields for a stored rule. */
function dueFormFrom(rule: DueRule): Pick<PolicySettingsForm, "due_mode" | "due_days" | "due_at"> {
  return {
    due_mode: rule.due_at ? "fixed" : rule.due_days !== null ? "days" : "inherit",
    due_days: rule.due_days !== null ? String(rule.due_days) : "",
    due_at: rule.due_at ?? "",
  };
}

function fromInitial(i: PolicySettingsInitial): PolicySettingsForm {
  const split = splitRules(i.audience.rules);
  return {
    statement: i.statement ?? "",
    signature: i.signature,
    recert_months: i.recert_months,
    next_recert_at: i.next_recert_at ? ymd(new Date(i.next_recert_at)) : "",
    effective_at: i.effective_at ?? "",
    superseded_by: i.superseded_by,
    audience_mode: i.audience.audience_mode,
    groups: split.groups,
    people: split.people,
    roles: split.roles,
    excludes: split.excludes,
    other_rules: split.other,
    exclude_stewards: i.audience.exclude_stewards,
    assign_new_members: i.audience.assign_new_members,
    ...dueFormFrom(i.rule),
    remind_before_days: i.reminders.remind_before_days === null ? "" : String(i.reminders.remind_before_days),
    remind_every_days: i.reminders.remind_every_days === null ? "" : String(i.reminders.remind_every_days),
    escalate_after_days: i.reminders.escalate_after_days === null ? "" : String(i.reminders.escalate_after_days),
    nudge_every_days: i.reminders.nudge_every_days === null ? "" : String(i.reminders.nudge_every_days),
    owner_user_id: i.owner_user_id,
  };
}

function statementError(text: string): string | undefined {
  return text.trim().length > STATEMENT_MAX ? `Keep the statement under ${STATEMENT_MAX} characters.` : undefined;
}

/**
 * The same rule validateRecertPatch applies: today counts, yesterday does
 * not. Only an edited value is judged: a stored date that has passed (a
 * retired or paused policy's, which the sweep never moves) is never sent by
 * a save that did not touch it, so it is a hint on the card, not an error
 * that locks the statement, the signature and the replacement.
 */
function nextDateError(s: PolicySettingsForm, saved: PolicySettingsForm): string | undefined {
  if (s.recert_months === null || !s.next_recert_at) return undefined;
  if (s.next_recert_at === saved.next_recert_at) return undefined;
  return s.next_recert_at < ymd(new Date()) ? NEXT_DATE_PAST : undefined;
}

/** The fixed deadline: a date, and (when edited) not before today, the route's rule. */
function dueDateError(s: PolicySettingsForm, saved: PolicySettingsForm): string | undefined {
  if (s.due_mode !== "fixed") return undefined;
  if (!s.due_at) return "Enter a date.";
  if (s.due_at === saved.due_at) return undefined;
  return s.due_at < ymd(new Date()) ? DUE_DATE_PAST : undefined;
}

/** A blank reminder field inherits; anything typed must be a whole number in the key's range. */
function reminderError(key: ReminderKey, value: string): string | undefined {
  return value === "" ? undefined : rangeError(value, DUE_RANGES[key].min, DUE_RANGES[key].max);
}

/** The plain hint under a stored next date that has already passed. */
export const NEXT_DATE_PASSED_HINT = "This date has passed; the next cycle fires when the policy is live again.";
/** The plain hint under a stored fixed deadline that has already passed: a new row falls back to the inherited days (lib/ack-due dueAtSql), and a move recomputes from that rule. */
export const DUE_DATE_PASSED_HINT = "This date has passed; new assignments use the inherited days until you set another date.";

/** "Moved 412 deadlines" (the spec's toast), or the no-op sentence. */
export function movedToast(n: number): string {
  if (n === 0) return "No deadlines to move.";
  return `Moved ${n} ${n === 1 ? "deadline" : "deadlines"}`;
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** The server's answer folded into what the panel holds (every key the answer carries wins). */
function applyAnswer(server: PolicySettingsInitial, data: Partial<SettingsAnswer>): PolicySettingsInitial {
  return {
    ...server,
    statement: data.statement ?? null,
    signature: data.signature ?? server.signature,
    recert_months: data.recert_months ?? null,
    next_recert_at: data.next_recert_at ?? null,
    effective_at: data.effective_at ?? null,
    marker: data.marker ?? server.marker,
    recert_default: data.recert_default === undefined ? server.recert_default : data.recert_default,
    superseded_by: data.superseded_by ?? null,
    superseded_by_title: data.superseded_by_title ?? null,
    audience: {
      audience_mode: data.audience_mode ?? server.audience.audience_mode,
      rules: data.rules ?? server.audience.rules,
      exclude_stewards: data.exclude_stewards ?? server.audience.exclude_stewards,
      assign_new_members: data.assign_new_members ?? server.audience.assign_new_members,
    },
    rule: {
      due_days: data.due_days === undefined ? server.rule.due_days : data.due_days,
      due_at: data.due_at === undefined ? server.rule.due_at : data.due_at,
    },
    defaults: data.defaults ?? server.defaults,
    inherited: data.inherited ?? server.inherited,
    reminders: Object.fromEntries(
      REMINDER_KEYS.map((k) => [k, data[k] === undefined ? server.reminders[k] : data[k]])
    ) as Record<ReminderKey, number | null>,
    owner_user_id: data.owner_user_id === undefined ? server.owner_user_id : data.owner_user_id,
    owner_name: data.owner_name === undefined ? server.owner_name : data.owner_name,
    requested_by: data.requested_by === undefined ? server.requested_by : data.requested_by,
  };
}

export function PolicySettingsPanel({
  doc,
  initial,
}: {
  doc: { id: number; title: string };
  initial: PolicySettingsInitial;
}) {
  const [s, setS] = useState<PolicySettingsForm>(() => fromInitial(initial));
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState(false);
  // What the server holds: the clean form is derived from it, the marker
  // and the workspace default come from it, and the Lifecycle card reads
  // the retirement from it. A refresh (after Retire or Un-retire) hands the
  // panel a new `initial`, and the server's values win; the person's
  // unsaved edits are kept.
  const [server, setServer] = useState(initial);
  const [seen, setSeen] = useState(initial);

  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(s));
  useLeaveGuard(dirty, hasUnsavedChanges);

  if (initial !== seen) {
    setSeen(initial);
    setServer(initial);
    if (!dirty) setS(fromInitial(initial));
  }

  /** User edits only (STYLEGUIDE §Forms: never from a mount effect). */
  function set<K extends keyof PolicySettingsForm>(key: K, value: PolicySettingsForm[K]) {
    markDirty();
    setS((prev) => ({ ...prev, [key]: value }));
  }

  // The clean form, derived from what the server holds: the save sends
  // what differs from it, and the date rules judge only an edit.
  const saved = fromInitial(server);
  const errors: PolicySettingsModel["errors"] = {
    statement: statementError(s.statement),
    next_recert_at: nextDateError(s, saved),
    audience:
      s.audience_mode === "targeted" && !rulesFromForm(s).some((r) => r.effect === "include") ? AUDIENCE_EMPTY : undefined,
    due_days: s.due_mode === "days" ? rangeError(s.due_days, DUE_RANGES.due_days.min, DUE_RANGES.due_days.max) : undefined,
    due_at: dueDateError(s, saved),
    remind_before_days: reminderError("remind_before_days", s.remind_before_days),
    remind_every_days: reminderError("remind_every_days", s.remind_every_days),
    escalate_after_days: reminderError("escalate_after_days", s.escalate_after_days),
    nudge_every_days: reminderError("nudge_every_days", s.nudge_every_days),
  };
  const invalid = Object.values(errors).some(Boolean);
  const model: PolicySettingsModel = { s, set, errors };

  /** One PATCH; the server's error or the fallback is toasted; the answer comes back on success. */
  async function patch(body: Record<string, unknown>, fallback: string): Promise<Partial<SettingsAnswer> | null> {
    const res = await fetch(`/api/documents/${doc.id}/ack-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<SettingsAnswer> & { error?: string };
    if (!res.ok) {
      toast("error", data?.error || fallback);
      return null;
    }
    return data;
  }

  /**
   * The inverse of a move (E1): the previous rule re-applied with
   * move_existing, so the rows go back to the dates that rule gives and the
   * rule itself is restored. The card follows the answer.
   */
  async function undoMove(from: DueRule) {
    const data = await patch({ due_days: from.due_days, due_at: from.due_at, move_existing: true }, "Couldn't move the deadlines back.");
    if (!data) return;
    const next = applyAnswer(server, data);
    setServer(next);
    setS((prev) => ({ ...prev, ...dueFormFrom(next.rule) }));
    toast("ok", `${movedToast(data.moved ?? 0)} back`);
  }

  async function save() {
    if (invalid) {
      toast("error", "Fix the highlighted fields first.");
      return;
    }
    // Only what moved since the last clean state goes to the server.
    const body: Record<string, unknown> = {};
    if (s.statement.trim() !== saved.statement) body.statement = s.statement.trim();
    if (s.signature !== saved.signature) body.signature = s.signature;
    if (s.recert_months !== saved.recert_months) body.recert_months = s.recert_months;
    // The next date rides along only with an interval: the server clears it
    // on Never, and a date on a policy with no interval is not stored.
    if (s.recert_months !== null && s.next_recert_at !== saved.next_recert_at) body.next_recert_at = s.next_recert_at || null;
    if (s.effective_at !== saved.effective_at) body.effective_at = s.effective_at || null;
    if (s.superseded_by !== saved.superseded_by) body.superseded_by = s.superseded_by;
    // The audience: the rules travel whole whenever any of them moved.
    const rulesNow = rulesFromForm(s);
    if (s.audience_mode !== saved.audience_mode) body.audience_mode = s.audience_mode;
    if (JSON.stringify(rulesNow) !== JSON.stringify(rulesFromForm(saved))) body.rules = rulesNow;
    if (s.exclude_stewards !== saved.exclude_stewards) body.exclude_stewards = s.exclude_stewards;
    if (s.assign_new_members !== saved.assign_new_members) body.assign_new_members = s.assign_new_members;
    // The deadline rule: each half that changed (a fixed date moves every
    // open deadline on the server; the days apply to future assignments).
    const ruleNow = ruleFromForm(s);
    const ruleSaved = ruleFromForm(saved);
    if (ruleNow.due_days !== ruleSaved.due_days) body.due_days = ruleNow.due_days;
    if (ruleNow.due_at !== ruleSaved.due_at) body.due_at = ruleNow.due_at;
    for (const k of REMINDER_KEYS) if (s[k] !== saved[k]) body[k] = s[k] === "" ? null : Number(s[k]);
    if (s.owner_user_id !== saved.owner_user_id) body.owner_user_id = s.owner_user_id;
    if (Object.keys(body).length === 0) {
      markClean();
      setS(saved);
      toast("ok", "Settings saved.");
      return;
    }
    setSaving(true);
    const data = await patch(body, "Could not save the settings.");
    setSaving(false);
    if (!data) return;
    markClean();
    const next = applyAnswer(server, data);
    setServer(next);
    setS(fromInitial(next));
    // The audience's own sentence when it was saved (the counts are what
    // the save did), else the plain one; a fixed date that moved the open
    // deadlines says so, with Undo through the inverse move.
    toast(
      "ok",
      typeof data.added === "number"
        ? audienceSavedToast({ added: data.added, closed: data.closed ?? 0, reopened: data.reopened ?? 0 })
        : "Settings saved."
    );
    if ((data.moved ?? 0) > 0) {
      toast("ok", movedToast(data.moved ?? 0), { action: { label: "Undo", onClick: () => void undoMove(ruleSaved) } });
    }
  }

  /**
   * "Also move existing deadlines" (E1): the rule as the card holds it,
   * saved and applied to every open row (the fixed date while ahead, else
   * the later of each person's cycle start and assignment plus the days).
   * Tells, never asks: Undo is the inverse move when the rule changed; a
   * move under an unchanged rule has no inverse (the rows' old dates are
   * only in due_history), so it offers none. The stored fixed date is left
   * out while the card still holds it: a date that has passed is refused
   * when sent again ("The deadline cannot be in the past."), and the server
   * moves from the rule it already applies.
   */
  async function moveExisting() {
    if (errors.due_days || errors.due_at) {
      toast("error", "Fix the highlighted fields first.");
      return;
    }
    const rule = ruleFromForm(s);
    const from = ruleFromForm(saved);
    const changed = rule.due_days !== from.due_days || rule.due_at !== from.due_at;
    const body: Record<string, unknown> = { due_days: rule.due_days, move_existing: true };
    if (rule.due_at !== from.due_at) body.due_at = rule.due_at;
    setMoving(true);
    const data = await patch(body, "Couldn't move the deadlines.");
    setMoving(false);
    if (!data) return;
    const next = applyAnswer(server, data);
    setServer(next);
    // The rule is now the stored one; when nothing else is unsaved the row goes clean.
    if (JSON.stringify(s) === JSON.stringify(fromInitial(next))) markClean();
    toast(
      "ok",
      movedToast(data.moved ?? 0),
      changed && (data.moved ?? 0) > 0 ? { action: { label: "Undo", onClick: () => void undoMove(from) } } : {}
    );
  }

  return (
    <div className="space-y-6">
      <StatementCard model={model} statementDefault={server.statement_default} />
      <AudienceCard model={model} docId={doc.id} groups={server.groups} people={server.people} newJoinerDays={server.defaults.values.new_joiner_days} />
      <DeadlineCard
        model={model}
        server={server}
        busy={saving || moving}
        moving={moving}
        onMoveExisting={() => void moveExisting()}
      />
      <RemindersCard model={model} server={server} />
      <ReconfirmationCard
        model={model}
        marker={server.marker}
        workspaceDefault={server.recert_default}
        stored={{ recert_months: server.recert_months, next_recert_at: saved.next_recert_at }}
      />
      <LifecycleCard
        model={model}
        doc={doc}
        server={server}
        onRetired={(retired) => setServer((prev) => ({ ...prev, retired }))}
        onResumed={(standing) => {
          // Un-retire clears the replacement on the server (a policy that is
          // live again is not replaced by anything): the form follows.
          // Un-retire switches the requirement back on in the same UPDATE,
          // so Retire is offered again before the route refresh lands.
          setServer((prev) => ({
            ...prev,
            retired: null,
            required: true,
            superseded_by: null,
            superseded_by_title: null,
            summary: { ...prev.summary, ...standing },
          }));
          setS((prev) => ({ ...prev, superseded_by: null }));
        }}
      />
      <SaveRow dirty={dirty} busy={saving} onSave={save} label="Save settings" disabled={invalid} />
    </div>
  );
}

/**
 * The confirmation statement and the typed signature. The statement is
 * rendered on the card through MarkdownView, so a clause may carry
 * emphasis or a link; blank means the workspace default, which the
 * placeholder shows.
 */
export function StatementCard({ model, statementDefault }: { model: PolicySettingsModel; statementDefault: string }) {
  const { s, set, errors } = model;
  return (
    <Card
      title="Confirmation statement"
      description="What a reader agrees to on the card at the end of this document, and how they confirm it. Leave the statement blank to use the workspace default from Program settings."
    >
      <Field
        label="Confirmation statement"
        help='Shown above the confirm button and stored with every confirmation. Legal teams may add a clause such as "and that I will comply with it".'
        error={errors.statement}
      >
        <Textarea
          rows={3}
          maxLength={STATEMENT_MAX}
          placeholder={statementDefault}
          value={s.statement}
          onChange={(e) => set("statement", e.target.value)}
          spellCheck
        />
      </Field>
      <Toggle
        className="mt-4"
        label="Require typed signature"
        help="The reader types their full name; local accounts also re-enter their password. SSO accounts are identified by their sign-in session."
        checked={s.signature}
        onChange={(next) => set("signature", next)}
      />
    </Card>
  );
}

/**
 * A stacked radio group (STYLEGUIDE §Overlays' radio-card recipe, outside a
 * dialog): a label and one description sentence per card, the chosen card
 * tinted, and the card's own controls (a number, a date) shown under its
 * description while it is chosen. The radio and the extra control are
 * siblings, never nested in one label, so each keeps one accessible name.
 */
function RadioCards<T extends string>({
  label,
  name,
  value,
  onChange,
  options,
}: {
  /** The group's accessible name (the card's title). */
  label: string;
  name: string;
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string; description: string; extra?: ReactNode }[];
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className="space-y-2">
      {options.map((o) => {
        const checked = o.value === value;
        const rid = `${id}-${o.value}`;
        return (
          <div
            key={o.value}
            className={`flex gap-3 rounded-lg border p-3 transition ${checked ? "border-compass-300 bg-compass-50/60" : "border-slate-200 hover:bg-slate-50"}`}
          >
            <input
              type="radio"
              id={rid}
              name={name}
              value={o.value}
              checked={checked}
              onChange={() => onChange(o.value)}
              aria-describedby={`${rid}-desc`}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <label htmlFor={rid} className="block cursor-pointer text-sm font-medium text-slate-800">
                {o.label}
              </label>
              <span id={`${rid}-desc`} className="block text-xs text-slate-500">
                {o.description}
              </span>
              {checked && o.extra && <div className="mt-3">{o.extra}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The Field's label recipe around a composite picker (STYLEGUIDE §Forms: a picker keeps its own markup). */
function PickerLabel({ children }: { children: ReactNode }) {
  return <span className="mb-1 block text-xs font-medium text-slate-500">{children}</span>;
}

/**
 * Who must confirm (D1): space mode (everyone who can see the space, what
 * every policy did before) or targeted mode (groups, people and ladder
 * roles, minus exclusions; every name is still held to the space's
 * visibility). The two switches apply in both modes. The live line counts
 * the rules as the card holds them through GET ?preview=1, debounced,
 * nothing written.
 */
export function AudienceCard({
  model,
  docId,
  groups,
  people: peopleOptions,
  newJoinerDays,
}: {
  model: PolicySettingsModel;
  docId: number;
  groups: PickerOption[];
  people: PickerOption[];
  /** The resolved new_joiner_days, for the enrol switch's help. */
  newJoinerDays: number;
}) {
  const { s, set, errors } = model;
  const id = useId();
  const [preview, setPreview] = useState<{ count: number; no_access: number } | null>(null);
  const rulesJson = JSON.stringify(rulesFromForm(s));

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      const qs = new URLSearchParams({
        preview: "1",
        audience_mode: s.audience_mode,
        exclude_stewards: s.exclude_stewards ? "1" : "0",
        rules: rulesJson,
      });
      try {
        const res = await fetch(`/api/documents/${docId}/ack-settings?${qs}`, { signal: ctrl.signal });
        if (res.ok) setPreview((await res.json()) as { count: number; no_access: number });
      } catch {
        /* aborted by a newer edit, or offline: the last line stands */
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [docId, s.audience_mode, s.exclude_stewards, rulesJson]);

  // One box for both kinds of exclusion (see excludeId).
  const excludeOptions: PickerOption[] = [
    ...groups.map((g) => ({ id: g.id, label: g.label, sublabel: g.sublabel ? `Group · ${g.sublabel}` : "Group" })),
    ...peopleOptions.map((p) => ({ id: -p.id, label: p.label, sublabel: "Person" })),
  ];

  function toggleRole(role: string, on: boolean) {
    const next = new Set(s.roles);
    if (on) next.add(role);
    else next.delete(role);
    set(
      "roles",
      AUDIENCE_ROLES.filter((r) => next.has(r))
    );
  }

  /** Space mode means everyone: the pickers are cleared with it (the server drops the rules too), so the next targeted save starts from nothing. */
  function chooseMode(mode: AudienceMode) {
    set("audience_mode", mode);
    if (mode !== "space") return;
    set("groups", []);
    set("people", []);
    set("roles", []);
    set("excludes", []);
  }

  const targeted = (
    <div className="space-y-4">
      <div>
        <PickerLabel>Groups</PickerLabel>
        <EntityPicker
          options={groups}
          value={s.groups}
          onChange={(ids) => set("groups", ids)}
          label="Groups"
          placeholder="Search groups…"
          emptyText="No groups match."
        />
      </div>
      <div>
        <PickerLabel>People</PickerLabel>
        <EntityPicker
          options={peopleOptions}
          value={s.people}
          onChange={(ids) => set("people", ids)}
          label="People"
          placeholder="Search people…"
          emptyText="No people match."
        />
        <span className="mt-1 block text-xs text-slate-500">{PEOPLE_ACCESS_RULE}</span>
      </div>
      <fieldset>
        <legend className="mb-1 block text-xs font-medium text-slate-500">Roles</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700">
          {AUDIENCE_ROLES.map((role) => (
            <label key={role} className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={s.roles.includes(role)} onChange={(e) => toggleRole(role, e.target.checked)} />
              {role.charAt(0).toUpperCase() + role.slice(1)}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <PickerLabel>Exclude</PickerLabel>
        <EntityPicker
          options={excludeOptions}
          value={s.excludes}
          onChange={(ids) => set("excludes", ids)}
          label="Exclude"
          placeholder="e.g. Contractors"
          emptyText="No groups or people match."
        />
        <span className="mt-1 block text-xs text-slate-500">Groups and people left out even when a rule above names them.</span>
      </div>
      {errors.audience && (
        <p role="alert" className="text-xs text-red-600">
          {errors.audience}
        </p>
      )}
    </div>
  );

  return (
    <Card
      title="Who must confirm"
      description="The people this policy asks for a read confirmation. Whoever is named, only people who can see this document's space are asked."
    >
      <RadioCards<AudienceMode>
        label="Who must confirm"
        name={`${id}-audience`}
        value={s.audience_mode}
        onChange={chooseMode}
        options={[
          {
            value: "space",
            label: "Everyone who can see this space",
            description: "Every active account with access to the space, and anyone who gains access later.",
          },
          {
            value: "targeted",
            label: "Specific groups, people and roles",
            description: "Only the groups, people and roles named here, minus any exclusions.",
            extra: targeted,
          },
        ]}
      />

      <div className="mt-4 space-y-2">
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-800">
          <input
            type="checkbox"
            className="mt-0.5 shrink-0"
            checked={s.exclude_stewards}
            onChange={(e) => set("exclude_stewards", e.target.checked)}
          />
          <span>Exempt the document&apos;s author and approvers</span>
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-800">
          <input
            type="checkbox"
            className="mt-0.5 shrink-0"
            checked={s.assign_new_members}
            onChange={(e) => set("assign_new_members", e.target.checked)}
            aria-describedby={`${id}-joiners`}
          />
          <span className="min-w-0">
            <span className="block">Enrol new joiners automatically</span>
            <span id={`${id}-joiners`} className="block text-xs text-slate-500">
              New accounts and people added to the audience get {newJoinerDays} days from the day they join
            </span>
          </span>
        </label>
      </div>

      {/* The live line: what a save would hold open, and who is named but cannot see the space. */}
      <p className="mt-4 text-xs text-slate-500" aria-live="polite">
        {preview
          ? `Applies to ${people(preview.count)}${preview.no_access > 0 ? ` · ${preview.no_access} without access` : ""}`
          : "Counting who this applies to…"}
      </p>
    </Card>
  );
}

/**
 * The deadline (E1): inherit the space's or the workspace's days, a number
 * of days after each person's assignment, or one fixed date. The helper
 * line reads the stored rule (what the current audience actually has); the
 * secondary button recomputes every open deadline from the rule as the card
 * holds it.
 */
export function DeadlineCard({
  model,
  server,
  busy,
  moving,
  onMoveExisting,
}: {
  model: PolicySettingsModel;
  server: PolicySettingsInitial;
  busy: boolean;
  moving: boolean;
  onMoveExisting: () => void;
}) {
  const { s, set, errors } = model;
  const fmt = useFormatDate();
  const id = useId();
  const today = ymd(new Date());
  const deadlineInvalid = Boolean(errors.due_days || errors.due_at);
  // The stored fixed date has passed and nobody moved it (dueDateError
  // judges only an edit, so the other cards still save): a hint under the
  // field, as the Re-confirmation card's, saying what the rows get meanwhile.
  const stale = Boolean(server.rule.due_at && server.rule.due_at < today);

  return (
    <Card
      title="Deadline"
      description="How long people have to confirm this policy. A deadline never blocks the document: an overdue person can still read and confirm it."
    >
      <RadioCards<DueMode>
        label="Deadline"
        name={`${id}-due`}
        value={s.due_mode}
        onChange={(mode) => set("due_mode", mode)}
        options={[
          {
            value: "inherit",
            label: inheritLabel(server.inherited, server.defaults.space?.name),
            description: "Follows the space's or the workspace's rule, and moves with it when that changes.",
          },
          {
            value: "days",
            label: "Days after assignment",
            description: "Each person's own deadline, counted from the day they are asked. A change applies to future assignments.",
            extra: (
              <Field label="Days" size="xs" error={errors.due_days}>
                <TextInput
                  type="number"
                  inputMode="numeric"
                  min={DUE_RANGES.due_days.min}
                  max={DUE_RANGES.due_days.max}
                  step={1}
                  value={s.due_days}
                  onChange={(e) => set("due_days", e.target.value)}
                />
              </Field>
            ),
          },
          {
            value: "fixed",
            label: "Fixed date",
            description: "One date for everyone. Changing it moves every open deadline.",
            extra: (
              <>
                <Field label="Due date" size="sm" error={errors.due_at}>
                  <TextInput type="date" min={today} value={s.due_at} onChange={(e) => set("due_at", e.target.value)} />
                </Field>
                {stale && <p className="mt-2 text-xs text-slate-500">{DUE_DATE_PASSED_HINT}</p>}
              </>
            ),
          },
        ]}
      />

      {/* The stored rule, as the current audience has it; the day formatter for a fixed 'YYYY-MM-DD'. */}
      <p className="mt-4 text-xs text-slate-500">{audienceDueHelper(server.rule, server.defaults.values, fmt.day)}</p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="min-w-0 text-sm text-slate-600">
          Deadlines already set keep their dates when the rule changes. Recompute every open deadline from the rule above.
        </p>
        {deadlineInvalid ? (
          <Tooltip label="Fix the highlighted fields first.">
            <Button variant="secondary" size="sm" disabled>
              {MOVE_EXISTING_LABEL}
            </Button>
          </Tooltip>
        ) : (
          <Button variant="secondary" size="sm" onClick={onMoveExisting} disabled={busy} busy={moving}>
            {MOVE_EXISTING_LABEL}
          </Button>
        )}
      </div>
    </Card>
  );
}

/** The help under a blank reminder field: the number it inherits and where from. */
function inheritedHelp(server: PolicySettingsInitial, key: ReminderKey): string {
  const value = server.inherited.values[key];
  switch (server.inherited.origin[key]) {
    case "space":
      return `Inherited from ${server.defaults.space?.name ?? "the"} space (${value})`;
    case "workspace":
      return `Inherited from workspace (${value})`;
    default:
      return `Built-in (${value})`;
  }
}

/**
 * Reminders (E2): the four numbers of this policy's cadence, blank to
 * inherit, in a two-column grid, and the policy owner, who hears the
 * escalations (else whoever switched the requirement on, else the space's
 * approvers).
 */
export function RemindersCard({ model, server }: { model: PolicySettingsModel; server: PolicySettingsInitial }) {
  const { s, set, errors } = model;
  const helpByKey = Object.fromEntries(DUE_FIELDS.map((f) => [f.key, f.help])) as Record<string, string>;
  // The chip's name: the server's (the stored owner, even one the picker
  // does not offer), else the picked option's.
  const ownerName =
    s.owner_user_id === null
      ? null
      : (s.owner_user_id === server.owner_user_id ? server.owner_name : null) ??
        server.people.find((o) => o.id === s.owner_user_id)?.label ??
        `User #${s.owner_user_id}`;

  return (
    <Card
      title="Reminders"
      description="When people are reminded about this policy and when it is escalated. A blank field inherits the space's or the workspace's number."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {REMINDER_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} help={s[f.key] === "" ? inheritedHelp(server, f.key) : helpByKey[f.key]} error={errors[f.key]}>
            <TextInput
              type="number"
              inputMode="numeric"
              min={DUE_RANGES[f.key].min}
              max={DUE_RANGES[f.key].max}
              step={1}
              placeholder={String(server.inherited.values[f.key])}
              value={s[f.key]}
              onChange={(e) => set(f.key, e.target.value)}
            />
          </Field>
        ))}
      </div>

      {/* A composite picker keeps its own markup (STYLEGUIDE §Forms): the
          Lifecycle card's "Replaced by" recipe, a chip with its clear button
          once someone is chosen. */}
      <div className="mt-4 max-w-md">
        <PickerLabel>Policy owner</PickerLabel>
        {s.owner_user_id !== null ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-compass-200 bg-compass-50 px-3 py-1.5 text-sm font-medium text-compass-800">
            {ownerName}
            <button
              type="button"
              onClick={() => set("owner_user_id", null)}
              data-tt="Clear owner"
              aria-label="Clear owner"
              className={iconButtonClass("quiet", "sm", "-mr-1")}
            >
              <X />
            </button>
          </span>
        ) : (
          <EntityPicker
            options={server.people}
            onPick={(id) => set("owner_user_id", id)}
            label="Policy owner"
            placeholder={server.requested_by ? server.requested_by.name : "Search people…"}
            emptyText="No people match."
            maxVisible={10}
          />
        )}
        <span className="mt-1 block text-xs text-slate-500">
          Hears when people are overdue. Leave blank for whoever switched the requirement on
          {server.requested_by ? ` (${server.requested_by.name})` : ""}, else the space&apos;s approvers.
        </span>
      </div>
    </Card>
  );
}

/**
 * Periodic re-confirmation (G1): the interval, the next date and the
 * effective date. Changing the interval prefills the next date the way the
 * server would schedule it (marker + N months, or 14 days out when that is
 * already past); the date can then be moved, and the warn line says when
 * the first cycle was pushed out because people last re-confirmed longer
 * ago than the interval.
 */
export function ReconfirmationCard({
  model,
  marker,
  workspaceDefault,
  stored,
}: {
  model: PolicySettingsModel;
  /** ack_revision_at: when everyone was last asked. */
  marker: string;
  /** Program settings' interval; null for Never. */
  workspaceDefault: number | null;
  /** What the server holds, so choosing the stored interval again brings its stored date back. */
  stored: { recert_months: number | null; next_recert_at: string };
}) {
  const { s, set, errors } = model;
  const fmt = useFormatDate();
  const markerDate = new Date(marker);
  const now = new Date();
  const options = RECERT_OPTIONS.some((o) => o.months === s.recert_months)
    ? RECERT_OPTIONS
    : [...RECERT_OPTIONS, { months: s.recert_months, label: recertOptionLabel(s.recert_months) }];

  function onInterval(value: string) {
    const months = value === "" ? null : Number(value);
    set("recert_months", months);
    // Never: no date. The stored interval again: its stored date comes back.
    // Another interval: the date the server would schedule from the marker.
    if (months === null) set("next_recert_at", "");
    else if (months === stored.recert_months) set("next_recert_at", stored.next_recert_at);
    else set("next_recert_at", ymd(nextRecertDate(markerDate, months, now)));
  }

  // The first cycle was pushed out: the marker plus the interval is already
  // in the past, so the server dates it 14 days from now instead.
  const pushedOut = s.recert_months !== null && addMonths(markerDate, s.recert_months).getTime() <= now.getTime();
  const firstCycle = s.next_recert_at || (s.recert_months !== null ? ymd(nextRecertDate(markerDate, s.recert_months, now)) : "");
  // The stored date has passed and nobody moved it: a retired or paused
  // policy's cycle fell due while the sweep left it alone. A hint, not an
  // error (nextDateError judges only an edit), so the other cards still save.
  const stale =
    s.recert_months !== null &&
    s.next_recert_at !== "" &&
    s.next_recert_at === stored.next_recert_at &&
    stored.next_recert_at < ymd(now);

  return (
    <Card
      title="Re-confirmation"
      description="How often everyone is asked to read and confirm this policy again, whether or not its text changed, and the day it came into force."
    >
      <Field
        label="Re-confirm every"
        help="Everyone who can see this document is asked to read and confirm it again at this interval. Applied from the workspace default when confirmation was first required."
        size="sm"
      >
        <Select value={s.recert_months === null ? "" : String(s.recert_months)} onChange={(e) => onInterval(e.target.value)}>
          {options.map((o) => (
            <option key={o.months ?? "never"} value={o.months === null ? "" : String(o.months)}>
              {o.months === workspaceDefault ? `${o.label} (workspace default)` : o.label}
            </option>
          ))}
        </Select>
      </Field>

      {s.recert_months !== null && (
        <Field
          label="Next re-confirmation"
          help="Everyone is asked again on this date. A material change restarts the interval."
          error={errors.next_recert_at}
          size="sm"
          className="mt-4"
        >
          <TextInput
            type="date"
            min={ymd(now)}
            value={s.next_recert_at}
            onChange={(e) => set("next_recert_at", e.target.value)}
          />
        </Field>
      )}

      {stale && <p className="mt-2 text-xs text-slate-500">{NEXT_DATE_PASSED_HINT}</p>}

      {pushedOut && s.recert_months !== null && (
        // The hint that must be amber (STYLEGUIDE §Notices: ink-warn, never a bare text-amber).
        // The date is a calendar day ('YYYY-MM-DD'): the day formatter, so it
        // reads as the day the input shows in every time zone.
        <p className="mt-2 text-xs ink-warn">
          People last re-confirmed {monthsBetween(markerDate, now)} months ago. The first cycle is scheduled for{" "}
          {fmt.day(firstCycle)}: change the date, or use Ask everyone to re-confirm now.
        </p>
      )}

      <Field
        label="Effective date"
        help="The day this policy came into force. Set to the day confirmation was first required unless you change it."
        size="sm"
        className="mt-4"
      >
        <TextInput type="date" value={s.effective_at} onChange={(e) => set("effective_at", e.target.value)} />
      </Field>
    </Card>
  );
}

/**
 * The lifecycle (G3): the policy that replaces this one, saved through the
 * page's Save row like any field, and the end of its life. Retire asks
 * first with the standing and a required reason, then POSTs and refreshes;
 * a retired policy shows when, by whom and why, with Un-retire, which asks
 * and then resumes. Both are secondary buttons: the Save row is the page's
 * one primary action.
 */
export function LifecycleCard({
  model,
  doc,
  server,
  onRetired,
  onResumed,
}: {
  model: PolicySettingsModel;
  doc: { id: number; title: string };
  server: PolicySettingsInitial;
  onRetired: (retired: NonNullable<PolicySettingsInitial["retired"]>) => void;
  onResumed: (standing: { current: number; eligible: number }) => void;
}) {
  const { s, set } = model;
  const fmt = useFormatDate();
  const { run, isBusy, busy } = useAction();
  const { retired, summary, replacements, required } = server;
  // Focus after Retire / Un-retire (STYLEGUIDE §Settings pages: focus never
  // falls to <body>). The dialog hands focus back to the button that opened
  // it, and the state flip then unmounts that button. Focus moves to the
  // button that replaced it; while that one is disabled (the route refresh
  // keeps the card busy for a moment) it parks on the card's heading, and
  // moves on to the button once it is live, unless the person went
  // elsewhere meanwhile.
  const headingRef = useRef<HTMLSpanElement>(null);
  const retireRef = useRef<HTMLButtonElement>(null);
  const unretireRef = useRef<HTMLButtonElement>(null);
  const [focusNext, setFocusNext] = useState<"retire" | "unretire" | null>(null);
  useEffect(() => {
    if (!focusNext) return;
    const heading = headingRef.current;
    const active = document.activeElement;
    const parked = active === null || active === document.body || active === heading;
    if (!parked) {
      setFocusNext(null);
      return;
    }
    const target = (focusNext === "retire" ? retireRef : unretireRef).current;
    if (target && !target.disabled) {
      target.focus();
      setFocusNext(null);
    } else {
      heading?.focus();
    }
  }, [focusNext, busy]);
  // The chip's title: the server's (the stored replacement, even one the
  // picker does not offer), else the picked option's.
  const chosenTitle =
    s.superseded_by === null
      ? null
      : (s.superseded_by === server.superseded_by ? server.superseded_by_title : null) ??
        replacements.find((o) => o.id === s.superseded_by)?.label ??
        `Document #${s.superseded_by}`;

  async function retire() {
    const version = summary.rev ? `version ${summary.rev}` : "the current version";
    // Awaited before any busy state (STYLEGUIDE §Overlays): Cancel leaves
    // the control idle.
    const values = await formDialog({
      title: `Retire "${doc.title}"?`,
      body: `${summary.current} of ${summary.eligible} people have confirmed ${version}. Retiring stops asking anyone to confirm, keeps every confirmation on record, and lists the policy under Retired in Compliance. The document itself stays as it is; unpublish it separately if people should no longer read it.`,
      fields: [
        {
          key: "reason",
          label: "Why is this policy being retired?",
          type: "textarea",
          required: true,
          help: "Shown on the compliance record and in exports",
          validate: (v) => (v.trim().length < 10 ? RECONFIRM_REASON_TOO_SHORT : undefined),
        },
      ],
      confirmLabel: "Retire policy",
    });
    if (!values) return;
    const reason = values.reason.trim();
    const box: { result?: { acked?: number; required?: number } } = {};
    const ok = await run(
      "retire",
      async () => {
        const res = await fetch(`/api/documents/${doc.id}/ack/retire`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as typeof box.result;
        return res;
      },
      { fallback: "Couldn't retire the policy." }
    );
    if (!ok) return;
    onRetired({ at: new Date().toISOString(), by: server.viewerName, reason });
    setFocusNext("unretire");
    const acked = Number(box.result?.acked ?? summary.current);
    const total = Number(box.result?.required ?? summary.eligible);
    // The portal row's sentence, word for word (STYLEGUIDE §Vocabulary).
    toast("ok", `Policy retired: ${acked} of ${total} confirmations on record`);
  }

  async function unretire() {
    const ok = await confirmDialog({
      title: `Resume read confirmation for "${doc.title}"?`,
      body: "Confirmations made before it was retired stay on record. If the text changed while it was retired, people whose confirmation is older than the current version are asked again.",
      confirmLabel: "Resume",
    });
    if (!ok) return;
    const box: { result?: { current?: number; eligible?: number } } = {};
    const done = await run(
      "unretire",
      async () => {
        const res = await fetch(`/api/documents/${doc.id}/ack/unretire`, { method: "POST" });
        if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as typeof box.result;
        return res;
      },
      { fallback: "Couldn't resume the policy." }
    );
    if (!done) return;
    const standing = { current: Number(box.result?.current ?? 0), eligible: Number(box.result?.eligible ?? summary.eligible) };
    onResumed(standing);
    setFocusNext("retire");
    // The re-ask (A7) from the toast while anyone's confirmation is still
    // current: the header button's own question and POST (askReconfirm),
    // whose run() refreshes the route, which hands the panel the new
    // standing. Nothing to reset when nobody's is: no action.
    toast(
      "ok",
      `Policy resumed: ${standing.current} of ${standing.eligible} confirmations still current`,
      standing.current > 0
        ? {
            action: {
              label: RECONFIRM_LABEL,
              onClick: () =>
                void askReconfirm({ docId: doc.id, title: doc.title, summary: { ...standing, rev: summary.rev }, run }),
            },
          }
        : {}
    );
  }

  const retireButton = (
    <Button
      ref={retireRef}
      variant="secondary"
      size="sm"
      icon={<Archive />}
      onClick={() => void retire()}
      disabled={!required || busy}
      busy={isBusy("retire")}
    >
      {RETIRE_LABEL}
    </Button>
  );

  return (
    <Card
      // The heading is focusable by script only (tabIndex -1): where focus
      // parks while the button that replaced the one just used is disabled.
      title={
        <span ref={headingRef} tabIndex={-1}>
          Lifecycle
        </span>
      }
      description="The policy that replaces this one, and retiring it when it no longer applies. Retiring keeps every confirmation on record and lists the policy under Retired in Compliance."
    >
      {/* A composite picker keeps its own markup (STYLEGUIDE §Forms): the
          Field's label and help recipes around the picker, or the chosen
          document as a chip with its clear button (the portal's Request
          card). Not a Field: a label element around the chip would hand a
          click on the words to the clear button. */}
      <div className="max-w-md">
        <PickerLabel>Replaced by</PickerLabel>
        {s.superseded_by !== null ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-compass-200 bg-compass-50 px-3 py-1.5 text-sm font-medium text-compass-800">
            {chosenTitle}
            {/* An icon-only control takes the icon-button recipe (STYLEGUIDE
                §Buttons): a 28px square, never the glyph alone as the target. */}
            <button
              type="button"
              onClick={() => set("superseded_by", null)}
              data-tt="Clear replacement"
              aria-label="Clear replacement"
              className={iconButtonClass("quiet", "sm", "-mr-1")}
            >
              <X />
            </button>
          </span>
        ) : (
          <EntityPicker
            options={replacements}
            onPick={(id) => set("superseded_by", id)}
            label="Replaced by"
            placeholder="Find a published document…"
            emptyText="No published documents match."
            maxVisible={10}
          />
        )}
        <span className="mt-1 block text-xs text-slate-500">
          Readers of a retired policy are pointed to its replacement. Saved with the settings.
        </span>
      </div>

      <div className="mt-5 border-t border-slate-100 pt-4">
        {retired ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800">
                Retired {fmt.date(retired.at)}
                {retired.by ? ` by ${retired.by}` : ""}
              </p>
              {retired.reason && <p className="mt-0.5 text-sm text-slate-600">{retired.reason}</p>}
            </div>
            <Button
              ref={unretireRef}
              variant="secondary"
              size="sm"
              icon={<ArchiveRestore />}
              onClick={() => void unretire()}
              disabled={busy}
              busy={isBusy("unretire")}
            >
              {UNRETIRE_LABEL}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-slate-600">
              Stop asking anyone to confirm this policy. Its record, its versions and the document itself stay as they are.
            </p>
            {/* A disabled button does not fire hover reliably: the wrapper
                carries the tooltip (components/Tooltip is the recipe). */}
            {required ? retireButton : <Tooltip label="This document doesn't ask for a read confirmation.">{retireButton}</Tooltip>}
          </div>
        )}
      </div>
    </Card>
  );
}
