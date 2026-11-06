"use client";

// My requests (/help/requests, 1.19.0): every request the person raised,
// open ones first, with a Show control (Open · Solved · All) over one
// divided list. A row is one link to the request; its chip is the
// requester's status ("Waiting on you" when someone asked them something).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Inbox, Plus } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { EmptyState, SectionEmpty } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import { Segmented } from "@/components/Segmented";
import { HD_OPEN_STATUSES, type HdRequestSummary } from "@/lib/helpdesk/types";
import type { HdRequestSummaryExtras } from "@/lib/helpdesk/types";
import { RequestRowMeta } from "./RequestRowMeta";
import { RequestStatusChip, fetchJson } from "./shared";

type Summary = HdRequestSummary & HdRequestSummaryExtras;
type Show = "open" | "solved" | "all";

export function RequestList({ viewerName }: { viewerName: string }) {
  const [rows, setRows] = useState<Summary[] | null>(null);
  const [error, setError] = useState("");
  const [show, setShow] = useState<Show>("open");

  async function load() {
    setError("");
    const res = await fetchJson<{ requests?: Summary[] }>("/api/helpdesk/requests", undefined, "Couldn't load your requests.");
    if (res.ok) setRows(res.data.requests ?? []);
    else setError(res.error);
  }
  useEffect(() => {
    void load();
  }, []);

  if (error) {
    return <EmptyState icon={<Inbox />} title="Couldn't load your requests" body={error} action={{ onClick: () => void load(), label: "Try again" }} />;
  }
  if (rows === null) return <LoadingRow>Loading your requests…</LoadingRow>;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Inbox />}
        title="No requests yet"
        body="When you send a request it shows up here, with where it is and every reply."
        action={{ href: "/help", label: "Get help", icon: <Plus /> }}
      />
    );
  }

  const isOpen = (r: Summary) => (HD_OPEN_STATUSES as readonly string[]).includes(r.status);
  const open = rows.filter(isOpen);
  const solved = rows.filter((r) => !isOpen(r));
  const shown = show === "open" ? open : show === "solved" ? solved : [...open, ...solved];

  return (
    <section className={`${CARD_CLASS} overflow-hidden`} aria-label="Your requests">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <p className="text-sm text-slate-500" aria-live="polite">
          {open.length} open · {solved.length} solved
        </p>
        <Segmented
          size="sm"
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: "open", label: "Open" },
            { value: "solved", label: "Solved" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      {shown.length === 0 ? (
        <SectionEmpty className="px-4 py-6">
          {show === "open" ? "Nothing open. Everything you asked for is sorted." : "Nothing solved yet."}
        </SectionEmpty>
      ) : (
        <ul className="divide-y divide-slate-100">
          {shown.map((r) => (
            <li key={r.number}>
              <Link href={`/help/requests/${r.number}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">{r.subject}</span>
                  <RequestRowMeta request={r} showTeam viewerName={viewerName} />
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
