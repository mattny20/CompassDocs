"use client";

// The queue's "Major incidents" group (1.19.2, agent W1; mock-up a1): one
// house rail row per open incident whose ticket the agent works, its title
// and the open tickets linked to it (red: people are waiting). The row
// opens the incident's ticket in the current list. Nothing shows while no
// incident is open.

import Link from "next/link";
import { Siren } from "lucide-react";
import { railIconClass, railRowClass, RAIL_GROUP_TEXT } from "@/components/RailLink";
import { useOpenIncidents } from "./data";

export function IncidentsNav({ selected, qs, onPick, asMenu = false }: { selected: number | null; qs: string; onPick?: () => void; asMenu?: boolean }) {
  const list = useOpenIncidents("nav");
  if (!list?.length) return null;
  return (
    <div data-testid="incidents-nav">
      <p className={`${RAIL_GROUP_TEXT} mb-1 mt-4 px-3`}>Major incidents</p>
      {list.map((i) => {
        const on = selected === i.number;
        return (
          <Link
            key={i.id}
            href={`/desk/tickets/${i.number}${qs}`}
            onClick={onPick}
            role={asMenu ? "menuitem" : undefined}
            aria-current={on ? "page" : undefined}
            className={railRowClass(on)}
            data-tt={`#${i.number}${i.team_name ? ` · ${i.team_name}` : ""}`}
          >
            <Siren className={`h-4 w-4 ${on ? railIconClass(on) : "text-red-600 dark:text-red-400"}`} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{i.title}</span>
            <span className={`text-xs tabular-nums ${i.linked_open > 0 ? "font-semibold text-red-600 dark:text-red-400" : "text-slate-500"}`}>
              {i.linked_open}
              <span className="sr-only"> open linked tickets</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
