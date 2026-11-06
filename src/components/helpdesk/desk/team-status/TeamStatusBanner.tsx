"use client";

// A team queue's status banner (1.19.2, agent W6; mock-up s3): while a
// Status page service the team follows is degraded or out, the team's
// queue opens with a notice (amber degraded, red outage): the service and
// since when, what is wrong, **Declare major incident** (for someone who
// may run incidents in the team; a link to the open major incident instead
// when one was already declared for the service) and **Hide for today** (per person, until
// the end of their day). Pop-up level "off" still shows it.

import { EyeOff, Siren } from "lucide-react";
import { Button } from "@/components/Button";
import { stateSentence } from "@/lib/helpdesk/status-teams-shared";
import { endOfToday, useClock, useTeamStatus } from "./data";
import { StatusDot } from "./StatusDot";

export function TeamStatusBanner({ teamId }: { teamId: number }) {
  const { view, mark, declare } = useTeamStatus();
  const clock = useClock();
  const banners = view?.banners.filter((b) => b.team_id === teamId) ?? [];
  if (!banners.length) return null;
  return (
    <div className="flex flex-col gap-2 border-b border-slate-200 p-2.5 print:hidden">
      {banners.map((b) => (
        <div key={b.episode_id} role="status" className={`${b.state === "outage" ? "notice-error" : "notice-warn"} flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm`}>
          <StatusDot state={b.state} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <p>
              <span className="font-semibold">
                {b.service_name} {stateSentence(b.state)}
              </span>{" "}
              since {clock(b.started_at)}
            </p>
            {b.detail && <p className="mt-0.5 opacity-85">{b.detail}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {b.incident ? (
                <Button size="sm" variant="secondary" icon={<Siren />} href={`/desk/tickets/${b.incident.number}`}>
                  Major incident #{b.incident.number}
                </Button>
              ) : (
                b.can_declare && (
                  <Button size="sm" variant="secondary" icon={<Siren />} onClick={() => declare(b.service_id, b.team_id)}>
                    Declare major incident
                  </Button>
                )
              )}
              <Button size="sm" variant="secondary" icon={<EyeOff />} onClick={() => mark("hide_banner", { episode_id: b.episode_id, until: endOfToday() })}>
                Hide for today
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
