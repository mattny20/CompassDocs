"use client";

// The desk's Approvals (/desk/approvals): approvals waiting for the agent's
// own decision, the pending approvals on requests in their queues (so an
// agent can see what a request is waiting on, and chase it), and the ones
// they decided. The same API as Get help's Approvals (GET
// /api/helpdesk/approvals?state=pending|desk|decided, POST
// /api/helpdesk/approvals/[id], POST …/[id]/question); the card follows
// the Get help card: the answers the approver decides on, a note, Ask a
// question, Decline and Approve.

import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { Check, MessageCircleQuestion, Stamp, X } from "lucide-react";
import { Button } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState, TextInput } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { RelativeTime } from "@/components/RelativeTime";
import { Segmented } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { promptDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { initialsOf } from "@/components/UserAvatar";
import type { HdApprovalCard } from "@/lib/helpdesk/types";
import { getJson, listOf, sendJson } from "../api";
import { useDeskCounts } from "../counts";
import { useDeskMe } from "../me";

type Tab = "pending" | "desk" | "decided";

export function DeskApprovals() {
  const me = useDeskMe();
  const { refresh: refreshCounts } = useDeskCounts();
  const [tab, setTab] = useState<Tab>("pending");
  const [rows, setRows] = useState<HdApprovalCard[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    getJson(`/api/helpdesk/approvals?state=${tab}`, "Couldn't load the approvals.")
      .then((d) => setRows(listOf<HdApprovalCard>(d, "approvals")))
      .catch((e: Error) => setError(e.message));
  }, [tab]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  const options = [
    { value: "pending" as const, label: "Waiting for you" },
    ...(me.agent ? [{ value: "desk" as const, label: "In your queues" }] : []),
    { value: "decided" as const, label: "Decided" },
  ];

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <PageContainer>
        <PageHeader
          icon={<Stamp />}
          title="Approvals"
          subtitle="Requests waiting on a decision. Approving moves a request straight to its next step."
        />
        <Segmented label="Show" value={tab} onChange={setTab} options={options} className="mb-4 flex-wrap" size="sm" />
        {error && (
          <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">
            {error}{" "}
            <button type="button" className="link" onClick={load}>
              Try again
            </button>
          </p>
        )}
        {!error && rows === null && <LoadingRow className="py-10" />}
        {rows && rows.length === 0 && (
          <EmptyState
            icon={<Stamp />}
            title={tab === "pending" ? "Nothing waiting for your decision" : tab === "desk" ? "No request in your queues is waiting on an approval" : "You haven't decided any approvals lately"}
            body={
              tab === "pending"
                ? "When a workflow asks you to approve a request, it appears here, in the bell and by email."
                : tab === "desk"
                  ? "Requests in a workflow that are waiting on someone's approval show here, so you can see what they're waiting on."
                  : "Approvals you decided in the last 90 days are listed here."
            }
          />
        )}
        {rows && rows.length > 0 && (
          <ul className="flex flex-col gap-3">
            {rows.map((a) => (
              <ApprovalCard
                key={a.id}
                a={a}
                linkToTicket={me.agent}
                onDone={() => {
                  load();
                  refreshCounts();
                }}
              />
            ))}
          </ul>
        )}
      </PageContainer>
    </div>
  );
}

function ApprovalCard({ a, linkToTicket, onDone }: { a: HdApprovalCard; linkToTicket: boolean; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"" | "approved" | "declined" | "question">("");
  const noteId = useId();
  const headId = useId();

  async function decide(decision: "approved" | "declined") {
    let text = note.trim();
    if (decision === "declined" && !text) {
      const v = await promptDialog({
        title: `Decline ${a.subject}?`,
        body: `${a.requester_name} reads your note, so say why.`,
        label: "Why you're declining",
        type: "textarea",
        confirmLabel: "Decline",
      });
      if (!v) return;
      text = v.trim();
    }
    setBusy(decision);
    try {
      await sendJson(`/api/helpdesk/approvals/${a.id}`, "POST", { decision, note: text }, "Couldn't record your decision.");
      toast("ok", decision === "approved" ? `Approved. #${a.ticket_number} moves to its next step.` : `Declined. ${a.requester_name} has been told why.`);
      onDone();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function ask() {
    const v = await promptDialog({
      title: "Ask a question",
      body: `Your question is posted on the request, and ${a.requester_name} is told by email.`,
      label: "Your question",
      type: "textarea",
      confirmLabel: "Send question",
    });
    if (!v) return;
    setBusy("question");
    try {
      await sendJson(`/api/helpdesk/approvals/${a.id}/question`, "POST", { body: v.trim() }, "Couldn't send your question.");
      toast("ok", "Question sent.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const ref = linkToTicket ? (
    <Link href={`/desk/tickets/${a.ticket_number}`} className="hover:underline">
      #{a.ticket_number}
    </Link>
  ) : (
    <>#{a.ticket_number}</>
  );

  return (
    <li className={CARD_CLASS} aria-labelledby={headId}>
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-compass-100 text-sm font-bold text-compass-700" aria-hidden>
          {initialsOf(a.requester_name || "?")}
        </span>
        <div className="min-w-[min(100%,16rem)] flex-1">
          <h2 id={headId} className="text-base font-semibold text-slate-900">
            {a.subject}
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {ref}
            {a.request_type_title && ` · ${a.request_type_title}`} · {a.requester_name} · <RelativeTime value={a.created_at} />
            {a.reason && ` · ${a.reason}`}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">Step: {a.step_title}</p>
        </div>
        {a.decision === "pending" ? (
          a.can_decide ? (
            <Chip tone="warn">Needs your decision</Chip>
          ) : (
            <Chip tone="neutral">Waiting on the approver</Chip>
          )
        ) : a.decision === "approved" ? (
          <Chip tone="ok">Approved</Chip>
        ) : a.decision === "declined" ? (
          <Chip tone="error">Declined</Chip>
        ) : (
          <Chip tone="neutral">Cancelled</Chip>
        )}
      </div>
      {(a.answers.length > 0 || a.body) && (
        <div className="border-t border-slate-100 p-4">
          {a.answers.length > 0 && (
            <dl className="card-grid gap-x-6 gap-y-3 [--card-min:12rem]">
              {a.answers.map((x) => (
                <div key={x.key} className="min-w-0">
                  <dt className="text-xs text-slate-500">{x.label}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap text-sm font-medium text-slate-900">{x.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {a.body && <p className={`whitespace-pre-wrap text-sm text-slate-700 ${a.answers.length ? "mt-3" : ""}`}>{a.body}</p>}
        </div>
      )}
      {a.decision !== "pending" && (a.note || a.decided_by_name) && (
        <p className="border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
          {a.decided_by_name && <>Decided by {a.decided_by_name}{a.decided_at && <> · <RelativeTime value={a.decided_at} /></>}</>}
          {a.note && <span className="block text-slate-800">&ldquo;{a.note}&rdquo;</span>}
        </p>
      )}
      {a.can_decide && a.decision === "pending" && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 p-4">
          <label htmlFor={noteId} className="sr-only">
            Note for {a.requester_name}
          </label>
          <TextInput
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            placeholder="Add a note (optional; required to decline)"
            className="min-w-0 flex-1 basis-60"
          />
          <Button variant="secondary" icon={<MessageCircleQuestion />} busy={busy === "question"} disabled={!!busy} onClick={ask}>
            Ask a question
          </Button>
          <Button variant="danger" icon={<X />} busy={busy === "declined"} disabled={!!busy} onClick={() => decide("declined")}>
            Decline
          </Button>
          <Button icon={<Check />} busy={busy === "approved"} disabled={!!busy} onClick={() => decide("approved")}>
            Approve
          </Button>
        </div>
      )}
    </li>
  );
}
