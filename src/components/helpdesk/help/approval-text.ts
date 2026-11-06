// How an approval names itself (1.19.0): one set of words for the Get help
// card, the Approvals page and the screen-reader suffix on its buttons, so
// the three cannot drift.

import type { HdApprovalCard } from "@/lib/helpdesk/types";

/** "Grace Lin: Second monitor". */
export function approvalHeadline(a: Pick<HdApprovalCard, "requester_name" | "subject">): string {
  return `${a.requester_name}: ${a.subject}`;
}

/** The suffix a button's accessible name carries: "#1052, Second monitor from Grace Lin". */
export function approvalMeta(a: Pick<HdApprovalCard, "ticket_number" | "requester_name" | "subject">): string {
  return `#${a.ticket_number}, ${a.subject} from ${a.requester_name}`;
}

/**
 * The money in the answers, when the form prices its choices ("Developer
 * laptop · 16-inch, 32 GB · £1,450" → "£1,450"): what an approver weighs
 * first.
 */
export function approvalAmount(a: Pick<HdApprovalCard, "answers">): string {
  for (const row of a.answers ?? []) {
    const m = row.value.match(/[£$€]\s?\d[\d,.]*/);
    if (m) return m[0];
  }
  return "";
}

/** A calendar day as given ("2026-11-12") prints through the day formatter; anything else as is. */
export function answerValue(value: string, day: (ymd: string) => string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? day(value) : value;
}

/** Long answers (a reason, a description) take the whole row. */
export function isLongAnswer(value: string): boolean {
  return value.length > 60 || value.includes("\n");
}
