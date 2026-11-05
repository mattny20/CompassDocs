// "What changed in version 3" (1.18.0): shown in the handbook reader when
// the reader confirmed an earlier version of this policy than the one on
// screen, whether that confirmation lapsed when the text changed or still
// counts after a kept edit. The sentence is built from the version notes
// written since the confirmed version (oldest first, as they happened);
// a run of versions with no notes says when the text was last updated
// instead. "Compare versions" opens the existing compare view in version
// history, and only for a reader who may open the document's own page: a
// reader who reaches the policy through the handbook alone would land on
// a 404. Amber because it is a change the reader has not yet confirmed
// (notice-warn carries both themes and print). Server-safe.

import Link from "next/link";

export function WhatChanged({
  rev,
  confirmedRev,
  notes,
  updatedLabel,
  compareHref,
}: {
  /** The version on screen. */
  rev: number | null;
  /** The version the reader confirmed; null when it could not be worked out. */
  confirmedRev: number | null;
  /** Notes of the versions written since the confirmed one, oldest first; blanks are skipped. */
  notes: string[];
  /** "Nov 2, 2026", the newest version's date, for when no version carries a note. */
  updatedLabel: string | null;
  /** /doc/{id}/history?from=…&to=current, or null when the reader may not open it. */
  compareHref: string | null;
}) {
  const said = notes.map((n) => n.trim().replace(/[.;\s]+$/, "")).filter(Boolean);
  const body =
    said.length > 0 ? `${said.join("; ")}.` : updatedLabel ? `The text was updated on ${updatedLabel}.` : "The text was updated.";
  return (
    <div className="notice-warn rounded-lg border px-4 py-3 text-sm leading-relaxed break-inside-avoid">
      <strong className="font-semibold">What changed{rev !== null ? ` in version ${rev}` : ""}</strong>
      {confirmedRev !== null ? ` (you confirmed version ${confirmedRev})` : " (since you confirmed it)"}: {body}
      {compareHref && (
        <>
          {" "}
          {/* The notice's own ink, underlined: an accent link would break
              the amber panel's contrast in dark mode. */}
          <Link href={compareHref} className="font-medium underline underline-offset-2 hover:decoration-2 print:hidden">
            Compare versions
          </Link>
        </>
      )}
    </div>
  );
}
