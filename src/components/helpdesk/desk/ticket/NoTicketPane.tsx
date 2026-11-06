"use client";

// The ticket pane before a ticket is open: what to do, and the desk's
// keys while single-key shortcuts are on. Carries the page's h1 (sr-only:
// the queue's own titles are the visible headings).

import { MousePointerClick } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Kbd } from "@/components/palette/Kbd";
import { useSingleKeyOn } from "../hotkeys";

const KEYS: [string, string][] = [
  ["j", "Next ticket"],
  ["k", "Previous ticket"],
  ["Enter", "Open it"],
  ["r", "Reply"],
  ["n", "Internal note"],
  ["e", "Solve"],
  ["a", "Assign to me"],
  ["/", "Search"],
];

export function NoTicketPane() {
  const keys = useSingleKeyOn();
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto p-8">
      <PageHeader className="sr-only" title="Tickets" />
      <div className="max-w-sm text-center">
        <MousePointerClick className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
        <p className="mt-3 text-base font-semibold text-slate-800">Pick a ticket from the list</p>
        <p className="mt-1 text-sm text-slate-500">It opens here, with the list still beside it.</p>
        {keys && (
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 text-left text-sm">
            {KEYS.map(([k, label]) => (
              <div key={k} className="flex items-center gap-2">
                <dt>
                  <Kbd keys={[k]} />
                </dt>
                <dd className="text-slate-600">{label}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
