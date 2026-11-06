"use client";

// Shared visuals for a multi-team workflow's progress in the desk: the
// step state chip (a closed set of words, STEP_STATE_LABEL), the compact
// list the Part of request card shows, the full timeline of the read-only
// request view (each team's step with its times, assignee, outcome, note,
// hand-off and transfers), and the hand-off list.

import Link from "next/link";
import { ArrowRightLeft, Check, CircleDashed, CircleDot, CircleSlash, CircleX, Signpost, Split } from "lucide-react";
import { Chip } from "@/components/Chip";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionEmpty } from "@/components/form";
import { useFormatDate } from "@/components/SettingsProvider";
import { STEP_STATE_LABEL, STEP_STATE_TONE, type HdHandoff, type HdProgressStepB, type HdRunStepStateB, type HdWorkflowProgressB } from "./contract";

export function StepStateChip({ state, size = "sm" }: { state: HdRunStepStateB; size?: "sm" | "md" }) {
  return (
    <Chip tone={STEP_STATE_TONE[state]} size={size}>
      {STEP_STATE_LABEL[state]}
    </Chip>
  );
}

const DOT: Record<HdRunStepStateB, { cls: string; icon: React.ReactNode }> = {
  done: { cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300", icon: <Check className="h-3.5 w-3.5" /> },
  active: { cls: "bg-compass-600 text-white ring-4 ring-compass-500/20", icon: <CircleDot className="h-3.5 w-3.5" /> },
  failed: { cls: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300", icon: <CircleSlash className="h-3.5 w-3.5" /> },
  declined: { cls: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300", icon: <CircleX className="h-3.5 w-3.5" /> },
  skipped: { cls: "bg-slate-100 text-slate-400", icon: <CircleSlash className="h-3.5 w-3.5" /> },
  cancelled: { cls: "bg-slate-100 text-slate-400", icon: <CircleX className="h-3.5 w-3.5" /> },
  pending: { cls: "bg-slate-100 text-slate-400", icon: <CircleDashed className="h-3.5 w-3.5" /> },
};

export function StepDot({ state, size = "md" }: { state: HdRunStepStateB; size?: "sm" | "md" }) {
  const d = DOT[state] ?? DOT.pending;
  return (
    <span className={`grid shrink-0 place-items-center rounded-full ${size === "sm" ? "h-5 w-5" : "h-7 w-7"} ${d.cls}`} aria-hidden>
      {d.icon}
    </span>
  );
}

/** The compact list (Part of request card): team · title and a state chip per step. */
export function MiniProgress({ workflow, currentNumber }: { workflow: HdWorkflowProgressB; currentNumber?: number }) {
  const lines = workflow.steps.flatMap((s) => (s.children?.length ? s.children : [s]));
  return (
    <ol className="space-y-1.5" aria-label="Progress across teams">
      {lines.map((s) => {
        const mine = !!currentNumber && s.task_ticket_number === currentNumber;
        return (
          <li key={s.key} className={`flex items-center gap-2 rounded-md ${mine ? "-mx-1.5 bg-compass-50/60 px-1.5 py-1" : ""}`}>
            <StepDot state={s.state} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-800">{s.title}</span>
              {(s.team_name || mine) && <span className="block truncate text-xs text-slate-500">{[mine ? "This task" : "", s.team_name].filter(Boolean).join(" · ")}</span>}
            </span>
            {s.state === "pending" ? <span className="sr-only">{STEP_STATE_LABEL.pending}</span> : <StepStateChip state={s.state} />}
          </li>
        );
      })}
    </ol>
  );
}

/** The full timeline of the read-only request view. */
export function WorkflowTimeline({ workflow, currentNumber, canOpen }: { workflow: HdWorkflowProgressB; currentNumber?: number; canOpen?: (n: number) => boolean }) {
  return (
    <ol className="space-y-0" aria-label={`Steps of ${workflow.workflow_title}`}>
      {workflow.steps.map((s, i) => (
        <li key={s.key} className="relative pb-5 pl-10 last:pb-0">
          {i < workflow.steps.length - 1 && <span className="absolute bottom-0 left-3.25 top-7 w-0.5 bg-slate-200" aria-hidden />}
          <span className="absolute left-0 top-0">
            <StepDot state={s.state} />
          </span>
          {s.children?.length ? (
            <div>
              <p className="flex items-center gap-1.5 pt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <Split className="h-3.5 w-3.5" aria-hidden />
                {s.title || "At the same time"}
                <span className="sr-only">: {STEP_STATE_LABEL[s.state]}</span>
              </p>
              <ul className="mt-2 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr))]">
                {s.children.map((c) => (
                  <li key={c.key} className={`rounded-lg border p-3 ${c.task_ticket_number === currentNumber ? "border-compass-300 bg-compass-50/40" : "border-slate-200"}`}>
                    <StepBody s={c} currentNumber={currentNumber} canOpen={canOpen} />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <StepBody s={s} currentNumber={currentNumber} canOpen={canOpen} />
          )}
        </li>
      ))}
    </ol>
  );
}

function StepBody({ s, currentNumber, canOpen }: { s: HdProgressStepB; currentNumber?: number; canOpen?: (n: number) => boolean }) {
  const fmt = useFormatDate();
  const mine = !!currentNumber && s.task_ticket_number === currentNumber;
  const link = s.task_ticket_number && (mine || canOpen?.(s.task_ticket_number)) ? `/desk/tickets/${s.task_ticket_number}` : null;
  const ended = s.acted_at ?? s.finished_at;
  const endWord = s.state === "skipped" ? "Skipped" : s.state === "failed" ? "Handed back" : s.state === "declined" ? "Declined" : "Finished";
  const detail = s.detail ?? "";
  // B's detail line often already names the team and who acted ("IT · done by Sara"); don't say it twice.
  const meta = [s.team_name && !detail.includes(s.team_name) ? s.team_name : "", s.assignee_name && !detail.includes(s.assignee_name) ? s.assignee_name : "", detail].filter(Boolean).join(" · ");
  const times = [s.started_at && `Started ${fmt.dateTime(s.started_at)}`, ended && `${endWord} ${fmt.dateTime(ended)}${s.actor && !detail.includes(s.actor) ? ` by ${s.actor}` : ""}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-sm font-semibold text-slate-900">
          {link ? (
            <Link href={link} className="hover:underline">
              {s.title}
            </Link>
          ) : (
            s.title
          )}
        </p>
        <StepStateChip state={s.state} />
        {mine && <span className="text-xs text-slate-500">Your task</span>}
      </div>
      {meta && <p className="mt-0.5 text-xs text-slate-500">{meta}</p>}
      {times && <p className="mt-0.5 text-xs text-slate-500">{times}</p>}
      {s.reason && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-slate-600">
          <Signpost className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          {s.state === "skipped" ? `Skipped: ${s.reason}` : s.reason}
        </p>
      )}
      {s.outcome === "cant_do" && s.note && (
        <p className="mt-1.5 rounded-md bg-red-50 px-2 py-1 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">Couldn&apos;t be done: {s.note}</p>
      )}
      {s.outcome !== "cant_do" && s.note && <p className="mt-1.5 text-sm text-slate-700">{s.note}</p>}
      {!!s.outputs?.length && <OutputList outputs={s.outputs} className="mt-2" />}
      {s.handoff_note && <p className="mt-1.5 whitespace-pre-line text-sm text-slate-700">&ldquo;{s.handoff_note}&rdquo;</p>}
      {!!s.transfers?.length && (
        <ul className="mt-1.5 space-y-0.5">
          {s.transfers.map((t, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-slate-500">
              <ArrowRightLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              <span>
                {t.from_team_name ? `Moved from ${t.from_team_name} to ${t.to_team_name ?? "another team"}` : `Sent to ${t.to_team_name ?? "another team"}`}
                {t.actor_name ? ` by ${t.actor_name}` : ""} · <RelativeTime value={t.at} />
                {t.note ? <span className="block text-slate-600">&ldquo;{t.note}&rdquo;</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OutputList({ outputs, className = "" }: { outputs: { key: string; label: string; value: string }[]; className?: string }) {
  return (
    <dl className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-slate-50 px-2.5 py-2 text-sm ${className}`}>
      {outputs.map((o) => (
        <div key={o.key} className="contents">
          <dt className="text-xs leading-5 text-slate-500">{o.label}</dt>
          <dd className="break-words font-medium text-slate-800">{o.value || "None"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A hand-off with who handed it on, when the progress knows. */
export type HandoffRow = HdHandoff & { by_name?: string | null };

/** Hand-offs from a progress (each finished task with fields or a note). */
export function handoffsOf(workflow: HdWorkflowProgressB | null | undefined): HandoffRow[] {
  if (!workflow) return [];
  return workflow.steps
    .flatMap((s) => (s.children?.length ? s.children : [s]))
    .filter((s) => s.outputs?.length || s.handoff_note)
    .map((s) => ({ step_key: s.key, title: s.title, team_name: s.team_name ?? null, outputs: s.outputs ?? [], note: s.handoff_note ?? "", at: s.acted_at ?? s.finished_at, by_name: s.actor ?? s.assignee_name ?? null }));
}

export function HandoffList({ handoffs, empty }: { handoffs: HandoffRow[]; empty?: string }) {
  if (!handoffs.length) return <SectionEmpty className="mt-2">{empty ?? "What each team hands on appears here as they finish their tasks."}</SectionEmpty>;
  return (
    <ul className="mt-2 space-y-3">
      {handoffs.map((h) => (
        <li key={h.step_key}>
          <p className="text-sm font-medium text-slate-800">{h.title}</p>
          <p className="text-xs text-slate-500">
            {[h.team_name, h.by_name].filter(Boolean).join(" · ")}
            {h.at && (
              <>
                {h.team_name || h.by_name ? " · " : ""}
                <RelativeTime value={h.at} />
              </>
            )}
          </p>
          {h.outputs.length > 0 && <OutputList outputs={h.outputs} className="mt-1.5" />}
          {h.note && <p className="mt-1.5 whitespace-pre-line text-sm text-slate-700">&ldquo;{h.note}&rdquo;</p>}
        </li>
      ))}
    </ul>
  );
}
