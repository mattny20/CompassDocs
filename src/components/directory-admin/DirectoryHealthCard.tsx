"use client";

// The directory's to-do list: what the data says is missing, stray, doubled
// or unresolved, each with a count and a way to the fix. All clear reads as
// one quiet line, not an empty card.

import Link from "next/link";
import { useState } from "react";
import { HeartPulse, AlertTriangle, Info, ChevronDown, ChevronRight, CheckCircle2 } from "lucide-react";
import type { HealthFinding } from "@/lib/directory-health";

export function DirectoryHealthCard({ findings }: { findings: HealthFinding[] }) {
  const [open, setOpen] = useState(true);
  const warns = findings.filter((f) => f.severity === "warn").length;
  if (findings.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden /> Directory health: nothing to fix — every visible person has an office, a title and a phone, every value matches an option, and no names are shared.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-surface shadow-xs">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <HeartPulse className="h-4 w-4 text-compass-600" aria-hidden />
        <span className="text-sm font-semibold text-slate-800">Directory health</span>
        <span className="text-xs text-slate-500">
          {warns ? `${warns} to fix` : "nothing urgent"}{findings.length - warns ? ` · ${findings.length - warns} worth knowing` : ""}
        </span>
        <span className="ml-auto text-slate-500">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>
      {open && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {findings.map((f) => (
            <li key={f.id} className="flex items-start gap-3 px-4 py-2.5">
              {f.severity === "warn" ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800">
                  {f.title}
                  {f.samples?.length ? <span className="ml-2 text-xs font-normal text-slate-500" data-tt={f.samples.join(" · ")}>e.g. {f.samples.slice(0, 3).join(", ")}{f.samples.length > 3 ? ", …" : ""}</span> : null}
                </p>
                <p className="text-xs text-slate-500">{f.detail}</p>
              </div>
              {f.href && (
                <Link href={f.href} className="shrink-0 text-xs font-medium text-compass-600 hover:underline">
                  {f.href.startsWith("/admin/directory/fields") ? "Fields" : f.href.startsWith("/admin/directory/sync") ? "Sync" : "Show"}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
