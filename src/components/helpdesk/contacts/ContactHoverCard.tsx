"use client";

// A requester's (or anyone on the ticket's) contact card on hover or focus
// of their name, in the desk's queue rows and conversation (Helpdesk
// 1.19.0). Opens after a short pause, reads the card once
// (GET /api/helpdesk/contacts/[userId]), and stays open while the pointer
// is on the name or the card. Escape, a click away and scrolling close it.
//
// The card is the house Popover, anchored in a portal at the name's place
// (position: fixed), so a scrolling queue list cannot clip it and its
// buttons never sit inside a row's link; clicks inside it stop at the
// card instead of opening the row.
//
//   <ContactHoverCard ticket={1047} userId={42} name="Ana Ruiz">Ana Ruiz</ContactHoverCard>
//   <ContactHoverCard ticket={1047} userId={null} email="ana@example.com" name="Ana Ruiz">…</ContactHoverCard>

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Popover } from "@/components/Popover";
import { SectionEmpty } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import type { HdContactCard } from "@/lib/helpdesk/contact-cards-shared";
import { ContactCard } from "./ContactCard";
import { fetchContactCard } from "./api";

const OPEN_DELAY = 350;
const CLOSE_DELAY = 200;
const PANEL_W = 320;

interface Anchor {
  top: number;
  left: number;
  width: number;
  height: number;
  side: "top" | "bottom";
  align: "start" | "end";
}

export function ContactHoverCard({
  ticket,
  userId,
  email = "",
  name,
  children,
  inLink = false,
  className = "",
}: {
  ticket: number;
  userId: number | null;
  email?: string;
  /** For the panel's accessible name. */
  name: string;
  /** The trigger: the name as the row shows it. */
  children: ReactNode;
  /** Inside a row that is one link (a queue row): hover only, no tab stop. */
  inLink?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [card, setCard] = useState<HdContactCard | null | undefined>(undefined);
  const trigger = useRef<HTMLSpanElement>(null);
  const floating = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const later = (fn: () => void, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  const keep = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const close = useCallback(() => setOpen(false), []);
  const show = () =>
    later(() => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      setAnchor({
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
        side: r.bottom > window.innerHeight * 0.6 ? "top" : "bottom",
        align: r.left + PANEL_W > window.innerWidth - 16 ? "end" : "start",
      });
      setOpen(true);
      if (card === undefined) fetchContactCard(ticket, userId, email).then(setCard).catch(() => setCard(null));
    }, OPEN_DELAY);
  const hide = () => later(close, CLOSE_DELAY);

  // The card is placed where the name was: close it when the page moves.
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && floating.current?.contains(e.target)) return;
      close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  if (!userId && !email) return <>{children}</>;

  return (
    <span
      ref={trigger}
      tabIndex={inLink ? undefined : 0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={inLink ? undefined : show}
      onBlur={inLink ? undefined : hide}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={`min-w-0 truncate rounded-sm underline decoration-slate-300 decoration-dotted underline-offset-2 ${className}`}
    >
      {children}
      {open &&
        anchor &&
        createPortal(
          <div
            ref={floating}
            className="fixed z-50"
            style={{ top: anchor.top, left: anchor.left, width: anchor.width, height: anchor.height }}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={keep}
            onMouseLeave={hide}
          >
            <Popover
              open
              onClose={close}
              triggerRef={trigger}
              role="dialog"
              label={`${name}: contact card`}
              side={anchor.side}
              align={anchor.align}
              width="w-80 max-w-[calc(100vw-2rem)]"
              padding="p-4"
              className="max-h-[70vh] overflow-y-auto whitespace-normal text-left font-normal"
            >
              {card === undefined ? (
                <LoadingRow>Loading…</LoadingRow>
              ) : card === null ? (
                <SectionEmpty>No contact card for {name}.</SectionEmpty>
              ) : (
                <ContactCard card={card} variant="popover" />
              )}
            </Popover>
          </div>,
          document.body
        )}
    </span>
  );
}
