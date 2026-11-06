// The "Through a handbook" tag (1.18.3): beside a person on a roster (the
// Record tab, the compliance portal, the team page) or beside a policy on a
// person's record, it says this person is asked to confirm the policy
// through a published handbook because they can't open the policy's space,
// so their reminders link to the handbook reader, not /doc/{id}. An accent
// `sm` chip with a compass-200 ring and the BookOpen icon (STYLEGUIDE
// §Status chips); the tooltip names the handbook when the viewer may see it
// (in its audience, or managing it), and otherwise says only that it is one
// the viewer can't open (`asked`, the row's asked_through_handbook, with no
// title), so a handbook's name never reaches someone outside it. On the
// person's own record (`self`) the tooltip says "you". Like every chip it is
// never a link, and it prints as plain outlined text (chipClass's print
// override). Server-safe.
//
// Also here: the link a handbook row on My policies or the dashboard opens,
// the policy's page in the reader with the confirm bar in view.

import { BookOpen } from "lucide-react";
import { chipClass } from "@/components/Chip";

export const THROUGH_HANDBOOK_LABEL = "Through a handbook";

/** Someone else's row whose handbook the viewer may not see by name. */
export const THROUGH_UNNAMED_HANDBOOK_TIP =
  "Asked through a handbook you can't open: they can't open this policy's space, so reminders link to the handbook.";

/**
 * "Asked through Employee Handbook 2026: they can't open this policy's
 * space, so reminders link to the handbook." With `self` (the person's own
 * record) the sentence says "you can't open".
 */
export function throughHandbookTip(title: string, opts: { self?: boolean } = {}): string {
  return `Asked through ${title}: ${opts.self ? "you" : "they"} can't open this policy's space, so reminders link to the handbook.`;
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
 * Renders nothing without a title unless `asked` says the person is asked
 * through a handbook the viewer may not see (the unnamed tooltip). Standing
 * alone it is focusable so the tooltip reaches keyboard users; inside a
 * link pass `inLink` (plain text, no tooltip: a focusable tooltip cannot
 * sit inside a link).
 */
export function ThroughHandbookTag({
  title,
  asked = false,
  self = false,
  inLink = false,
  className = "ml-2",
}: {
  title: string | null | undefined;
  /** The row's asked_through_handbook: shows the tag with the unnamed tooltip when the title is withheld. */
  asked?: boolean;
  /** The person's own record: the tooltip says "you can't open". */
  self?: boolean;
  inLink?: boolean;
  /** Spacing from what it follows; "ml-2" beside a name in running text, "" in a row that spaces its children with gap. */
  className?: string;
}) {
  if (!title && !asked) return null;
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
  const tip = title ? throughHandbookTip(title, { self }) : THROUGH_UNNAMED_HANDBOOK_TIP;
  return (
    <span className={cls} tabIndex={0} data-tt={tip} data-tt-wrap="">
      <BookOpen className="h-3 w-3" aria-hidden /> {THROUGH_HANDBOOK_LABEL}
      <span className="sr-only">: {title || "a handbook you can't open"}</span>
    </span>
  );
}
