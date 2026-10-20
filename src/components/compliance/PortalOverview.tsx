"use client";

// Compliance › Overview (B4, 1.12.0): the programme's four tiles, as the
// one-page portal showed them above its lists, a fifth (G1) counting the
// live policies whose next re-confirmation falls within 30 days, and a
// sixth (E1, 1.13.0) counting the confirmations past their due date.

import { FileCheck, Users, CircleAlert, Percent, CalendarClock, CalendarX2 } from "lucide-react";
import { usePortal, type PortalPageProps } from "./use-portal";
import { PortalFallback } from "./PortalFallback";

export function PortalOverview({ licensed, canManageLicense = false }: PortalPageProps) {
  const portal = usePortal(licensed);
  if (!portal.data) return <PortalFallback licensed={licensed} canManageLicense={canManageLicense} portal={portal} />;
  const { kpis: k } = portal.data;

  return (
    // KPIs: a description list, so each number is the definition of its
    // label and a reader (or a test) finds "Policies requiring
    // confirmation" and its value without a class name. The label is
    // the term and comes first in the markup; the column reverses it
    // visually so the tile still reads icon, number, label. Six tiles in
    // a card-grid (STYLEGUIDE §Scaling): 11rem each, as many across as the
    // page width holds, never a viewport breakpoint. Overdue (E1) sits
    // beside Outstanding: the part of it whose due date and grace have
    // passed, over the same live policies as every other sum.
    <dl className="card-grid [--card-min:11rem] gap-3">
      {[
        { icon: <FileCheck className="h-4 w-4" />, label: "Policies requiring confirmation", value: k.policies },
        { icon: <Percent className="h-4 w-4" />, label: "Overall compliance", value: `${k.pct}%` },
        { icon: <Users className="h-4 w-4" />, label: "Fully compliant people", value: `${k.users_compliant}/${k.users_total}` },
        { icon: <CircleAlert className="h-4 w-4" />, label: "Outstanding confirmations", value: k.outstanding },
        { icon: <CalendarX2 className="h-4 w-4" />, label: "Overdue confirmations", value: k.overdue ?? 0 },
        { icon: <CalendarClock className="h-4 w-4" />, label: "Re-confirmation due in 30 days", value: k.recert_due_30 ?? 0 },
      ].map((c) => (
        <div key={c.label} className="flex flex-col rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
          <dt className="order-last text-xs text-slate-500">{c.label}</dt>
          <dd>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-compass-50 text-compass-600">
              {c.icon}
            </span>
            <span className="mt-2 block text-2xl font-bold tracking-tight text-slate-900">{c.value}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
