// The "Through a handbook" tag (1.18.3): beside a person on a roster (the
// Record tab, the compliance portal, the team page) or beside a policy on a
// person's record, it says this person is asked to confirm the policy
// through a published handbook because they can't open the policy's space,
// so their reminders link to the handbook reader, not /doc/{id}. An accent
// `sm` chip with a compass-200 ring and the BookOpen icon (STYLEGUIDE
// §Status chips); the tooltip names the handbook. Like every chip it is
// never a link, and it prints as plain outlined text (chipClass's print
// override). Server-safe.
//
// Also here: the link a handbook row on My policies or the dashboard opens,
// the policy's page in the reader with the confirm bar in view.

import { BookOpen } from "lucide-react";
import { chipClass } from "@/components/Chip";

export const THROUGH_HANDBOOK_LABEL = "Through a handbook";

/** "Asked through Employee Handbook 2026: they can't open this policy's space, so reminders link to the handbook." */
export function throughHandbookTip(title: string): string {
  return `Asked through ${title}: they can't open this policy's space, so reminders link to the handbook.`;
}

/**
 * The reader's anchor for the confirm bar: CONFIRM_SECTION_ID in
 * lib/use-reached-end, the id PolicyConfirmBar's section carries (written
 * out here because that module is a client module and this one is also
 * read by server pages). The reader's contents rail scrolls to the hash
 * once the body has rendered.
 */
const CONFIRM_ANCHOR = "confirm-reading";

/** `/handbooks/{id}/{docId}#confirm-reading`: a policy's page in the handbook reader, at its confirm bar. */
export function handbookConfirmHref(handbookId: number, docId: number): string {
  return `/handbooks/${handbookId}/${docId}#${CONFIRM_ANCHOR}`;
}

/**
 * Renders nothing without a title. Standing alone it is focusable so the
 * tooltip reaches keyboard users; inside a link pass `inLink` (plain text,
 * no tooltip: a focusable tooltip cannot sit inside a link).
 */
export function ThroughHandbookTag({
  title,
  inLink = false,
  className = "ml-2",
}: {
  title: string | null | undefined;
  inLink?: boolean;
  /** Spacing from what it follows; "ml-2" beside a name in running text, "" in a row that spaces its children with gap. */
  className?: string;
}) {
  if (!title) return null;
  const cls = chipClass(
    "accent",
    "sm",
    `shrink-0 align-middle ring-1 ring-inset ring-compass-200 dark:ring-compass-500/40 ${className}`
  );
  if (inLink) {
    return (
      <span className={cls}>
        <BookOpen className="h-3 w-3" aria-hidden /> {THROUGH_HANDBOOK_LABEL}
      </span>
    );
  }
  // data-tt is presentation: the handbook's name rides along for screen
  // readers, who would otherwise hear the label without the where.
  return (
    <span className={cls} tabIndex={0} data-tt={throughHandbookTip(title)} data-tt-wrap="">
      <BookOpen className="h-3 w-3" aria-hidden /> {THROUGH_HANDBOOK_LABEL}
      <span className="sr-only">: {title}</span>
    </span>
  );
}
