"use client";

// The one pager (STYLEGUIDE §Tables): "Showing 1–50 of 4,333" with
// Previous / Next, rendered above and below a long table so neither end
// of the page is a dead end. Zero-based `page`; the caller fetches.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { buttonClass } from "./Button";

export function Pager({
  page,
  limit,
  total,
  onPage,
  busy = false,
  className = "",
}: {
  page: number;
  limit: number;
  total: number;
  onPage: (next: number) => void;
  busy?: boolean;
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : page * limit + 1;
  const to = Math.min(total, (page + 1) * limit);
  const fmt = (n: number) => n.toLocaleString();
  return (
    <nav aria-label="Pages" className={`flex flex-wrap items-center justify-between gap-3 ${className}`.trim()}>
      <p className="text-sm tabular-nums text-slate-500" aria-live="polite">
        {total === 0 ? "Nothing to show" : `Showing ${fmt(from)}–${fmt(to)} of ${fmt(total)}`}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page <= 0 || busy}
          className={buttonClass("secondary", "sm")}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Previous
        </button>
        <span className="px-1 text-xs tabular-nums text-slate-500">
          {page + 1} / {pages}
        </span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= pages - 1 || busy}
          className={buttonClass("secondary", "sm")}
        >
          Next <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </nav>
  );
}
