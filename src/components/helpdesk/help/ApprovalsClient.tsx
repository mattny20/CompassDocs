"use client";

// Approvals (/help/approvals, 1.19.0, the approved "approval" preview): the
// requests waiting for this person's decision. One is open at a time: who
// asks, for what, the answers they gave (what is being approved), then one
// note box and three actions: Ask a question (the note goes to the
// requester as a public message; the approval stays open), Decline (the
// note is required: the requester sees it) and Approve (the note is
// optional). The rest wait as one-line cards with Open. After a decision
// the card goes and focus moves to the next one.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Check, Stamp, X } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { EmptyState, TextInput } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import { UserAvatar } from "@/components/UserAvatar";
import { RelativeTime } from "@/components/RelativeTime";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import type { HdApprovalCard } from "@/lib/helpdesk/types";
import { answerValue, approvalAmount, approvalHeadline, isLongAnswer } from "./approval-text";
import { fetchJson } from "./shared";

const NOTE_MAX = 2000;

export function ApprovalsClient() {
  const [items, setItems] = useState<HdApprovalCard[] | null>(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const cards = useRef(new Map<number, HTMLElement | null>());
  const focusAfter = useRef<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetchJson<{ approvals?: HdApprovalCard[] }>("/api/helpdesk/approvals", undefined, "Couldn't load your approvals.");
    if (res.ok) {
      const list = (res.data.approvals ?? []).filter((a) => a.can_decide !== false);
      setItems(list);
      setOpenId((cur) => (cur !== null && list.some((a) => a.id === cur) ? cur : (list[0]?.id ?? null)));
      setError("");
    } else setError(res.error);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (focusAfter.current === null || !items) return;
    const id = focusAfter.current;
    focusAfter.current = null;
    cards.current.get(id)?.focus();
  }, [items]);

  function decided(id: number) {
    if (!items) return;
    const i = items.findIndex((a) => a.id === id);
    const rest = items.filter((a) => a.id !== id);
    const next = rest[i] ?? rest[i - 1] ?? null;
    focusAfter.current = next?.id ?? null;
    setItems(rest);
    setOpenId(next?.id ?? null);
  }

  if (error) {
    return <EmptyState icon={<Stamp />} title="Couldn't load your approvals" body={error} action={{ onClick: () => void load(), label: "Try again" }} />;
  }
  if (items === null) return <LoadingRow>Loading your approvals…</LoadingRow>;

  return (
    <>
      {items.length === 0 ? (
        <EmptyState
          icon={<Stamp />}
          title="Nothing waiting for your decision"
          body="When a request needs your approval it waits here with everything the person asked for."
          action={{ href: "/help", label: "Back to Get help" }}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((a) => (
            <li
              key={a.id}
              ref={(el) => {
                cards.current.set(a.id, el);
              }}
              tabIndex={-1}
              className="scroll-mt-6"
            >
              {a.id === openId ? (
                <ApprovalCard item={a} onDone={() => decided(a.id)} />
              ) : (
                <div className={`${CARD_CLASS} flex items-center gap-3 px-4 py-3 sm:px-5`}>
                  <UserAvatar name={a.requester_name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900">{approvalHeadline(a)}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {approvalAmount(a) && `${approvalAmount(a)} · `}asked <RelativeTime value={a.created_at} />
                    </span>
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => setOpenId(a.id)} aria-expanded={false}>
                    Open<span className="sr-only"> {approvalHeadline(a)}</span>
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-5 flex items-start gap-2 text-sm text-slate-500">
        <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        You&rsquo;re also told in Needs your attention on your dashboard, by email and in the bell.
      </p>
    </>
  );
}

function ApprovalCard({ item: a, onDone }: { item: HdApprovalCard; onDone: () => void }) {
  const fmt = useFormatDate();
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState("");
  const [busy, setBusy] = useState<"" | "approved" | "declined" | "question">("");
  const noteRef = useRef<HTMLInputElement>(null);
  const headingId = `hd-approval-${a.id}`;

  const rows = (a.answers ?? []).map((r) => ({ ...r, value: answerValue(r.value, fmt.day) }));
  const short = rows.filter((r) => !isLongAnswer(r.value));
  const long = rows.filter((r) => isLongAnswer(r.value));

  async function act(kind: "approved" | "declined" | "question") {
    if (busy) return;
    const text = note.trim();
    if (kind === "declined" && !text) {
      setNoteError("Add a note to decline: the requester sees it.");
      noteRef.current?.focus();
      return;
    }
    if (kind === "question" && !text) {
      setNoteError("Write your question in the note first.");
      noteRef.current?.focus();
      return;
    }
    setNoteError("");
    setBusy(kind);
    const res =
      kind === "question"
        ? await fetchJson(`/api/helpdesk/approvals/${a.id}/question`, { method: "POST", body: JSON.stringify({ body: text }) }, "Couldn't send your question.")
        : await fetchJson(
            `/api/helpdesk/approvals/${a.id}`,
            { method: "POST", body: JSON.stringify({ decision: kind, note: text }) },
            kind === "approved" ? "Couldn't approve this request." : "Couldn't decline this request."
          );
    setBusy("");
    if (!res.ok) {
      toast("error", res.error);
      return;
    }
    if (kind === "question") {
      setNote("");
      toast("ok", `Question sent to ${a.requester_name}. The request waits for your decision.`);
      return;
    }
    toast("ok", kind === "approved" ? `Approved #${a.ticket_number}. It moves to the next step.` : `Declined #${a.ticket_number}.`);
    onDone();
  }

  return (
    <section aria-labelledby={headingId} className={`${CARD_CLASS} overflow-hidden`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
        <UserAvatar name={a.requester_name} className="h-10! w-10! text-sm!" />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-base font-semibold text-slate-900">
            {approvalHeadline(a)}
          </h2>
          <p className="text-sm text-slate-500">
            <Link href={`/help/requests/${a.ticket_number}`} className="hover:text-slate-700">
              #{a.ticket_number}
            </Link>
            {a.request_type_title && ` · ${a.request_type_title}`} · sent <RelativeTime value={a.created_at} />
            {a.reason && ` · ${a.reason}`}
          </p>
        </div>
        <Chip tone="warn">Needs your decision</Chip>
      </div>

      {(short.length > 0 || long.length > 0 || a.body) && (
        <dl className="grid gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-3 sm:px-5">
          {short.map((r) => (
            <div key={r.key} className="min-w-0">
              <dt className="text-xs text-slate-500">{r.label}</dt>
              <dd className="mt-0.5 break-words font-semibold text-slate-900">{r.value}</dd>
            </div>
          ))}
          {long.map((r) => (
            <div key={r.key} className="min-w-0 sm:col-span-3">
              <dt className="text-xs text-slate-500">{r.label}</dt>
              <dd className="mt-0.5 whitespace-pre-line break-words leading-relaxed text-slate-700">{r.value}</dd>
            </div>
          ))}
          {a.body && (
            <div className="min-w-0 sm:col-span-3">
              <dt className="text-xs text-slate-500">Message</dt>
              <dd className="mt-0.5 whitespace-pre-line break-words leading-relaxed text-slate-700">{a.body}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="flex flex-col gap-2 border-t border-slate-100 px-4 py-3.5 sm:px-5 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            ref={noteRef}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              if (noteError) setNoteError("");
            }}
            maxLength={NOTE_MAX}
            placeholder="Add a note (optional; required to decline)"
            aria-label={`Note to ${a.requester_name}`}
            aria-invalid={noteError ? true : undefined}
            aria-describedby={noteError ? `${headingId}-err` : undefined}
            hasError={!!noteError}
            className="h-9 min-w-48 flex-1 py-1.5"
          />
          <span className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" busy={busy === "question"} disabled={!!busy} onClick={() => void act("question")}>
              Ask a question
            </Button>
            <Button variant="danger" icon={<X />} busy={busy === "declined"} disabled={!!busy} onClick={() => void act("declined")}>
              Decline
            </Button>
            <Button icon={<Check />} busy={busy === "approved"} disabled={!!busy} onClick={() => void act("approved")}>
              Approve
            </Button>
          </span>
        </div>
        {noteError && (
          <span id={`${headingId}-err`} role="alert" className="text-xs text-red-600">
            {noteError}
          </span>
        )}
      </div>
    </section>
  );
}
