"use client";

// /desk/requests/[number]: the read-only view of a workflow request for a
// team that has a task on it (1.19.0 multi-team). It shows what that team
// needs and nothing it shouldn't: a "Read-only" banner saying why they
// see it, the requester, the form's answers, the public conversation (no
// composer, never an internal note), the workflow's progress with each
// team's step (times, assignee, outcome, notes, transfers), the hand-offs
// and the sibling tasks (linked only where the viewer may open them).
//
// Data: GET /api/helpdesk/tickets/[from]/workflow-context, where `from` is
// the task the viewer came from (?from=), or the request's own number.
// When the viewer may work the request itself (the context's
// viewer.can_work_request), the page sends them to the ordinary ticket
// instead.

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Eye, Inbox, ShieldOff, TriangleAlert, Workflow } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { Chip, chipClass, type ChipTone } from "@/components/Chip";
import { EYEBROW_TEXT } from "@/components/Heading";
import { PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { LoadingRow } from "@/components/Spinner";
import { initialsOf } from "@/components/UserAvatar";
import { EmptyState, SectionEmpty } from "@/components/form";
import type { HdFormAnswers, HdFormField, HdStatus } from "@/lib/helpdesk/types";
import { HD_STATUS_LABEL } from "@/lib/helpdesk/types";
import { useDeskMe } from "../me";
import { STATUS_TONE } from "../ui";
import { Conversation } from "../ticket/Conversation";
import type { HdRunStateB, HdWorkflowContext } from "./contract";
import { useWorkflowContext } from "./context";
import { HandoffList, WorkflowTimeline, handoffsOf } from "./steps-ui";
import { flatSteps } from "./TaskOutcome";

/** A ticket status chip; a status this build doesn't know shows as sent, neutral. */
function StatusChip({ status, size }: { status: HdStatus; size?: "sm" }) {
  const known = Object.hasOwn(HD_STATUS_LABEL, status);
  return <span className={chipClass(known ? STATUS_TONE[status] : "neutral", size)}>{known ? HD_STATUS_LABEL[status] : String(status)}</span>;
}

const RUN_CHIP: Record<HdRunStateB, { tone: ChipTone; label: string }> = {
  running: { tone: "accent", label: "In progress" },
  waiting: { tone: "accent", label: "Waiting" },
  blocked: { tone: "warn", label: "Stopped" },
  done: { tone: "ok", label: "Finished" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  declined: { tone: "error", label: "Declined" },
};

export function RequestView({ number, from }: { number: number; from: number | null }) {
  const router = useRouter();
  const me = useDeskMe();
  const source = from ?? number;
  const { ctx, error } = useWorkflowContext(source);
  // May the viewer work the request itself? Then this page is the wrong one.
  const canWork = !!ctx && ctx.request.number === number && ctx.viewer.can_work_request;
  useEffect(() => {
    if (canWork) router.replace(`/desk/tickets/${number}`);
  }, [canWork, number, router]);

  const back = from ? { href: `/desk/tickets/${from}`, label: `Back to task #${from}` } : { href: "/desk", label: "Back to the queue" };

  if (error || (ctx && ctx.request.number !== number)) {
    const status = error?.status ?? 404;
    return (
      <Shell>
        <BackLink {...back} />
        <PageHeader className="sr-only" title={`Request #${number}`} />
        <EmptyState
          icon={status === 404 ? <Inbox /> : status === 403 ? <ShieldOff /> : <TriangleAlert />}
          title={status === 403 ? "This request isn't open to you" : status === 404 ? `There's no request #${number} you can see` : "Couldn't load this request"}
          body={
            status === 403 || status === 404
              ? "A request opens read-only for the teams that have a task on it. Open it from your team's task."
              : error?.message
          }
          action={{ href: back.href, label: back.label }}
        />
      </Shell>
    );
  }

  if (!ctx || canWork) {
    return (
      <Shell>
        <PageHeader className="sr-only" title={`Request #${number}`} />
        <LoadingRow className="py-16" />
      </Shell>
    );
  }

  return (
    <Shell>
      <BackLink {...back} />
      <PageHeader
        className="mb-4"
        icon={<Workflow />}
        title={ctx.request.subject}
        subtitle={
          <>
            #{ctx.request.number}
            {ctx.request.request_type_title && ` · ${ctx.request.request_type_title}`} · opened <RelativeTime value={ctx.request.created_at} />
            {ctx.requester.name && ` by ${ctx.requester.name}`}
          </>
        }
        actions={<StatusChip status={ctx.request.status} />}
      />
      <ReadOnlyBanner ctx={ctx} from={from} />

      <div className="mt-4 grid grid-cols-1 items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_17rem] @6xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <section aria-labelledby="rv-progress-h" className={`${CARD_CLASS} p-4 sm:p-5`}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 id="rv-progress-h" className={EYEBROW_TEXT}>
                Workflow{ctx.workflow ? ` · ${ctx.workflow.workflow_title}` : ""}
              </h2>
              {ctx.workflow && <Chip tone={RUN_CHIP[ctx.workflow.state]?.tone ?? "neutral"}>{RUN_CHIP[ctx.workflow.state]?.label ?? ctx.workflow.state}</Chip>}
            </div>
            {ctx.workflow ? (
              <WorkflowTimeline workflow={ctx.workflow} currentNumber={from ?? undefined} canOpen={(n) => ctx.siblings.some((s) => s.number === n && s.can_open)} />
            ) : (
              <SectionEmpty>This request has no workflow.</SectionEmpty>
            )}
          </section>

          <section aria-labelledby="rv-conv-h">
            <h2 id="rv-conv-h" className={`${EYEBROW_TEXT} mb-2 px-1`}>
              Conversation with {ctx.requester.name || "the requester"}
            </h2>
            {ctx.messages.filter((m) => m.kind !== "internal").length ? (
              <Conversation messages={ctx.messages.filter((m) => m.kind !== "internal")} requesterId={ctx.requester.user_id} meId={me.id} />
            ) : (
              <SectionEmpty className="px-1">No replies yet.</SectionEmpty>
            )}
            <p className="mt-3 px-1 text-xs text-slate-500">
              Read-only: replies to the requester come from {ctx.task?.coordinating_team?.name ?? "the request's team"}. Use your task&apos;s ticket to talk to them.
            </p>
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <RequesterCard ctx={ctx} />
          <Answers form={ctx.form} answers={ctx.form_answers} />
          <section aria-labelledby="rv-handoffs-h" className={`${CARD_CLASS} p-4`}>
            <h2 id="rv-handoffs-h" className={EYEBROW_TEXT}>
              Hand-offs
            </h2>
            <HandoffList handoffs={handoffsOf(ctx.workflow).length ? handoffsOf(ctx.workflow) : ctx.handoffs} />
          </section>
          <Siblings ctx={ctx} from={from} />
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <article className="@container mx-auto w-full max-w-7xl px-4 py-4 sm:px-6 sm:py-5">{children}</article>
    </div>
  );
}

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {label}
    </Link>
  );
}

function ReadOnlyBanner({ ctx, from }: { ctx: HdWorkflowContext; from: number | null }) {
  const mine = from ? flatSteps(ctx.workflow?.steps).find((s) => s.task_ticket_number === from) : null;
  const teams = ctx.viewer.team_names.length ? ctx.viewer.team_names : [mine?.team_name].filter((x): x is string => !!x);
  const who = teams.length ? teams.join(" and ") : "your team";
  return (
    <p className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700" role="note">
      <Eye className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
      <span>
        <b className="font-semibold text-slate-900">Read-only</b> · You&apos;re seeing this because {who} {teams.length > 1 ? "have" : "has"} a task on it. Internal notes stay with{" "}
        {ctx.task?.coordinating_team?.name ?? "the request's team"}.
      </span>
    </p>
  );
}

function RequesterCard({ ctx }: { ctx: HdWorkflowContext }) {
  const r = ctx.requester;
  return (
    <section aria-label="Requester" className={`${CARD_CLASS} p-4`}>
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-compass-100 text-sm font-bold text-compass-700" aria-hidden>
          {initialsOf(r.name || "?")}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{r.name || r.email}</p>
          {(r.title || r.department) && <p className="truncate text-xs text-slate-500">{[r.title, r.department].filter(Boolean).join(" · ")}</p>}
        </div>
      </div>
      {(r.manager || r.office) && (
        <ul className="mt-3 space-y-1 text-xs text-slate-500">
          {r.manager && <li>Reports to {r.manager}</li>}
          {r.office && <li>{r.office}</li>}
        </ul>
      )}
    </section>
  );
}

function answerText(f: HdFormField, v: HdFormAnswers[string]): string {
  if (v === null || v === undefined || v === "") return "";
  if (f.type === "checkbox") return v ? "Yes" : "No";
  if (f.options?.length) return f.options.find((o) => o.value === String(v))?.label ?? String(v);
  return String(v);
}

function Answers({ form, answers }: { form: HdFormField[]; answers: HdFormAnswers }) {
  const rows = form.map((f) => ({ f, text: answerText(f, answers?.[f.key]) })).filter((r) => r.text);
  return (
    <section aria-labelledby="rv-answers-h" className={`${CARD_CLASS} p-4`}>
      <h2 id="rv-answers-h" className={EYEBROW_TEXT}>
        Request details
      </h2>
      {rows.length ? (
        <dl className="mt-2 space-y-2 text-sm">
          {rows.map(({ f, text }) => (
            <div key={f.key}>
              <dt className="text-xs text-slate-500">{f.label}</dt>
              <dd className="whitespace-pre-wrap text-slate-800">{text}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <SectionEmpty className="mt-2">The form had no answers.</SectionEmpty>
      )}
    </section>
  );
}

function Siblings({ ctx, from }: { ctx: HdWorkflowContext; from: number | null }) {
  if (!ctx.siblings.length) return null;
  return (
    <section aria-labelledby="rv-tasks-h" className={`${CARD_CLASS} p-4`}>
      <h2 id="rv-tasks-h" className={EYEBROW_TEXT}>
        Tasks
      </h2>
      <ul className="mt-2 space-y-2">
        {ctx.siblings.map((t) => {
          const label = (
            <span className="min-w-0 flex-1 truncate font-medium text-slate-800">
              #{t.number} {t.subject}
            </span>
          );
          return (
            <li key={t.number}>
              <div className="flex items-center gap-2 text-sm">
                {t.can_open || t.number === from ? (
                  <Link href={`/desk/tickets/${t.number}`} className="flex min-w-0 flex-1 items-center hover:underline">
                    {label}
                  </Link>
                ) : (
                  label
                )}
                <StatusChip status={t.status} size="sm" />
              </div>
              <p className="text-xs text-slate-500">
                {t.team_name ?? "No team"}
                {t.number === from ? " · your task" : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
