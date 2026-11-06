"use client";

// A ticket's conversation in the desk: public messages as cards (an
// agent's reply carries the accent edge), internal notes in the amber note
// card with the "Internal note" chip (never shown to the requester), and
// system events (assignments, rules, workflow steps) as one muted line.
// Bodies are Markdown through the house MarkdownView (sanitised).

import { Lock, Paperclip, RotateCw } from "lucide-react";
import { ReviewStateChip } from "../roles/role-ui";
import { ContactHoverCard } from "@/components/helpdesk/contacts/ContactHoverCard";
import type { HdReviewState } from "@/lib/helpdesk/roles-shared";
import { chipClass } from "@/components/Chip";
import { MarkdownView } from "@/components/MarkdownView";
import { RelativeTime } from "@/components/RelativeTime";
import { initialsOf } from "@/components/UserAvatar";
import type { HdMessage } from "@/lib/helpdesk/types";
import { bytesLabel } from "../ui";

const VIA: Record<string, string> = { email: "by email", portal: "in Get help", desk: "", system: "", mcp: "via Claude", customer_portal: "in the customer portal" };

export function Conversation({
  messages,
  requesterId,
  meId,
  ticketNumber,
  origins,
}: {
  /** With it, authors' names open their contact card on hover (agent O). */
  ticketNumber?: number;
  messages: HdMessage[];
  requesterId: number | null;
  meId: number;
  /** Message id → the ticket a merge moved it from ("from #1051", 1.19.1). */
  origins?: Record<number, number>;
}) {
  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation">
      {messages.map((m) => {
        if (m.kind === "system") {
          return (
            <li key={m.id} className="flex items-start gap-2 px-1 text-xs text-slate-500">
              <RotateCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              <span className="min-w-0">
                {m.body} · <RelativeTime value={m.created_at} />
                {origins?.[m.id] && ` · from #${origins[m.id]}`}
              </span>
            </li>
          );
        }
        const internal = m.kind === "internal";
        // Desk roles: a newbie's public reply waits for a lead's review.
        const review = (m as HdMessage & { review_state?: string | null; review_note?: string | null });
        const fromAgent = !internal && m.author_id !== null && m.author_id !== requesterId;
        const mine = m.author_id === meId;
        const via = VIA[m.via] ?? "";
        return (
          <li
            key={m.id}
            className={`rounded-xl border p-4 shadow-xs ${
              internal
                ? "border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10"
                : `border-slate-200 bg-surface ${fromAgent ? "border-l-2 border-l-compass-500" : ""}`
            }`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-2xs font-bold ${
                  internal ? "bg-amber-200 text-amber-900 dark:bg-amber-500/25 dark:text-amber-200" : "bg-compass-100 text-compass-700"
                }`}
                aria-hidden
              >
                {initialsOf(m.author_name || "?")}
              </span>
              <span className="text-sm font-semibold text-slate-900">
                {mine ? (
                  "You"
                ) : !ticketNumber ? (
                  m.author_name || m.author_email
                ) : (
                  <ContactHoverCard ticket={ticketNumber} userId={m.author_id} email={m.author_email} name={m.author_name || m.author_email}>
                    {m.author_name || m.author_email}
                  </ContactHoverCard>
                )}
              </span>
              {internal && (
                <span className={chipClass("warn", "sm")}>
                  <Lock className="h-3 w-3" aria-hidden /> Internal note
                </span>
              )}
              <ReviewStateChip state={review.review_state as HdReviewState | null} />
              <span className="text-xs text-slate-500">
                <RelativeTime value={m.created_at} />
                {via && ` · ${via}`}
                {origins?.[m.id] && ` · from #${origins[m.id]}`}
              </span>
            </div>
            {review.review_state === "returned" && review.review_note && (
              <p className="mt-1 pl-9 text-xs text-slate-600">Reviewer&apos;s note: {review.review_note}</p>
            )}
            <div
              className={`mt-1.5 min-w-0 pl-9 [&_.doc-prose]:text-sm! [&_.doc-prose]:leading-relaxed! [&_.doc-prose_p]:my-1.5 ${
                internal ? "[&_.doc-prose]:text-amber-950! dark:[&_.doc-prose]:text-amber-100!" : ""
              }`}
            >
              <MarkdownView content={m.body} headingOffset={2} />
            </div>
            {m.attachments.length > 0 && (
              <ul className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2 pl-9" aria-label="Attachments">
                {m.attachments.map((a) => {
                  const href = `/api/helpdesk/attachments/${a.id}`;
                  const image = /^image\/(png|jpeg|gif|webp)$/.test(a.type);
                  return (
                    <li key={a.id}>
                      <a href={href} target="_blank" rel="noopener" className="group inline-flex flex-col gap-1 text-xs text-slate-600 hover:text-compass-700">
                        {image && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={href} alt="" loading="lazy" className="max-h-32 max-w-56 rounded-lg border border-slate-200 object-cover" />
                        )}
                        <span className="inline-flex items-center gap-1.5">
                          <Paperclip className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                          <span className="underline-offset-2 group-hover:underline">{a.name}</span>
                          <span className="text-slate-500">· {bytesLabel(a.size)}</span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
