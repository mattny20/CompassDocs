"use client";

// /desk/recycle-bin/[number] (1.19.4, area C7; mock-up v3): the bin as the
// queue's list column ("#1038 · 30 days left", the subject, "Deleted by Ana
// Kowalski · Today, 14:02") beside the binned ticket's read-only pane. Under
// lg the list folds away and the pane links back to the bin, as the queue
// does with its tickets.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { binDaysLeftLabel, binWhenLabel, type HdBinRow } from "@/lib/helpdesk/recycle-bin-shared";
import { getJson } from "../api";
import { BIN_CHANGED } from "./actions";
import { BinnedTicketPane } from "./BinnedTicketPane";

export function RecycleBinSplit({ number }: { number: number }) {
  const [rows, setRows] = useState<HdBinRow[] | null>(null);
  const [total, setTotal] = useState(0);

  const load = useCallback(() => {
    getJson<{ rows: HdBinRow[]; total: number }>("/api/helpdesk/recycle-bin", "Couldn't load the recycle bin.")
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch(() => setRows([]));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(BIN_CHANGED, load);
    return () => window.removeEventListener(BIN_CHANGED, load);
  }, [load]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section aria-labelledby="bin-list-title" className="hidden min-h-0 w-[23rem] shrink-0 flex-col border-r border-slate-200 bg-surface lg:flex">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 px-3">
          <h2 id="bin-list-title" className="flex items-baseline gap-2 text-base font-semibold text-slate-900">
            <Link href="/desk/recycle-bin" className="hover:underline">
              Recycle bin
            </Link>
            <span className="text-xs font-normal text-slate-500">
              {total}
              <span className="sr-only"> deleted tickets</span>
            </span>
          </h2>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Deleted tickets">
          {(rows ?? []).map((r) => {
            const on = r.number === number;
            return (
              <li key={r.number} className="border-b border-slate-100">
                <Link
                  href={`/desk/recycle-bin/${r.number}`}
                  aria-current={on ? "page" : undefined}
                  className={`block px-4 py-3 transition-colors ${on ? "bg-compass-50" : "hover:bg-slate-50"}`}
                >
                  <span className="flex gap-2 text-xs text-slate-500">
                    <span className="tabular-nums">#{r.number}</span>
                    <span className="ml-auto">{r.legal_hold ? "On hold" : `${binDaysLeftLabel(r.days_left)} left`}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-sm font-medium text-slate-800">{r.subject}</span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    Deleted by {r.deleted_by_name} · {binWhenLabel(r.deleted_at)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
      <BinnedTicketPane number={number} back={{ href: "/desk/recycle-bin", label: "Recycle bin" }} />
    </div>
  );
}
