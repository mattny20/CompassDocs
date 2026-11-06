"use client";

// On a kept portal request: "Your request #N was joined with this one…"
// (Helpdesk 1.19.2, mock e3), one card per request of the contact's that an
// agent merged into it. The merged request itself says "Joined with #N".
// The day reads in the customer's own time zone ("Earlier today",
// "Yesterday", else the date).

import { portalDate } from "./client";

function dayLabel(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return "Earlier today";
  if (d.getTime() >= start - 86_400_000) return "Yesterday";
  return portalDate(value);
}

export function PortalJoinedNotice({ number, at }: { number: number; at: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-surface px-4 py-3.5 text-sm shadow-xs">
      <p className="text-xs text-slate-500">
        <time dateTime={at} suppressHydrationWarning>
          {dayLabel(at)}
        </time>
      </p>
      <p className="mt-1 text-slate-800">
        Your request #{number} was joined with this one, because it was about the same problem. Replies to either go here.
      </p>
    </div>
  );
}
