// The space page's note to the people who look after a space (Handbooks
// 1.18.0): how many of its documents are handbook only, why this person
// still sees them, and where readers find them. One sentence, one or more
// links to the handbooks; informational, so neither a notice-* state banner
// nor a card. Server-safe.

import Link from "next/link";
import { Fragment } from "react";
import { BookOpen } from "lucide-react";

export function SpaceHandbookNotice({
  count,
  handbooks,
}: {
  /** Handbook-only documents listed on the page. */
  count: number;
  /** The published handbooks they are read in, deduplicated, title order. */
  handbooks: { id: number; title: string }[];
}) {
  if (count === 0) return null;
  const one = count === 1;
  return (
    <div
      role="note"
      className="mb-4 flex items-start gap-2.5 rounded-lg border border-slate-200 bg-surface px-4 py-3 text-sm text-slate-700 print:hidden"
    >
      <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
      <p className="min-w-0">
        <strong className="font-semibold text-slate-800">
          {one ? "1 document here is handbook only." : `${count} documents here are handbook only.`}
        </strong>{" "}
        You see {one ? "it" : "them"} because you edit this space; readers find {one ? "it" : "them"} only in{" "}
        {handbooks.map((h, i) => (
          <Fragment key={h.id}>
            {i > 0 && (i === handbooks.length - 1 ? " and " : ", ")}
            <Link href={`/handbooks/${h.id}`} className="link">
              {h.title}
            </Link>
          </Fragment>
        ))}
        .
      </p>
    </div>
  );
}
