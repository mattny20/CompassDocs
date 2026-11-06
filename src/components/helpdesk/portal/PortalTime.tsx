"use client";

// A date in the reader's own time zone ("4 Nov, 09:12"); the server render
// may differ by zone, so only the text is allowed to change on hydration.

import { portalDate } from "./client";

export function PortalTime({ value, className = "" }: { value: string; className?: string }) {
  return (
    <time dateTime={value} suppressHydrationWarning className={className}>
      {portalDate(value)}
    </time>
  );
}
