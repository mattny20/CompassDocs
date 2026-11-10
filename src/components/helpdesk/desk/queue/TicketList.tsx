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
import { OutsideCustomerChip } from "../OutsideCustomerChip";
import { ContactHoverCard } from "@/components/helpdesk/contacts/ContactHoverCard";
import { PRIORITY_DOT, compactDue, priorityLabel, slaInk, statusChip, ticketHref } from "../ui";
import type { RowSelection } from "../merge/selection";
import { IncidentChip } from "../incidents/IncidentChip";
import { useDeskMailboxes } from "../mailboxes";

export function TicketList({
  rows,
  error,
  selected,
  qs,
  onRetry,
  title,
  selection,
}: {
  rows: HdTicketListRow[] | null;
  error: string;
  selected: number | null;
  qs: string;
  onRetry: () => void;
  title: string;
  /** Row checkboxes for the bulk bar (1.19.1, merge/selection); omitted without tickets.bulk or tickets.merge. */
  selection?: RowSelection;
}) {
  // 1.20.2: the address a ticket came in on, beside its requester, while more than one is listed.
  const showAddress = useDeskMailboxes().length > 1;
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
          <li key={t.id} className="relative border-b border-slate-100" data-number={t.number}>
            {selection && <RowCheck t={t} selection={selection} />}
            <Link
              data-row
              href={ticketHref(t.number, qs)}
              aria-current={on ? "page" : undefined}
              className={`relative block px-4 py-3 transition outline-offset-[-2px] ${selection ? "pl-11" : ""} ${
                on
                  ? "bg-compass-50 before:absolute before:inset-y-0 before:left-0 before:w-0.75 before:bg-compass-600"
                  : selection?.has(t.number)
                    ? "bg-compass-50/60 hover:bg-compass-50"
                    : "hover:bg-slate-50"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[t.priority]}`} aria-hidden />
                <span className="sr-only">{priorityLabel(t.priority)}, </span>
                <span className="text-xs text-slate-500">#{t.number}</span>
                {t.parent_ticket_id && <span className="text-xs text-slate-500">· Task</span>}
                <IncidentChip chip={t.incident} />
                <span className={chipClass(chip.tone, "sm", "ml-auto")}>{chip.label}</span>
              </span>
              <span className="mt-1 block truncate text-sm font-semibold text-slate-900">{t.subject}</span>
              <span className="mt-0.5 flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-1.5 truncate text-slate-500">
                  {vip.requester_vip && <VipChip inLink reason={vip.requester_vip_reason} />}
                  <AutomatedChip inLink ticket={t} />
                  <OutsideCustomerChip inLink ticket={t} />
                  <ContactHoverCard ticket={t.number} userId={t.requester_id} name={t.requester_name} inLink className="truncate">
                    {t.requester_name}
                  </ContactHoverCard>
                  {t.team_name && <span className="hidden sm:inline lg:hidden"> · {t.team_name}</span>}
                  {showAddress && t.mailbox_address && (
                    <span className="min-w-0 truncate" data-testid="ticket-address">
                      <span aria-hidden>· </span>
                      <span className="sr-only">, to </span>
                      {t.mailbox_address}
                    </span>
                  )}
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

/** A row's checkbox, beside (not inside) its link: a click selects, shift-click selects the range. */
function RowCheck({ t, selection }: { t: HdTicketListRow; selection: RowSelection }) {
  return (
    <input
      type="checkbox"
      checked={selection.has(t.number)}
      onChange={() => {}}
      onClick={(e) => selection.toggle(t.number, e.shiftKey)}
      aria-label={`Select #${t.number} ${t.subject}`}
      className="absolute left-4 top-[2.15rem] z-10 h-4 w-4 cursor-pointer accent-compass-600 print:hidden"
    />
  );
}
