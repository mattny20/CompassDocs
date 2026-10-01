// The one spinner and the one loading row (STYLEGUIDE §Loading). Five
// loader recipes (two CSS rings, three lucide sizes, a pulse dot) used to
// mean "working"; now one glyph in three sizes, announced to readers, and
// exempt from reduced motion (a frozen spinner reads as a hang).
// Server-safe.

import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

const SIZE = { sm: "h-3.5 w-3.5", md: "h-4 w-4", lg: "h-8 w-8" } as const;

export function Spinner({
  size = "md",
  className = "",
  label,
}: {
  size?: keyof typeof SIZE;
  className?: string;
  /** Spoken label; omit inside a control that already has text ("Saving…"). */
  label?: string;
}) {
  return (
    <>
      <LoaderCircle className={`shrink-0 animate-spin ${SIZE[size]} ${className}`.trim()} aria-hidden />
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

/** A list or table that is still loading: centred, announced once. */
export function LoadingRow({
  children = "Loading…",
  className = "py-6",
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={`flex items-center justify-center gap-2 text-sm text-slate-500 ${className}`}>
      <Spinner />
      <span>{children}</span>
    </div>
  );
}

/** Classes for a region that is refreshing: dims, stays readable, and
 *  carries aria-busy for readers. Put `aria-busy={busy}` on the same
 *  element. */
export function busyClass(busy: boolean): string {
  return busy ? "pointer-events-none opacity-60 transition-opacity" : "transition-opacity";
}
