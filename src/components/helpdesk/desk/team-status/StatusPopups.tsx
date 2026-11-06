"use client";

// The desk's status pop-ups (1.19.2, agent W6; mock-up s1): cards at the
// bottom right, under the toasts, while the desk is open.
//
//   down       a service one of the agent's teams follows reached the
//              team's pop-up level: what is wrong, since when, how many of
//              the team's new tickets mention it, **Declare major incident**
//              (only for someone who may run incidents in that team, and
//              a link to the major incident instead when one is already
//              open for the service) and
//              **View details** (the top bar's popover). Once per person
//              per episode; dismissing is remembered.
//   recovered  the same service is operational again (for those who saw
//              the pop-up), until dismissed.
//   ask        a major incident declared from a service that recovered
//              (operational or in maintenance), for the people asked who
//              can still run it: **Solve incident and linked tickets** (W1's
//              solve, each ticket checked as if solved by hand) or Not now.
//              Nothing is solved without this click.

import { useState } from "react";
import { CircleAlert, CircleCheck, Siren, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { toast } from "@/components/Toasts";
import { stateSentence, type TeamStatusAsk, type TeamStatusPopup } from "@/lib/helpdesk/status-teams-shared";
import { listTicketNumbers, type IncidentTicketResult } from "@/lib/helpdesk/incidents-shared";
import { sendJson } from "../api";
import { incidentsChanged } from "../incidents/data";
import { useTeamStatus, useClock } from "./data";

const CARD = "pointer-events-auto rounded-xl border bg-surface px-4 py-3 text-sm shadow-modal";

export function StatusPopups() {
  const { view } = useTeamStatus();
  if (!view || (!view.popups.length && !view.asks.length)) return null;
  // At most three at once: the asks first (someone is waiting on them), then the newest.
  const asks = view.asks.slice(0, 2);
  const popups = view.popups.slice(0, Math.max(0, 3 - asks.length));
  return (
    <section aria-label="Service status alerts" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(25rem,calc(100vw-2rem))] flex-col gap-2 print:hidden">
      {asks.map((a) => (
        <AskCard key={`a${a.incident_id}`} ask={a} />
      ))}
      {popups.map((p) => (p.kind === "down" ? <DownCard key={`d${p.episode_id}`} p={p} /> : <RecoveredCard key={`r${p.episode_id}`} p={p} />))}
    </section>
  );
}

function Dismiss({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} data-tt="Dismiss" className={iconButtonClass("quiet", "sm", "-mr-1.5 -mt-1")}>
      <X aria-hidden />
    </button>
  );
}

function DownCard({ p }: { p: TeamStatusPopup }) {
  const { mark, declare, setPillOpen } = useTeamStatus();
  const clock = useClock();
  const out = p.state === "outage";
  const detail = p.detail.replace(/[.\s]+$/, "");
  const mentions = p.mentions > 0 && p.mention_word ? `, ${p.mentions} new ${p.mentions === 1 ? "ticket mentions" : "tickets mention"} ${p.mention_word} since` : "";
  return (
    <div className={`${CARD} ${out ? "border-red-200 dark:border-red-800/60" : "border-amber-200 dark:border-amber-800/60"}`} data-status-popup={p.episode_id}>
      <div className="flex items-start gap-2.5">
        <CircleAlert className={`mt-0.5 h-4.5 w-4.5 shrink-0 ${out ? "text-red-600 dark:text-red-400" : "ink-warn"}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">
            {p.service_name} {stateSentence(p.state)}
          </p>
          <p className="mt-0.5 text-slate-600">
            {detail ? `${detail}. ` : ""}Started {clock(p.started_at)}
            {mentions}.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {p.incident ? (
              <Button size="sm" variant="secondary" icon={<Siren />} href={`/desk/tickets/${p.incident.number}`}>
                Major incident #{p.incident.number}
              </Button>
            ) : (
              p.can_declare && (
                <Button size="sm" icon={<Siren />} onClick={() => declare(p.service_id, p.team_id, p.episode_id)}>
                  Declare major incident
                </Button>
              )
            )}
            <Button size="sm" variant="secondary" onClick={() => setPillOpen(true)}>
              View details
            </Button>
          </div>
        </div>
        <Dismiss label={`Dismiss: ${p.service_name} ${stateSentence(p.state)}`} onClick={() => mark("dismiss", { episode_id: p.episode_id })} />
      </div>
    </div>
  );
}

function RecoveredCard({ p }: { p: TeamStatusPopup }) {
  const { mark } = useTeamStatus();
  const clock = useClock();
  return (
    <div className={`${CARD} border-emerald-200 dark:border-emerald-800/60`} data-status-popup={p.episode_id}>
      <div className="flex items-start gap-2.5">
        <CircleCheck className="ink-ok mt-0.5 h-4.5 w-4.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">
            {p.service_name} {stateSentence(p.state === "maintenance" ? "maintenance" : "operational")}
          </p>
          <p className="mt-0.5 text-slate-600">
            Back to normal at {clock(p.ended_at)}, after it started at {clock(p.started_at)}.
          </p>
        </div>
        <Dismiss label={`Dismiss: ${p.service_name} is back`} onClick={() => mark("dismiss_recovery", { episode_id: p.episode_id })} />
      </div>
    </div>
  );
}

interface SolveAnswer {
  solve: { results: IncidentTicketResult[]; incident: IncidentTicketResult } | null;
}

function AskCard({ ask }: { ask: TeamStatusAsk }) {
  const { mark, refresh } = useTeamStatus();
  const [busy, setBusy] = useState(false);

  async function solve() {
    setBusy(true);
    try {
      const r = await sendJson<SolveAnswer>(`/api/helpdesk/incidents/${ask.number}/updates`, "POST", { body: "", solve: true }, "Couldn't solve the incident.");
      const solved = r.solve?.results.filter((x) => x.ok).map((x) => x.number) ?? [];
      const left = r.solve?.results.filter((x) => !x.ok).length ?? 0;
      if (r.solve?.incident.ok) {
        toast("ok", `Major incident #${ask.number} solved${solved.length ? `, with ${listTicketNumbers(solved)}` : ""}.${left ? ` ${left} left open.` : ""}`);
      } else {
        toast("error", r.solve?.incident.error || `Major incident #${ask.number} is still open.`);
      }
      incidentsChanged();
      refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${CARD} border-emerald-200 dark:border-emerald-800/60`} data-status-ask={ask.number}>
      <div className="flex items-start gap-2.5">
        <Siren className="ink-ok mt-0.5 h-4.5 w-4.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">
            {ask.service_name} {stateSentence(ask.state)}
          </p>
          <p className="mt-0.5 text-slate-600">
            Major incident #{ask.number} {ask.title} is still open
            {ask.linked_open ? ` with ${ask.linked_open} linked ${ask.linked_open === 1 ? "ticket" : "tickets"}` : ""}. Solve it now?
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" busy={busy} onClick={solve}>
              Solve incident and linked tickets
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => mark("dismiss_ask", { incident_id: ask.incident_id })}>
              Not now
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
