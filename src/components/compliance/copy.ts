// Shared compliance copy (1.10.1): the three edit-default options, the
// portal's chip labels for them and the people() count, in one small
// client-safe module. The shield popover (AckSettings), the portal
// (PortalPolicies), the re-ask control (ReconfirmButton), the editor's
// question (ReconfirmModal), the shared "Require read confirmation?" dialog
// (RequireAckDialog) and the Program settings form all read it here, so no
// surface keeps a private copy of a sentence another one shows, and the
// document page does not pull the settings form (its SaveRow, Card and
// unsaved-changes hooks) into its bundle for three labels. No React in
// here: a plain module both server and client components can import.

import type { EditDefault } from "@/lib/compliance-settings";
import type { PolicyAttentionReason } from "@/lib/types";

/** "42 people" / "1 person": counts are always of people (STYLEGUIDE §Vocabulary). */
export function people(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** The three answers to "when the text of a policy changes", in the order
 *  the Selects show them (Program settings E4, the shield popover A5). The
 *  popover suffixes the one equal to the workspace value with "(workspace
 *  default)", dropping "(recommended)" first so no option carries two
 *  parentheticals. */
export const EDIT_DEFAULT_OPTIONS: { value: EditDefault; label: string; help: string }[] = [
  {
    value: "ask",
    label: "Ask the editor each time (recommended)",
    help: "Every text save opens the question: editorial fix, or material change. The editor decides and the record keeps the choice.",
  },
  {
    value: "material",
    label: "Ask only when a change looks material",
    help: "Good for procedures that change often: typo-sized edits pass quietly and are recorded; anything that looks material still asks.",
  },
  {
    value: "reset",
    label: "Always ask everyone to re-confirm",
    help: "Good for signed-off policies: every text change asks everyone to re-confirm, and the change note is required.",
  },
];

/** The per-policy edit-default chip on the portal row (A5): a short state;
 *  the full option sentence is its tooltip (PortalPolicies' editDefaultTip). */
export const EDIT_DEFAULT_CHIP: Record<EditDefault, string> = {
  ask: "Asks editor",
  material: "Asks when material",
  reset: "Always re-asks",
};

// ── The Needs attention queue (F1, 1.14.0) ───────────────────────────────────

/** The section-level line when the queue is empty. */
export const ATTENTION_EMPTY = "Nothing needs attention.";

/** The queue's Remind: one reminder for this person on this policy (the bulk route's remind_people, 1.14.0). */
export const REMIND_TIP = "Send a reminder now";
/** The queue's Snooze: the row leaves the queue and the person's automatic reminders pause; nothing else changes. */
export const SNOOZE_TIP = "Hide from this queue for 7 days";
/** The queue's "Extend 7 days". */
export const EXTEND_TIP = "Push this person's due date out a week";
/** The queue's Exempt…. */
export const EXEMPT_TIP = "Exempt this person from the policy, with a reason";
/** The queue's Remove exemption (a standing exemption under review). */
export const UNEXEMPT_TIP = "Remove the exemption; the person is asked again with a fresh due date";
/** The sentence under the queue while a snooze hides rows, before the D2 invariant. */
export const SNOOZED_ROWS_NOTE = "Snoozed rows are out of this queue until their date.";

/** The reason chip's tone: the closed set of components/Chip. */
export type AttentionTone = "error" | "warn" | "neutral";

/**
 * The reason chip (items/F1.md's copy): the text and its tone per reason.
 * The due date on an overdue row is formatted by the caller's date formatter
 * (the row carries it as ISO); the policy-level rows read their detail
 * ("7.8% since v12", "Kept against the suggestion 3 times").
 */
export function attentionChip(
  row: { reason: PolicyAttentionReason; detail: string | null; due_at: string | null },
  date: (iso: string) => string
): { text: string; tone: AttentionTone } {
  switch (row.reason) {
    case "overdue": {
      const when = row.due_at ?? row.detail;
      return { text: when ? `Overdue · ${date(when)}` : "Overdue", tone: "error" };
    }
    case "escalated":
      return { text: "Escalated", tone: "error" };
    case "never_opened":
      return { text: "Never opened", tone: "warn" };
    case "opened_not_confirmed":
      return { text: "Opened, not confirmed", tone: "neutral" };
    case "standing_exemption":
      return { text: "Standing exemption · review", tone: "neutral" };
    case "drifted":
      return { text: row.detail ? `Confirmed text drifted ${row.detail}` : "Confirmed text drifted", tone: "warn" };
    case "kept_n":
      return { text: row.detail ?? "Kept against the suggestion", tone: "warn" };
  }
}

/**
 * The queue header's count line: "showing 12 of 19 · 7 snoozed"; "showing 19
 * of 19" when nothing is cut (the training queue's wording: a count keeps its
 * noun, never a bare digit); the snoozed part only when a snooze hides rows;
 * nothing at all on an empty queue, where "Nothing needs attention." is the
 * one line.
 */
export function attentionCount(shown: number, total: number, snoozed: number): string | undefined {
  if (total === 0) return undefined;
  const head = `showing ${shown} of ${total}`;
  return snoozed > 0 ? `${head} · ${snoozed} snoozed` : head;
}

// ── The Policies row's stacked bar and sort (F1, 1.14.0) ─────────────────────

/** The bar's four numbers from a portal row (older servers carry only acked / required / overdue). */
export function barCounts(d: { required: number; acked: number; confirmed?: number; pending?: number; overdue?: number; exempt?: number }) {
  const confirmed = d.confirmed ?? d.acked;
  const pending = d.pending ?? Math.max(0, d.required - d.acked);
  const overdue = Math.min(pending, d.overdue ?? 0);
  const exempt = d.exempt ?? 0;
  return { confirmed, pending, overdue, exempt, total: confirmed + pending + exempt };
}

/** The legend under the bar: "312 confirmed · 88 pending · 12 overdue · 4 exempt" (pending includes the overdue rows). */
export function barLegend(d: Parameters<typeof barCounts>[0]): string {
  const c = barCounts(d);
  return `${c.confirmed} confirmed · ${c.pending} pending · ${c.overdue} overdue · ${c.exempt} exempt`;
}

/** The bar's accessible name: the same four numbers, comma-separated so a reader hears a list. */
export function barLabel(d: Parameters<typeof barCounts>[0]): string {
  const c = barCounts(d);
  return `${c.confirmed} confirmed, ${c.pending} pending, ${c.overdue} overdue, ${c.exempt} exempt`;
}

/** "3 edits kept since v12" / "1 edit kept since the last ask": the row subtitle's kept-edits part (C1's count). */
export function keptLine(n: number, rev: number | null | undefined): string {
  const since = rev ? `v${rev}` : "the last ask";
  return `${n} ${n === 1 ? "edit" : "edits"} kept since ${since}`;
}

/** The Policies page's Sort choices, in the order the Select shows them. */
export const POLICY_SORTS = [
  { value: "overdue", label: "Most overdue" },
  { value: "compliance", label: "Lowest compliance" },
  { value: "due", label: "Due soonest" },
  { value: "title", label: "Title A-Z" },
] as const;
export type PolicySort = (typeof POLICY_SORTS)[number]["value"];

// ── The People page's standing (F1, 1.14.0) ──────────────────────────────────

/**
 * A person's standing: everything confirmed → Compliant; anything overdue →
 * "{n} overdue"; else "{n} outstanding". The chip's tone follows the closed
 * set (ok / error / warn).
 */
export function standingOf(u: { required: number; acked: number; overdue?: number }): {
  kind: "compliant" | "overdue" | "outstanding";
  text: string;
  tone: "ok" | "error" | "warn";
} {
  if (u.acked >= u.required) return { kind: "compliant", text: "Compliant", tone: "ok" };
  const overdue = u.overdue ?? 0;
  if (overdue > 0) return { kind: "overdue", text: `${overdue} overdue`, tone: "error" };
  return { kind: "outstanding", text: `${u.required - u.acked} outstanding`, tone: "warn" };
}
