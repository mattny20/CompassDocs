"use client";

// "Assignment history" on a ticket's side column (agent N): a closed native
// <details> (STYLEGUIDE §Settings pages, the DocBlocksStatic disclosure
// recipe) that loads GET /api/helpdesk/tickets/[number]/assignment-log on
// first open: every owner the ticket had, how (round robin, a rule, on
// call, by hand…), from whom, and when; and, while nobody owns it, why it
// is waiting in the queue. `refreshKey` (the owner's id) reloads it after a
// change while it is open.

import { useEffect, useState } from "react";
import { History, Hourglass, Shuffle } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { RelativeTime } from "@/components/RelativeTime";
import { LoadingRow } from "@/components/Spinner";
import { SectionEmpty } from "@/components/form";
import { HD_ASSIGN_METHOD_LABEL, type HdAssignmentLogEntry, type HdAssignMethod } from "@/lib/helpdesk/assignment/shared";
import { getJson } from "../api";

interface Log {
  entries: HdAssignmentLogEntry[];
  queued: { since: string; reason: string } | null;
}

function line(e: HdAssignmentLogEntry): string {
  const to = e.to_name ?? "nobody";
  if (e.method === "manual" || e.method === "automation") {
    const by = e.method === "automation" ? "An automation" : e.actor_name ?? "Someone";
    if (!e.to_user_id) return `${by} unassigned it${e.from_name ? ` from ${e.from_name}` : ""}`;
    return e.actor_id && e.actor_id === e.to_user_id ? `${by} took it` : `${by} assigned it to ${to}`;
  }
  if (e.from_name && e.from_user_id !== e.to_user_id) return `Moved from ${e.from_name} to ${to}`;
  return `Assigned to ${to}`;
}

export function AssignmentHistory({ ticketNumber, refreshKey }: { ticketNumber: number; refreshKey?: unknown }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    getJson<Log>(`/api/helpdesk/tickets/${ticketNumber}/assignment-log`, "Couldn't load the assignment history.")
      .then((d) => live && (setLog(d), setError("")))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [open, ticketNumber, refreshKey]);

  return (
    <details className={`${CARD_CLASS} group text-left`} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
        <History className="h-4 w-4 text-slate-400" aria-hidden />
        Assignment history
        <span className="ml-auto text-xs font-normal text-slate-500 group-open:hidden">Show</span>
        <span className="ml-auto hidden text-xs font-normal text-slate-500 group-open:inline">Hide</span>
      </summary>
      <div className="border-t border-slate-100 px-4 pb-4 pt-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!log && !error && <LoadingRow className="py-3" />}
        {log?.queued && (
          <p className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-100">
            <Hourglass className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Waiting in the queue since <RelativeTime value={log.queued.since} />. {log.queued.reason}.
            </span>
          </p>
        )}
        {log && log.entries.length === 0 && !log.queued && <SectionEmpty>Nobody has been assigned yet.</SectionEmpty>}
        {log && log.entries.length > 0 && (
          <ol className="space-y-2.5">
            {log.entries.map((e) => (
              <li key={e.id} className="flex items-start gap-2">
                <Shuffle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="text-slate-800">{line(e)}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                    <span className={chipClass(e.method === "manual" ? "neutral" : "accent", "sm")}>{HD_ASSIGN_METHOD_LABEL[e.method as HdAssignMethod] ?? e.method}</span>
                    {e.rule_name && <span className="truncate">Rule “{e.rule_name}”</span>}
                    <RelativeTime value={e.at} />
                  </p>
                  {e.reason && e.method.startsWith("reassign") && <p className="mt-0.5 text-xs text-slate-500">{e.reason.charAt(0).toUpperCase() + e.reason.slice(1)}.</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}
