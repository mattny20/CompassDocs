"use client";

// A pending indicator for navigation links (STYLEGUIDE §Loading): while
// the router is fetching the next page, a small spinner appears at the
// end of the row — after a short delay, so fast navigations never flash
// it. Rendered inside a <Link>; useLinkStatus reads that link's state.

import { useLinkStatus } from "next/link";
import { LoaderCircle } from "lucide-react";

export function LinkPending({ className = "" }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <LoaderCircle
      className={`pending-in h-3.5 w-3.5 shrink-0 animate-spin text-slate-400 ${className}`.trim()}
      aria-hidden
    />
  );
}
