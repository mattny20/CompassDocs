// The dashboard's Team compliance tile (1.17.0, key "compliance"): for a
// manager — someone whose directory entry has direct reports with accounts —
// how many of those reports have confirmed each policy that asks them, the
// three with the smallest share confirmed first. The bar is emerald when
// everyone has, the accent from 60%, amber below. Who is still to confirm is
// the count's tooltip; "See who's outstanding" opens the team view when the
// viewer may open it. Only with Read confirmation licensed and policy
// standing open to leads (lib/dashboard-people); hidden otherwise.

import Link from "next/link";
import type { SessionUser } from "@/lib/types";
import { getTeamCompliance } from "@/lib/dashboard-people";
import { DashboardTile } from "./DashboardTile";

function barTone(pct: number): string {
  return pct >= 100 ? "bg-emerald-500" : pct >= 60 ? "bg-compass-600" : "bg-amber-500";
}

/** "Still to confirm: Tom Becker, Aisha Rahman" — at most five names. */
function outstandingSentence(names: string[]): string {
  if (!names.length) return "Everyone has confirmed";
  const shown = names.slice(0, 5).join(", ");
  return `Still to confirm: ${shown}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`;
}

export async function TeamComplianceTile({ user }: { user: SessionUser }) {
  const data = await getTeamCompliance(user);
  if (!data) return null;
  return (
    <DashboardTile
      id="compliance"
      title="Team compliance"
      actions={
        <span className="text-xs text-slate-500">
          Your {data.reports} {data.reports === 1 ? "report" : "reports"}
        </span>
      }
      footer={
        data.teamView ? (
          <Link href="/compliance/team" className="font-medium text-compass-700 hover:underline">
            See who&apos;s outstanding
          </Link>
        ) : undefined
      }
    >
      <ul className="pb-1">
        {data.policies.map((p) => {
          const pct = Math.round((p.confirmed / Math.max(p.owed, 1)) * 100);
          return (
            <li key={p.document_id} className="px-2 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Link
                  href={`/doc/${p.document_id}`}
                  className="min-w-0 truncate text-sm font-semibold text-slate-800 hover:text-compass-700"
                >
                  {p.title}
                </Link>
                <span
                  tabIndex={0}
                  data-tt={outstandingSentence(p.outstanding)}
                  className="shrink-0 text-xs text-slate-500"
                >
                  {p.confirmed} of {p.owed}
                  <span className="sr-only"> confirmed. {outstandingSentence(p.outstanding)}</span>
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                <div className={`h-full rounded-full ${barTone(pct)}`} style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </DashboardTile>
  );
}
