// The "Handbook only" chip (Handbooks 1.18.0): marks a document whose readers
// find it only through its handbooks, wherever the people who look after the
// space still see it (the space page's views). A neutral status chip with
// the BookOpen icon; never a link or a picker (STYLEGUIDE §Status chips).
// Server-safe.

import { BookOpen } from "lucide-react";
import { chipClass } from "@/components/Chip";

export const HANDBOOK_ONLY_LABEL = "Handbook only";

/** "Employee Handbook 2026", "A and B", "A, B and C", "A, B and 2 more": the handbooks a document is read in. */
export function handbookNames(titles: string[]): string {
  if (titles.length <= 1) return titles[0] ?? "";
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  if (titles.length === 3) return `${titles[0]}, ${titles[1]} and ${titles[2]}`;
  return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more`;
}

/** "Readers find it only in Employee Handbook 2026." — the chip's tooltip and the row's explanation. */
export function handbookOnlyTip(handbooks: string[]): string {
  return handbooks.length
    ? `Readers find it only in ${handbookNames(handbooks)}.`
    : "Readers find it only in its handbooks.";
}

/**
 * `handbooks` names the published handbooks it is read in. Inside a link
 * (a card or a row that is one big link) pass `inLink`: the chip is plain
 * text there, because a focusable tooltip cannot sit inside a link; the
 * row says where it is read on its meta line instead.
 */
export function HandbookOnlyChip({
  handbooks,
  inLink = false,
  className = "",
}: {
  handbooks: string[];
  inLink?: boolean;
  className?: string;
}) {
  if (inLink) {
    return (
      <span className={chipClass("neutral", "sm", `shrink-0 ${className}`)}>
        <BookOpen className="h-3 w-3" aria-hidden /> {HANDBOOK_ONLY_LABEL}
      </span>
    );
  }
  return (
    <span
      className={chipClass("neutral", "sm", `shrink-0 ${className}`)}
      tabIndex={0}
      data-tt={handbookOnlyTip(handbooks)}
      data-tt-wrap=""
    >
      <BookOpen className="h-3 w-3" aria-hidden /> {HANDBOOK_ONLY_LABEL}
    </span>
  );
}
