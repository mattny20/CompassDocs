// Spaces (1.17.0): the eight most recently active spaces the person can read,
// in two columns of rows (icon tile, name, "N documents · updated X ago").
// "New space" sits on the title row for people who may create one; the rest
// of the spaces are one click away in the sidebar. Server component;
// fetches its own data.

import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { DashboardTile } from "./DashboardTile";
import { listSpaces } from "@/lib/db";
import type { SpaceScope } from "@/lib/space-scope";
import { SectionEmpty } from "@/components/form";
import { timeAgo } from "@/lib/ui";

const SHOWN = 8;

export async function SpacesTile({ scope, canCreate }: { scope: SpaceScope; canCreate: boolean }) {
  const spaces = await listSpaces(scope);
  const active = [...spaces]
    .sort((a, b) => (b.last_activity ?? "").localeCompare(a.last_activity ?? "") || a.name.localeCompare(b.name))
    .slice(0, SHOWN);
  const more = spaces.length - active.length;

  return (
    <DashboardTile
      id="spaces"
      title="Spaces"
      flush
      className="overflow-hidden"
      actions={
        canCreate ? (
          <Link
            href="/admin/spaces"
            className="inline-flex items-center gap-1 font-medium text-compass-700 hover:text-compass-800"
          >
            <Plus className="h-4 w-4" aria-hidden />
            New space
          </Link>
        ) : undefined
      }
      footer={more > 0 ? <span className="text-xs text-slate-500">{more} more in the sidebar</span> : undefined}
    >
      {active.length === 0 ? (
        <SectionEmpty className="px-4 pb-4">No spaces yet.</SectionEmpty>
      ) : (
        // Two columns once the tile is wide enough for two names side by
        // side; the hairlines come from each row, so an odd count leaves
        // no stray border.
        <div className="@container">
          <ul className="grid grid-cols-1 border-t border-slate-100 @md:grid-cols-2">
            {active.map((s) => (
              <li key={s.id} className="border-b border-slate-100 last:border-b-0 @md:odd:border-r @md:odd:last:border-r-0 @md:[&:nth-last-child(2):nth-child(odd)]:border-b-0">
                <Link
                  href={`/spaces/${s.slug}`}
                  className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50/70"
                >
                  <span
                    className="grid h-8.5 w-8.5 shrink-0 place-items-center rounded-lg text-lg"
                    style={{ backgroundColor: `${s.color}1a` }}
                    aria-hidden
                  >
                    {s.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900 group-hover:text-compass-700">
                      {s.name}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {s.doc_count} {s.doc_count === 1 ? "document" : "documents"}
                      {s.last_activity ? ` · updated ${timeAgo(s.last_activity)}` : ""}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 group-hover:text-compass-500" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DashboardTile>
  );
}
