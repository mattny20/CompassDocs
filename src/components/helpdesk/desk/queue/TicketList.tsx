"use client";

// The queue's ticket list: one link per ticket (priority dot, number,
// status chip; subject; requester and the due), the open ticket marked
// with the accent band and aria-current. Rows are real links, so a middle
// click opens a ticket in a new tab and j / k move real focus.

import Link from "next/link";
import { Inbox } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { LoadingRow } from "@/components/Spinner";
import { SectionEmpty } from "@/components/form";
import type { HdTicketListRow } from "@/lib/helpdesk/types";
import { VipChip } from "@/components/helpdesk/contacts/VipChip";
import { AutomatedChip } from "../intake/AutomatedChip";
import { ContactHoverCard } from "@/components/helpdesk/contacts/ContactHoverCard";
import { PRIORITY_DOT, compactDue, priorityLabel, slaInk, statusChip, ticketHref } from "../ui";

export function TicketList({
  rows,
  error,
  selected,
  qs,
  onRetry,
  title,
}: {
  rows: HdTicketListRow[] | null;
  error: string;
  selected: number | null;
  qs: string;
  onRetry: () => void;
  title: string;
}) {
  if (error && !rows) {
    return (
      <div className="px-4 py-6 text-sm">
        <p className="text-red-600">{error}</p>
        <button type="button" onClick={onRetry} className="link mt-2 text-sm">
          Try again
        </button>
      </div>
    );
  }
  if (!rows) return <LoadingRow className="py-10" />;
  if (rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <Inbox className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
        <SectionEmpty className="mt-3">Nothing in {title} right now. New tickets appear here as they arrive.</SectionEmpty>
      </div>
    );
  }
  return (
    <ul aria-label={`${title} tickets`}>
      {rows.map((t) => {
        const on = t.number === selected;
        const chip = statusChip(t, true);
        // Agent L's calendars: "Paused for Christmas Day, resumes Mon 09:00".
        const clock = t.clock_note ?? null;
        const due = compactDue(t.due_label);
        // Agent O's contact cards: the requester is on the VIP list.
        const vip = t;
        return (
          <li key={t.id} className="border-b border-slate-100">
            <Link
              data-row
              href={ticketHref(t.number, qs)}
              aria-current={on ? "page" : undefined}
              className={`relative block px-4 py-3 transition outline-offset-[-2px] ${
                on ? "bg-compass-50 before:absolute before:inset-y-0 before:left-0 before:w-0.75 before:bg-compass-600" : "hover:bg-slate-50"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[t.priority]}`} aria-hidden />
                <span className="sr-only">{priorityLabel(t.priority)}, </span>
                <span className="text-xs text-slate-500">#{t.number}</span>
                {t.parent_ticket_id && <span className="text-xs text-slate-500">· Task</span>}
                <span className={chipClass(chip.tone, "sm", "ml-auto")}>{chip.label}</span>
              </span>
              <span className="mt-1 block truncate text-sm font-semibold text-slate-900">{t.subject}</span>
              <span className="mt-0.5 flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-1.5 truncate text-slate-500">
                  {vip.requester_vip && <VipChip inLink reason={vip.requester_vip_reason} />}
                  <AutomatedChip inLink ticket={t} />
                  <ContactHoverCard ticket={t.number} userId={t.requester_id} name={t.requester_name} inLink className="truncate">
                    {t.requester_name}
                  </ContactHoverCard>
                  {t.team_name && <span className="hidden sm:inline lg:hidden"> · {t.team_name}</span>}
                </span>
                {clock ? (
                  <span className="min-w-0 max-w-[55%] truncate text-slate-500" data-tt={clock}>
                    {clock}
                  </span>
                ) : (
                  due && (
                    <span className={`shrink-0 ${slaInk(t.sla_state)}`}>
                      <span className="sr-only">{t.due_label}</span>
                      <span aria-hidden>{due}</span>
                    </span>
                  )
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
