"use client";

// Side-panel cards for multi-team workflows in the desk's ticket pane:
//   <PartOfRequestCard detail />  on a workflow task ticket: the request it
//     belongs to ("Part of request #1047 · New starter: Sam Lee"), the
//     progress across teams with a state chip each, and a way to the
//     request: the read-only view, or the ticket itself when the agent
//     may work it.
//   <HandoffsPanel detail />  on the request (parent) ticket: what each
//     team handed on when it finished (its hand-off fields and note).

import Link from "next/link";
import { ArrowUpRight, ClipboardList, Eye, Workflow } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { EYEBROW_TEXT } from "@/components/Heading";
import { SectionEmpty } from "@/components/form";
import { Spinner } from "@/components/Spinner";
import type { HdTicketDetail } from "@/lib/helpdesk/types";
import type { HdWorkflowProgressB } from "./contract";
import { useWorkflowContext } from "./context";
import { HandoffList, MiniProgress, handoffsOf } from "./steps-ui";
import { isTaskTicket } from "./TaskOutcome";

/** Where the read-only request view lives; `from` is the task it was opened from. */
export const requestViewHref = (request: number, from?: number) => `/desk/requests/${request}${from ? `?from=${from}` : ""}`;

export function PartOfRequestCard({ detail }: { detail: HdTicketDetail }) {
  const isTask = isTaskTicket(detail);
  const { ctx, error } = useWorkflowContext(isTask ? detail.ticket.number : null);
  if (!isTask || !detail.parent) return null;
  const parent = detail.parent;
  // 1.19.4 (C7): the request is in the recycle bin: say so, never name it.
  if (parent.deleted) {
    return (
      <section aria-labelledby="part-of-h" className={`${CARD_CLASS} p-4`}>
        <h3 id="part-of-h" className={`${EYEBROW_TEXT} flex items-center gap-1.5`}>
          <Workflow className="h-3.5 w-3.5 text-compass-600" aria-hidden />
          Part of request
        </h3>
        <SectionEmpty className="mt-1.5">Part of a deleted ticket.</SectionEmpty>
      </section>
    );
  }
  const canWork = !!ctx?.viewer?.can_work_request;
  return (
    <section aria-labelledby="part-of-h" className={`${CARD_CLASS} p-4`}>
      <h3 id="part-of-h" className={`${EYEBROW_TEXT} flex items-center gap-1.5`}>
        <Workflow className="h-3.5 w-3.5 text-compass-600" aria-hidden />
        Part of request
      </h3>
      <p className="mt-1.5 text-sm font-semibold text-slate-900">
        #{parent.number} · {parent.subject}
      </p>
      {ctx && (
        <p className="text-xs text-slate-500">
          {[ctx.request.request_type_title, ctx.requester.name && `for ${ctx.requester.name}`].filter(Boolean).join(" · ")}
        </p>
      )}
      <div className="mt-3">
        {error ? (
          <SectionEmpty>{error.status === 403 ? "You can see this task, but not the request it belongs to." : error.message}</SectionEmpty>
        ) : !ctx ? (
          <p className="flex items-center gap-2 text-sm text-slate-500" aria-busy>
            <Spinner size="sm" /> Loading the request…
          </p>
        ) : ctx.workflow ? (
          <MiniProgress workflow={ctx.workflow} currentNumber={detail.ticket.number} />
        ) : (
          <SectionEmpty>The request&apos;s workflow has ended.</SectionEmpty>
        )}
      </div>
      {!error && (
        <Link
          href={canWork ? `/desk/tickets/${parent.number}` : requestViewHref(parent.number, detail.ticket.number)}
          className="link mt-3 inline-flex items-center gap-1.5 text-sm font-medium"
        >
          {canWork ? <ArrowUpRight className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          {canWork ? "Open request" : "Open request (read-only)"}
        </Link>
      )}
    </section>
  );
}

export function HandoffsPanel({ detail }: { detail: HdTicketDetail }) {
  const wf = detail.workflow as HdWorkflowProgressB | null;
  if (!wf || isTaskTicket(detail)) return null;
  const hasTasks = wf.steps.some((s) => s.kind === "task" || s.children?.length);
  if (!hasTasks) return null;
  return (
    <section aria-labelledby="handoffs-h" className={`${CARD_CLASS} p-4`}>
      <h3 id="handoffs-h" className={`${EYEBROW_TEXT} flex items-center gap-1.5`}>
        <ClipboardList className="h-3.5 w-3.5 text-compass-600" aria-hidden />
        Hand-offs
      </h3>
      <HandoffList handoffs={handoffsOf(wf)} />
    </section>
  );
}
