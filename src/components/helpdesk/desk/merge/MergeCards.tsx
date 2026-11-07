"use client";

// Where a merge shows on a ticket (1.19.1, agent V2; mock-up #3's Related
// card). The kept ticket's side column lists "Merged in: #1051, #1052";
// a merged ticket says "Merged into #1049" in the same card and in a
// notice above its conversation, each a link to the other ticket in the
// same queue view.

import Link from "next/link";
import { ArrowUpRight, GitMerge, Lock } from "lucide-react";
import { Button } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { EYEBROW_TEXT } from "@/components/Heading";
import type { HdTicketDetail } from "@/lib/helpdesk/types";
import { useQueue } from "../queue/QueueLayout";

export function RelatedCard({ d }: { d: HdTicketDetail }) {
  const { qs } = useQueue();
  const m = d.merge;
  if (!m || (!m.into && m.merged_in.length === 0)) return null;
  return (
    <section aria-labelledby="related-h" className={`${CARD_CLASS} p-4`}>
      <h3 id="related-h" className={EYEBROW_TEXT}>
        Related
      </h3>
      <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
        {m.into && (
          <li className="flex items-start gap-1.5">
            <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
            <span>
              Merged into{" "}
              {/* 1.19.4: a kept ticket in the recycle bin is never named. */}
              {m.into.deleted ? (
                "a deleted ticket"
              ) : (
                <Link href={`/desk/tickets/${m.into.number}${qs}`} className="link" data-tt={m.into.subject}>
                  #{m.into.number}
                </Link>
              )}
            </span>
          </li>
        )}
        {m.merged_in.length > 0 && (
          <li className="flex items-start gap-1.5">
            <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
            <span>
              Merged in:{" "}
              {m.merged_in.map((x, i) => (
                <span key={x.number}>
                  {i > 0 && ", "}
                  <Link href={`/desk/tickets/${x.number}${qs}`} className="link" data-tt={x.subject}>
                    #{x.number}
                  </Link>
                </span>
              ))}
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}

/** Above a merged ticket's conversation: where it went. */
export function MergedNotice({ d }: { d: HdTicketDetail }) {
  const { qs } = useQueue();
  const into = d.merge?.into;
  if (!into) return null;
  return (
    <p className="flex items-start gap-2 rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2 text-sm text-slate-700">
      <GitMerge className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
      <span>
        Merged into{" "}
        {into.deleted ? (
          <>a ticket that has since been deleted. Its messages and people moved there.</>
        ) : (
          <>
            <Link href={`/desk/tickets/${into.number}${qs}`} className="link font-medium">
              #{into.number} {into.subject}
            </Link>
            . Its messages and people moved there; reply on #{into.number}.
          </>
        )}
      </span>
    </p>
  );
}

/**
 * In place of a merged ticket's composer (1.19.1 integration): the ticket
 * is read-only (the server refuses replies, notes and status changes on
 * it), so a neutral read-only strip links to the ticket it went into.
 */
export function MergedComposerLock({ d }: { d: HdTicketDetail }) {
  const { qs } = useQueue();
  const raw = d.merge?.into;
  const into = raw && !raw.deleted ? raw : null;
  return (
    <div
      data-testid="merged-composer-lock"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 print:hidden"
    >
      <Lock className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
      <span className="min-w-0 flex-1">
        <b className="font-semibold">Read-only</b> · This ticket was merged
        {into ? ` into #${into.number}` : raw?.deleted ? " into a ticket that has since been deleted" : " into another ticket"}.{raw?.deleted ? "" : " Reply and change its status there."}
      </span>
      {into && (
        <Button variant="secondary" size="sm" icon={<ArrowUpRight />} href={`/desk/tickets/${into.number}${qs}`}>
          Open #{into.number}
        </Button>
      )}
    </div>
  );
}
