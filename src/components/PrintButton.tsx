"use client";

// "Print / PDF" — opens the browser's print dialog, where "Save as PDF" is
// built in on every OS. Paired with the print stylesheets (print:hidden on
// app chrome), the output is a clean document: title, byline, content.

import { Printer } from "lucide-react";

export function PrintButton({
  compact = false,
  iconOnly = false,
}: {
  compact?: boolean;
  iconOnly?: boolean;
}) {
  return (
    <button
      onClick={() => window.print()}
      title="Print or save as PDF"
      aria-label="Print or save as PDF"
      className={
        iconOnly
          ? "print:hidden inline-flex items-center rounded-lg border border-slate-200 bg-surface p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
          : compact
            ? "print:hidden inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-compass-700"
            : "print:hidden inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
      }
    >
      <Printer className="h-4 w-4" />
      {!iconOnly && "Print / PDF"}
    </button>
  );
}
