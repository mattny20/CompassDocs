"use client";

// The ways to reach a person from their profile: save the contact card,
// scan it, chat in Teams, or put time on the calendar. Icon buttons with
// tooltips, per the style guide; the QR opens in a small popover so the
// page stays a page and not a poster.

import { useRef, useState } from "react";
import { CalendarPlus, Contact, MessageSquare, QrCode, X } from "lucide-react";
import { Popover } from "../Popover";

const btn =
  "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-compass-700";

export function ProfileActions({
  personId,
  name,
  email,
  microsoft,
  qr,
}: {
  personId: number;
  name: string;
  email: string;
  /** Synced from Microsoft 365: Teams and Outlook links make sense. */
  microsoft: boolean;
  /** Data URL of the contact-card QR, "" when it could not be made. */
  qr: string;
}) {
  const [open, setOpen] = useState(false);
  const qrBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative flex items-center gap-1.5">
      <a href={`/api/directory/${personId}/vcard`} className={btn} data-tt="Save contact (.vcf)" aria-label={`Save ${name} as a contact`}>
        <Contact className="h-4 w-4" />
      </a>
      {qr && (
        <button
          ref={qrBtnRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={btn}
          data-tt="Scan to add to your phone"
          aria-label="Show contact QR code"
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <QrCode className="h-4 w-4" />
        </button>
      )}
      {microsoft && email && (
        <>
          <a
            href={`https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}`}
            target="_blank"
            rel="noreferrer"
            className={btn}
            data-tt="Chat in Teams"
            aria-label={`Chat with ${name} in Teams`}
          >
            <MessageSquare className="h-4 w-4" />
          </a>
          <a
            href={`https://outlook.office.com/calendar/deeplink/compose?to=${encodeURIComponent(email)}&subject=${encodeURIComponent(`Meeting with ${name}`)}`}
            target="_blank"
            rel="noreferrer"
            className={btn}
            data-tt="Schedule a meeting"
            aria-label={`Schedule a meeting with ${name}`}
          >
            <CalendarPlus className="h-4 w-4" />
          </a>
        </>
      )}
      <Popover
        open={open && !!qr}
        onClose={() => setOpen(false)}
        triggerRef={qrBtnRef}
        role="dialog"
        label="Contact QR code"
        align="end"
        width="w-64"
        padding="p-3"
        className="text-center rounded-xl"
      >
        <button type="button" onClick={() => setOpen(false)} className="absolute right-2 top-2 rounded-sm p-1 text-slate-400 hover:text-slate-600" data-tt="Close" aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt={`QR code with ${name}'s contact card`} width={220} height={220} className="mx-auto rounded-md bg-white p-1" />
        <p className="mt-2 text-xs text-slate-500">Point a phone camera at it to add {name.split(" ")[0]} to your contacts.</p>
      </Popover>
    </div>
  );
}
