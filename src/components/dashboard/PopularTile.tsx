// Popular this week (1.17.0): the five most-read documents of the last seven
// days among those the person can read, ranked, with their space and view
// count. Left out when nothing was read this week. Server component;
// fetches its own data.

import Link from "next/link";
import { DashboardTile } from "./DashboardTile";
import { listPopularThisWeek } from "@/lib/dashboard-data";
import type { SpaceScope } from "@/lib/space-scope";

export async function PopularTile({ scope, includeDrafts }: { scope: SpaceScope; includeDrafts: boolean }) {
  const docs = await listPopularThisWeek(scope, includeDrafts, 5);
  if (docs.length === 0) return null;

  return (
    <DashboardTile
      id="popular"
      title="Popular this week"
      actions={<span className="text-slate-500">Most read in your spaces</span>}
      flush
      // The last row's hover band follows the rounded corners.
      className="overflow-hidden"
    >
      <ol className="pb-1">
        {docs.map((d, i) => (
          <li key={d.id} className="border-t border-slate-100 first:border-t-0">
            <Link
              href={`/doc/${d.id}`}
              className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50/70"
            >
              <span className="w-5 shrink-0 text-center text-sm font-bold tabular-nums text-slate-500" aria-hidden>
                {i + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5">
                <span className="max-w-full truncate text-sm font-semibold text-slate-900 group-hover:text-compass-700">
                  {d.title}
                </span>
                <span className="truncate text-xs text-slate-500">
                  <span aria-hidden>{d.space_icon}</span> {d.space_name}
                </span>
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-slate-500">
                {d.views} {d.views === 1 ? "view" : "views"}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </DashboardTile>
  );
}
