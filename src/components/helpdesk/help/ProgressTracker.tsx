"use client";

// Where a request is (1.19.0, the approved "progress" preview): one row of
// stages from Sent to the last step, done stages in emerald on an emerald
// line, the stage under way in the accent with its icon, the rest waiting
// in slate. A request with a workflow shows the workflow's own steps (a
// notify step is the desk's business and is left out); one without shows
// Sent, the team working on it, and Solved. From `sm` the stages sit in a
// row; on a phone they stack, each with its line down to the next.

import { Bell, Check, CircleCheckBig, Hourglass, ListChecks, MessageSquare, Stamp, X } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { useFormatDate } from "@/components/SettingsProvider";
import type { HdProgressStep, HdRunStepKind, HdStatus, HdWorkflowProgress } from "@/lib/helpdesk/types";

type StageState = "done" | "now" | "todo" | "declined";

interface Stage {
  key: string;
  title: string;
  detail: string;
  state: StageState;
  kind: HdRunStepKind | "sent" | "reply";
}

const ICON: Record<Stage["kind"], React.ReactNode> = {
  sent: <Check />,
  reply: <MessageSquare />,
  approval: <Stamp />,
  task: <ListChecks />,
  wait: <Hourglass />,
  notify: <Bell />,
  finish: <CircleCheckBig />,
};

function stageState(s: HdProgressStep["state"]): StageState {
  if (s === "done" || s === "skipped") return "done";
  // "failed" (a task team can't do it): the coordinating team decides next, so it is still being handled.
  if (s === "active" || s === "failed") return "now";
  if (s === "declined") return "declined";
  return "todo";
}

export function buildStages(input: {
  createdAt: string;
  status: HdStatus;
  teamName: string | null;
  workflow: HdWorkflowProgress | null;
  sentDetail: string;
  dayOf: (iso: string | null) => string;
}): Stage[] {
  const sent: Stage = { key: "sent", title: "Sent", detail: input.sentDetail, state: "done", kind: "sent" };
  const solved = input.status === "solved" || input.status === "closed";
  if (!input.workflow) {
    return [
      sent,
      {
        key: "work",
        title: input.status === "pending" ? "Waiting on you" : `${input.teamName || "The helpdesk"} is on it`,
        detail: input.status === "pending" ? "Reply below to keep it moving" : solved ? "Done" : "We'll reply here and by email",
        state: solved ? "done" : "now",
        kind: "reply",
      },
      { key: "solved", title: "Solved", detail: solved ? "Sorted" : "When you're sorted", state: solved ? "done" : "todo", kind: "finish" },
    ];
  }
  const stages: Stage[] = [sent];
  for (const s of input.workflow.steps) {
    if (s.kind === "notify") continue;
    const state = stageState(s.state);
    let title = s.title;
    if (s.kind === "approval" && state === "done") title = "Approved";
    if (s.kind === "approval" && state === "declined") title = "Declined";
    const children = s.children ?? [];
    let detail = s.detail;
    if (!detail && children.length > 0) {
      const done = children.filter((c) => c.state === "done" || c.state === "skipped").length;
      detail = `${done} of ${children.length} done`;
    }
    if (!detail) detail = state === "done" ? input.dayOf(s.finished_at) : state === "now" ? `since ${input.dayOf(s.started_at)}` : "";
    stages.push({ key: s.key, title, detail, state, kind: children.length > 0 ? "task" : s.kind });
  }
  return stages;
}

const DOT: Record<StageState, string> = {
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  now: "bg-compass-600 text-white ring-4 ring-compass-500/20",
  todo: "bg-slate-100 text-slate-400",
  declined: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

const STATE_WORD: Record<StageState, string> = { done: "done", now: "in progress", todo: "to come", declined: "declined" };

export function ProgressTracker(props: {
  createdAt: string;
  status: HdStatus;
  teamName: string | null;
  workflow: HdWorkflowProgress | null;
}) {
  const fmt = useFormatDate();
  const dayOf = (iso: string | null) => (iso ? fmt.date(iso) : "");
  const stages = buildStages({ ...props, dayOf, sentDetail: `${dayOf(props.createdAt)} · you` });
  // The line runs green up to the last finished stage.
  const lastDone = stages.reduce((n, s, i) => (s.state === "done" ? i : n), 0);
  const n = stages.length;

  return (
    <section aria-label="Progress" className={`${CARD_CLASS} px-4 py-5 sm:px-6`}>
      <ol className="relative flex flex-col gap-4 sm:grid sm:gap-2" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {/* The connecting line, behind the dots, from the first centre to the last (sm and up). */}
        <span
          aria-hidden
          className="absolute top-4 hidden h-0.5 bg-slate-200 sm:block"
          style={{ left: `${50 / n}%`, right: `${50 / n}%` }}
        />
        <span
          aria-hidden
          className="absolute top-4 hidden h-0.5 bg-emerald-500 sm:block"
          style={{ left: `${50 / n}%`, width: `${(lastDone / n) * 100}%` }}
        />
        {stages.map((s, i) => (
          <li key={s.key} className="relative flex items-start gap-3 sm:flex-col sm:items-center sm:gap-0 sm:text-center">
            {/* Phone: the line down to the next stage. */}
            {i < n - 1 && (
              <span
                aria-hidden
                className={`absolute left-4 top-8 h-[calc(100%-1rem)] w-0.5 -translate-x-1/2 sm:hidden ${i < lastDone ? "bg-emerald-500" : "bg-slate-200"}`}
              />
            )}
            <span
              className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-full [&>svg]:h-4 [&>svg]:w-4 ${DOT[s.state]}`}
              aria-hidden
            >
              {s.state === "done" ? <Check /> : s.state === "declined" ? <X /> : ICON[s.kind]}
            </span>
            <span className="min-w-0 sm:mt-2.5">
              <span className="block text-sm font-semibold text-slate-900">
                {s.title}
                <span className="sr-only">, {STATE_WORD[s.state]}</span>
              </span>
              {s.detail && <span className="block text-xs text-slate-500">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
