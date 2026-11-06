"use client";

// The desk top bar's status pill (1.19.2, agent W6; mock-up s1). While a
// Status page service one of the agent's teams follows is degraded or out,
// a notice-coloured pill says "N services affected"; otherwise a quiet
// icon button with a green dot. Either opens a popover listing the
// services the agent's teams follow (the union, never every service), each
// with its state, when they were last checked, a link to the Status page
// and where the services are chosen. Hidden when the agent's teams follow
// nothing and the agent can't choose for any of them.

import { useRef, useState } from "react";
import Link from "next/link";
import { Activity, ChevronDown, ExternalLink } from "lucide-react";
import { Popover } from "@/components/Popover";
import { chipClass } from "@/components/Chip";
import { iconButtonClass } from "@/components/Button";
import { SectionEmpty } from "@/components/form";
import { timeAgo } from "@/lib/ui";
import { isAffected, stateLabel, stateTone } from "@/lib/helpdesk/status-teams-shared";
import { useTeamStatus } from "./data";
import { StatusDot } from "./StatusDot";
import { TeamStatusDialog } from "./TeamStatusServices";

export function StatusPill() {
  const { view, pillOpen, setPillOpen, refresh } = useTeamStatus();
  const btn = useRef<HTMLButtonElement>(null);
  const [choose, setChoose] = useState(false);
  if (!view) return null;
  const manageable = view.teams.filter((t) => t.can_manage);
  if (!view.services.length && !manageable.length) return null;

  const affected = view.services.filter((s) => isAffected(s.status));
  const worst = affected.some((s) => s.status === "outage") ? "outage" : affected.length ? "degraded" : "operational";
  const label = affected.length ? `${affected.length} ${affected.length === 1 ? "service" : "services"} affected` : "All services operational";
  const teamNames = view.teams.filter((t) => view.services.some((s) => s.team_ids.includes(t.id))).map((t) => t.name);

  return (
    <div className="relative">
      {affected.length ? (
        <button
          ref={btn}
          type="button"
          onClick={() => setPillOpen(!pillOpen)}
          aria-expanded={pillOpen}
          aria-haspopup="dialog"
          aria-label={`${label}. Show your teams' services`}
          className={`${worst === "outage" ? "notice-error" : "notice-warn"} inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-sm font-medium transition hover:brightness-95`}
        >
          <StatusDot state={worst} />
          <span className="sm:hidden">{affected.length}</span>
          <span className="hidden sm:inline">{label}</span>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : (
        <button
          ref={btn}
          type="button"
          onClick={() => setPillOpen(!pillOpen)}
          aria-expanded={pillOpen}
          aria-haspopup="dialog"
          aria-label="Service status: all your teams' services are operational"
          data-tt="Service status"
          data-tt-pos="bottom"
          className={iconButtonClass("quiet", "md", "relative")}
        >
          <Activity aria-hidden />
          {view.services.length > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-surface" aria-hidden />}
        </button>
      )}
      <Popover
        open={pillOpen}
        onClose={() => setPillOpen(false)}
        triggerRef={btn}
        role="dialog"
        label="Your teams' services"
        align="end"
        width="w-[min(24rem,calc(100vw-1rem))]"
        padding="p-0"
        className="mt-2 overflow-hidden rounded-xl"
      >
        <div className="border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-semibold text-slate-900">{teamNames.length ? `Services for ${teamNames.join(", ")}` : "Services for your teams"}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            From the Status page{view.checked_at ? ` · checked ${timeAgo(view.checked_at)}` : ""}
          </p>
        </div>
        {view.services.length === 0 ? (
          <SectionEmpty className="px-4 py-5">Your teams don&apos;t follow any Status page services yet.</SectionEmpty>
        ) : (
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto" aria-label="Services">
            {view.services.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <StatusDot state={s.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900">{s.name}</span>
                  <span className="block truncate text-xs text-slate-500">{s.detail || (s.status === "operational" ? "All systems normal" : stateLabel(s.status))}</span>
                </span>
                <span className={chipClass(stateTone(s.status), "sm", "shrink-0")}>{stateLabel(s.status)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-slate-100 px-4 py-2 text-xs">
          {view.manage_all ? (
            <Link href="/desk/settings/teams" onClick={() => setPillOpen(false)} className="text-slate-500 hover:text-slate-700">
              Choose services in Desk settings → Teams
            </Link>
          ) : manageable.length ? (
            <button
              type="button"
              onClick={() => {
                setPillOpen(false);
                setChoose(true);
              }}
              className="text-slate-500 hover:text-slate-700"
            >
              Choose services for {manageable.length === 1 ? manageable[0].name : "your teams"}
            </button>
          ) : (
            <span className="text-slate-500">Your team lead chooses these services.</span>
          )}
          <a href="/status" target="_blank" rel="noopener" className="inline-flex items-center gap-1 font-medium text-compass-600 hover:text-compass-700">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Status page
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </Popover>
      {manageable.length > 0 && !view.manage_all && (
        <TeamStatusDialog
          open={choose}
          onClose={() => setChoose(false)}
          teams={manageable}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
