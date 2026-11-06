"use client";

// Get help (/help, 1.19.0, the approved "catalog" preview): the guide
// search, the request types as cards ("Popular requests"), and two cards
// side by side: My requests (the latest few, "All →") and Waiting for your
// approval (only when something is: an approver decides from here or from
// /help/approvals). Every list comes from the requester API, so the page
// shows exactly what the person may see.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Clock, Inbox, Plus } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { CARD_TITLE_TEXT, Eyebrow } from "@/components/Heading";
import { Button } from "@/components/Button";
import { EmptyState, SectionEmpty } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import { UserAvatar } from "@/components/UserAvatar";
import { RelativeTime } from "@/components/RelativeTime";
import { promptDialog } from "@/components/Dialog";
import { useAction } from "@/lib/use-action";
import type { HdRequestSummary, HdRequestType } from "@/lib/helpdesk/types";
import type { HdRequestSummaryExtras } from "@/lib/helpdesk/types";
import type { HdApprovalCard } from "@/lib/helpdesk/types";
import { KbSearch } from "./KbSearch";
import { RequestRowMeta } from "./RequestRowMeta";
import { RequestStatusChip, fetchJson, requestTypeIcon } from "./shared";
import { approvalHeadline, approvalMeta, approvalAmount } from "./approval-text";

type Summary = HdRequestSummary & HdRequestSummaryExtras;

const MY_REQUESTS_SHOWN = 4;

export function HelpHome({ viewerName }: { viewerName: string }) {
  const [types, setTypes] = useState<HdRequestType[] | null>(null);
  const [requests, setRequests] = useState<Summary[] | null>(null);
  const [approvals, setApprovals] = useState<HdApprovalCard[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    const [t, r, a] = await Promise.all([
      fetchJson<{ request_types?: HdRequestType[] }>("/api/helpdesk/request-types", undefined, "Couldn't load the request types."),
      fetchJson<{ requests?: Summary[] }>("/api/helpdesk/requests", undefined, "Couldn't load your requests."),
      fetchJson<{ approvals?: HdApprovalCard[] }>("/api/helpdesk/approvals", undefined, "Couldn't load your approvals."),
    ]);
    if (t.ok) setTypes(t.data.request_types ?? []);
    else setLoadError(t.error);
    setRequests(r.ok ? (r.data.requests ?? []) : []);
    // Someone who approves nothing still gets a 200 and an empty list; a
    // failure hides the card rather than blocking the page.
    setApprovals(a.ok ? (a.data.approvals ?? []).filter((x) => x.can_decide !== false) : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <KbSearch className="mb-8" />

      <Eyebrow as="h2" className="mb-3">
        Popular requests
      </Eyebrow>
      {types === null && !loadError ? (
        <LoadingRow>Loading request types…</LoadingRow>
      ) : loadError ? (
        <EmptyState icon={<Inbox />} title="Couldn't load Get help" body={loadError} action={{ onClick: () => void load(), label: "Try again" }} />
      ) : types && types.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="No request types yet"
          body="Your helpdesk team hasn't set up any request forms. You can still send a request and it will reach them."
          action={{ href: "/help/new", label: "Send a request", icon: <Plus /> }}
        />
      ) : (
        <ul className="card-grid gap-3.5 [--card-min:18rem]">
          {types!.map((t) => (
            <li key={t.id}>
              <RequestTypeCard type={t} />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr))]">
        <MyRequestsCard requests={requests} viewerName={viewerName} />
        {approvals && approvals.length > 0 && <ApprovalsCard approvals={approvals} onDecided={load} />}
      </div>
    </>
  );
}

function RequestTypeCard({ type }: { type: HdRequestType }) {
  const Icon = requestTypeIcon(type.icon);
  return (
    <Link
      href={`/help/new/${encodeURIComponent(type.slug)}`}
      className={`${CARD_CLASS} group flex h-full gap-3.5 p-4 transition hover:border-compass-300 hover:shadow-sm`}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block font-semibold text-slate-900 group-hover:text-compass-700">{type.title}</span>
        {type.description && <span className="mt-0.5 block text-sm leading-snug text-slate-500">{type.description}</span>}
        {type.eta_label && (
          <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-500">
            <Clock className="h-3 w-3" aria-hidden /> {type.eta_label}
          </span>
        )}
      </span>
    </Link>
  );
}

function MyRequestsCard({ requests, viewerName }: { requests: Summary[] | null; viewerName: string }) {
  // Open ones first (the server sorts by activity), then the latest solved.
  const shown = (requests ?? []).slice(0, MY_REQUESTS_SHOWN);
  return (
    <section className={`${CARD_CLASS} overflow-hidden`} aria-labelledby="hd-my-requests">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <h2 id="hd-my-requests" className={CARD_TITLE_TEXT}>
          My requests
        </h2>
        <Link href="/help/requests" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          All <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      {requests === null ? (
        <LoadingRow>Loading your requests…</LoadingRow>
      ) : shown.length === 0 ? (
        <SectionEmpty className="px-4 py-6">
          Nothing yet. Requests you send show up here, with where each one is.
        </SectionEmpty>
      ) : (
        <ul className="divide-y divide-slate-100">
          {shown.map((r) => (
            <li key={r.number}>
              <Link href={`/help/requests/${r.number}`} className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-slate-50">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">{r.subject}</span>
                  <RequestRowMeta request={r} viewerName={viewerName} />
                </span>
                <RequestStatusChip status={r.status} inWorkflow={r.in_workflow} className="shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ApprovalsCard({ approvals, onDecided }: { approvals: HdApprovalCard[]; onDecided: () => Promise<void> }) {
  const { run, isBusy } = useAction();

  async function decide(a: HdApprovalCard, decision: "approved" | "declined") {
    let note = "";
    if (decision === "declined") {
      const typed = await promptDialog({
        title: "Decline this request?",
        label: "Why? The requester sees this note.",
        type: "textarea",
        validate: (v) => (v.trim() ? undefined : "Add a note to decline."),
        confirmLabel: "Decline",
      });
      if (typed === null) return;
      note = typed.trim();
    }
    const ok = await run(
      a.id,
      () =>
        fetch(`/api/helpdesk/approvals/${a.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, note }),
        }),
      {
        fallback: decision === "approved" ? "Couldn't approve that request." : "Couldn't decline that request.",
        ok: decision === "approved" ? `Approved #${a.ticket_number}.` : `Declined #${a.ticket_number}.`,
        refresh: false,
      }
    );
    if (ok) await onDecided();
  }

  return (
    <section className={`${CARD_CLASS} overflow-hidden`} aria-labelledby="hd-approve">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <h2 id="hd-approve" className={CARD_TITLE_TEXT}>
          Waiting for your approval
        </h2>
        <Link href="/help/approvals" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          All <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <ul className="divide-y divide-slate-100">
        {approvals.slice(0, MY_REQUESTS_SHOWN).map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <UserAvatar name={a.requester_name} />
            <span className="min-w-0 flex-1">
              <Link href="/help/approvals" className="block truncate text-sm font-semibold text-slate-900 hover:text-compass-700">
                {approvalHeadline(a)}
              </Link>
              <span className="block truncate text-xs text-slate-500">
                {[approvalAmount(a), a.request_type_title].filter(Boolean).join(" · ")}
                {" · asked "}
                <RelativeTime value={a.created_at} />
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Button variant="secondary" size="sm" disabled={isBusy(a.id)} onClick={() => void decide(a, "declined")}>
                Decline<span className="sr-only"> {approvalMeta(a)}</span>
              </Button>
              <Button size="sm" busy={isBusy(a.id)} onClick={() => void decide(a, "approved")}>
                Approve<span className="sr-only"> {approvalMeta(a)}</span>
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
