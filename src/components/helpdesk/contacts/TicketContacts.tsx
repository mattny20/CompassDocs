"use client";

// The people on a ticket, for the desk's side panel (Helpdesk 1.19.0): the
// requester's full contact card first, then everyone else on the ticket
// (contacts who wrote in, approvers, people named in the form) as compact
// rows that expand to their card. One request: GET /api/helpdesk/contacts.
//
//   <TicketContacts ticket={1047} onReply={focusComposer} />
//
// 1.20.3: on the desk's ticket the requester is the strip under the header
// (desk/ticket/RequesterStrip), so the side panel passes `requester={false}`
// and gets only "Also on this ticket"; the strip owns the loading and error
// states. A ticket with no requester keeps everyone in that list.

import { useState } from "react";
import { ChevronDown, ChevronUp, Contact } from "lucide-react";
import { buttonClass, iconButtonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { Eyebrow } from "@/components/Heading";
import { LoadingRow } from "@/components/Spinner";
import { ContactCard } from "./ContactCard";
import { useTicketContacts } from "./api";

export function TicketContacts({
  ticket,
  onReply,
  refreshKey,
  requester = true,
  className = "",
}: {
  /** The ticket's display number (#1047). */
  ticket: number;
  /** "Reply in ticket" beside the requester's email: focus the composer. */
  onReply?: () => void;
  /** Change it to read the cards again (after a new message, say). */
  refreshKey?: unknown;
  /** false: without the requester's card (the desk shows it as the requester strip). */
  requester?: boolean;
  className?: string;
}) {
  const { data, error } = useTicketContacts(ticket, refreshKey);
  const [open, setOpen] = useState<Set<string>>(new Set());

  if (!requester && !data) return null;
  if (error && !data) {
    return (
      <section aria-label="Requester" className={`${CARD_CLASS} p-4 text-sm text-slate-500 ${className}`}>
        {error}
      </section>
    );
  }
  if (data === undefined) {
    return (
      <section aria-label="Requester" className={`${CARD_CLASS} p-4 ${className}`}>
        <LoadingRow>Loading the contact card…</LoadingRow>
      </section>
    );
  }
  if (!data || data.contacts.length === 0) return null;
  // Without the requester: drop the first card only when it is theirs (a ticket with no requester keeps everyone).
  const lead = requester || data.contacts[0].relation === "requester" ? data.contacts[0] : null;
  const first = requester ? data.contacts[0] : null;
  const rest = lead ? data.contacts.slice(1) : data.contacts;
  if (!first && rest.length === 0) return null;
  const toggle = (k: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const keyOf = (c: (typeof data.contacts)[number], i: number) => (c.user_id ? `u${c.user_id}` : `e${c.email || i}`);

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {first && (
        <section aria-labelledby="hd-contact-requester" className={`${CARD_CLASS} p-4`}>
          <Eyebrow as="h2" icon={<Contact />} className="mb-3">
            <span id="hd-contact-requester">{first.relation_label}</span>
          </Eyebrow>
          <ContactCard card={first} variant="panel" onReply={first.relation === "requester" ? onReply : undefined} />
        </section>
      )}

      {rest.length > 0 && (
        <section aria-labelledby="hd-contact-others" className={`${CARD_CLASS} px-4 py-3`}>
          <Eyebrow as="h2" className="mb-1 py-1">
            <span id="hd-contact-others">
              Also on this ticket <span className="tabular-nums">({rest.length})</span>
            </span>
          </Eyebrow>
          <ul className="divide-y divide-slate-100">
            {rest.map((c, i) => {
              const k = keyOf(c, i);
              const expanded = open.has(k);
              const panelId = `hd-contact-${k}`;
              return (
                <li key={k} className="py-2">
                  {expanded ? (
                    <div id={panelId}>
                      <ContactCard card={c} variant="panel" className="py-1" />
                      <button type="button" className={`${buttonClass("ghost", "sm")} mt-2 print:hidden`} aria-expanded aria-controls={panelId} onClick={() => toggle(k)}>
                        <ChevronUp className="h-3.5 w-3.5" aria-hidden /> Show less
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <ContactCard card={c} variant="compact" actions={false} className="flex-1" />
                      <button
                        type="button"
                        className={`${iconButtonClass("quiet", "sm")} print:hidden`}
                        aria-expanded={false}
                        data-tt="More"
                        aria-label={`Show ${c.name}'s contact card`}
                        onClick={() => toggle(k)}
                      >
                        <ChevronDown />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
