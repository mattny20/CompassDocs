"use client";

// One request as its requester follows it (/help/requests/[number], 1.19.0,
// the approved "progress" preview): the subject and its status chip, where
// it is (ProgressTracker), the conversation (public replies and the
// timeline's system lines, never an internal note: the API leaves them
// out), a reply box with attachments, the satisfaction question once it is
// solved, and "Your answers" beside it all.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CircleCheckBig, Info, LifeBuoy, MessageSquareOff, Stamp, Star } from "lucide-react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PageHeader } from "@/components/PageHeader";
import { CARD_CLASS } from "@/components/Card";
import { CardTitle, Eyebrow } from "@/components/Heading";
import { Button } from "@/components/Button";
import { EmptyState, Field, FormError, Textarea } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import { UserAvatar } from "@/components/UserAvatar";
import { RelativeTime } from "@/components/RelativeTime";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import type { HdMessage, HdRequestDetail } from "@/lib/helpdesk/types";
import { AssignedAgentCard } from "../contacts/AssignedAgentCard";
import { ProgressTracker } from "./ProgressTracker";
import { RequestPeopleCard } from "./RequestPeopleCard";
import { TeamClosedNotice } from "./TeamClosedNotice";
import { AttachButton, AttachmentChips, AttachmentLinks, useUploads } from "./attachments";
import { RequestStatusChip, fetchJson, formatAnswer } from "./shared";

const REPLY_MAX = 10000;

export function RequestDetail({
  number,
  viewerId,
  closedNotice = null,
}: {
  number: number;
  viewerId: number;
  /** The answering team's "closed" sentence while the request is open; null when the team is open. */
  closedNotice?: string | null;
}) {
  const [req, setReq] = useState<HdRequestDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const fmt = useFormatDate();

  const load = useCallback(async () => {
    const res = await fetchJson<{ request?: HdRequestDetail } & Partial<HdRequestDetail>>(
      `/api/helpdesk/requests/${number}`,
      undefined,
      "Couldn't load this request."
    );
    if (res.ok) {
      const r = (res.data.request ?? res.data) as HdRequestDetail;
      setReq(r);
      setError("");
    } else if (res.status === 404 || res.status === 403) setMissing(true);
    else setError(res.error);
  }, [number]);

  useEffect(() => {
    void load();
  }, [load]);

  const crumbs = (
    <Breadcrumbs
      className="mb-2"
      items={[
        { href: "/help", label: "Get help" },
        { href: "/help/requests", label: "My requests" },
        { href: `/help/requests/${number}`, label: `#${number}` },
      ]}
    />
  );

  if (missing || error) {
    return (
      <>
        {crumbs}
        <PageHeader icon={<LifeBuoy />} title={`Request #${number}`} />
        <EmptyState
          icon={<MessageSquareOff />}
          title={missing ? "We can't show you this request" : "Couldn't load this request"}
          body={missing ? "It may be someone else's, or the number may be wrong. Your own requests are all in My requests." : error}
          action={missing ? { href: "/help/requests", label: "My requests" } : { onClick: () => void load(), label: "Try again" }}
        />
      </>
    );
  }
  if (!req) return <LoadingRow>Loading the request…</LoadingRow>;

  const answers = req.form.filter((f) => formatAnswer(f, req.form_answers, fmt.day) !== "");
  const closed = req.status === "closed";

  return (
    <>
      {crumbs}
      <PageHeader
        icon={<LifeBuoy />}
        title={req.subject}
        subtitle={[`#${req.number}`, req.request_type_title, `sent ${fmt.date(req.created_at)}`].filter(Boolean).join(" · ")}
        actions={<RequestStatusChip status={req.status} inWorkflow={req.in_workflow} className="px-3 py-1 text-sm" />}
      />

      {req.status !== "solved" && req.status !== "closed" && <TeamClosedNotice message={closedNotice} className="mb-4" />}
      <ProgressTracker createdAt={req.created_at} status={req.status} teamName={req.team_name} workflow={req.workflow} />

      {req.my_approval && (
        <div className="mt-4 rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2 text-sm text-slate-700 print:hidden">
          This request is waiting for your decision.{" "}
          <Link href="/help/approvals" className="link font-medium">
            Decide in Approvals
          </Link>
        </div>
      )}

      <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="flex min-w-0 flex-col gap-3">
          {req.can_rate && <CsatCard number={req.number} onDone={load} />}
          <Conversation messages={req.messages} viewerId={viewerId} />
          {req.can_reply && !closed && <ReplyBox number={req.number} solved={req.status === "solved"} onSent={load} />}
          {closed && (
            <p className="text-sm text-slate-500">
              This request is closed. Something else? <Link href="/help" className="link font-medium">Send a new request</Link>.
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
        {/* Contact cards (agent O): the agent working on it, or the team it is with. */}
        {!closed && <AssignedAgentCard request={req.number} teamName={req.team_name} refreshKey={req.updated_at} />}
        {/* CCs (1.19.1, agent V3): the requester and the people copied. */}
        <RequestPeopleCard number={req.number} viewerId={viewerId} requesterName={req.requester_name} onChanged={() => void load()} />
        {/* Public custom fields the desk filled in (1.20.6, lib/helpdesk/custom-fields): read-only, only those with a value. */}
        {req.details && req.details.length > 0 && (
          <aside aria-labelledby="hd-details" className={`${CARD_CLASS} px-4 py-3`} data-testid="hd-request-details">
            <Eyebrow as="h2" className="mb-1 py-1">
              <span id="hd-details">Details</span>
            </Eyebrow>
            <dl className="divide-y divide-slate-100">
              {req.details.map((d) => {
                const value = d.type === "date" ? fmt.day(d.value) || d.value : d.type === "datetime" ? `${fmt.day(d.value.slice(0, 10)) || d.value.slice(0, 10)}, ${d.value.slice(11, 16)}` : d.value;
                const long = d.type === "textarea" || value.length > 40;
                return (
                  <div key={d.key} className={`py-2 text-sm ${long ? "" : "flex items-start justify-between gap-4"}`}>
                    <dt className="shrink-0 text-slate-500">{d.label}</dt>
                    <dd className={`min-w-0 whitespace-pre-line break-words font-medium text-slate-800 ${long ? "mt-0.5" : "text-right"}`}>{value}</dd>
                  </div>
                );
              })}
            </dl>
          </aside>
        )}
        {answers.length > 0 && (
          <aside aria-labelledby="hd-answers" className={`${CARD_CLASS} px-4 py-3`}>
            <Eyebrow as="h2" className="mb-1 py-1">
              <span id="hd-answers">Your answers</span>
            </Eyebrow>
            <dl className="divide-y divide-slate-100">
              {answers.map((f) => {
                const value = formatAnswer(f, req.form_answers, fmt.day);
                // A long answer (a reason) reads under its label; a short one sits beside it.
                const long = f.type === "textarea" || value.length > 40;
                return (
                  <div key={f.key} className={`py-2 text-sm ${long ? "" : "flex items-start justify-between gap-4"}`}>
                    <dt className="shrink-0 text-slate-500">{f.label}</dt>
                    <dd className={`min-w-0 whitespace-pre-line break-words font-medium text-slate-800 ${long ? "mt-0.5" : "text-right"}`}>{value}</dd>
                  </div>
                );
              })}
            </dl>
          </aside>
        )}
        </div>
      </div>
    </>
  );
}

/** The timeline: public messages as cards, system events as one muted line. */
function Conversation({ messages, viewerId }: { messages: HdMessage[]; viewerId: number }) {
  const fmt = useFormatDate();
  const visible = messages.filter((m) => m.kind !== "internal");
  if (visible.length === 0) return null;
  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation">
      {visible.map((m) =>
        m.kind === "system" ? (
          <li key={m.id} className="flex items-start gap-2 px-1 text-xs text-slate-500">
            {/approv|declin/i.test(m.body) ? <Stamp className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> : <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />}
            <span className="min-w-0">
              <span className="whitespace-pre-line">{m.body}</span> · {fmt.dateTime(m.created_at)}
            </span>
          </li>
        ) : (
          <li
            key={m.id}
            className={`${CARD_CLASS} px-4 py-3.5 ${m.author_id !== viewerId ? "border-l-3 border-l-compass-500" : ""}`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <UserAvatar name={m.author_name || "?"} className="h-6.5! w-6.5! text-2xs!" />
              <span className="text-sm font-semibold text-slate-900">{m.author_id === viewerId ? "You" : m.author_name}</span>
              <span className="text-xs text-slate-500">
                {m.via === "email" ? "by email · " : ""}
                <RelativeTime value={m.created_at} />
              </span>
            </div>
            <p className="mt-1.5 whitespace-pre-line break-words text-sm leading-relaxed text-slate-700 sm:ml-8.5">{m.body}</p>
            <div className="sm:ml-8.5">
              <AttachmentLinks files={m.attachments} />
            </div>
          </li>
        )
      )}
    </ol>
  );
}

function ReplyBox({ number, solved, onSent }: { number: number; solved: boolean; onSent: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uploads = useUploads();
  const box = useRef<HTMLTextAreaElement>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!body.trim() && uploads.done.length === 0) {
      setError("Write a message or attach a file.");
      box.current?.focus();
      return;
    }
    if (uploads.busy) {
      setError("Wait for the attachments to finish uploading.");
      return;
    }
    setBusy(true);
    const res = await fetchJson(
      `/api/helpdesk/requests/${number}/messages`,
      { method: "POST", body: JSON.stringify({ body: body.trim(), attachments: uploads.done }) },
      "Couldn't send your message."
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setBody("");
    uploads.clear();
    toast("ok", solved ? "Message sent. The request is open again." : "Message sent.");
    await onSent();
  }

  return (
    <form onSubmit={send} className={`${CARD_CLASS} overflow-hidden print:hidden`}>
      <label htmlFor="hd-reply" className="sr-only">
        Add a message
      </label>
      <Textarea
        id="hd-reply"
        ref={box}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={REPLY_MAX}
        placeholder={solved ? "Not sorted after all? Reply to reopen it…" : "Add a message…"}
        className="resize-none rounded-none border-0 px-4 py-3"
      />
      <div className="border-t border-slate-100 px-4 py-2.5">
        <AttachmentChips uploads={uploads} />
        <FormError className="my-2">{error}</FormError>
        <div className="flex items-center gap-2">
          <AttachButton uploads={uploads} />
          <Button type="submit" busy={busy} className="ml-auto">
            Send
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * The one satisfaction question, once the request is solved: five stars
 * as a radio group (arrows move the choice), an optional comment, Send.
 * The done state is a line in the same card; the toast is the announcement.
 */
function CsatCard({ number, onDone }: { number: number; onDone: () => Promise<void> }) {
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const words = ["", "Not good", "Could be better", "OK", "Good", "Great"];

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!score) {
      setError("Pick a rating first.");
      return;
    }
    setBusy(true);
    setError("");
    const res = await fetchJson(
      `/api/helpdesk/requests/${number}/csat`,
      { method: "POST", body: JSON.stringify({ score, comment: comment.trim() }) },
      "Couldn't save your rating."
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDone(true);
    toast("ok", "Thanks for telling us.");
    await onDone();
  }

  if (done) {
    return (
      <section className={`${CARD_CLASS} flex items-center gap-2 p-4 text-sm text-slate-700`}>
        <CircleCheckBig className="h-4 w-4 shrink-0 ink-ok" aria-hidden /> Thanks for rating this request.
      </section>
    );
  }
  return (
    <section aria-labelledby="hd-csat" className={`${CARD_CLASS} p-4 sm:p-5 print:hidden`}>
      <CardTitle as="h2" id="hd-csat">
        How did we do?
      </CardTitle>
      <p className="text-sm text-slate-500">This request is solved. One question, and it helps the team.</p>
      <form onSubmit={send} className="mt-3 flex flex-col gap-3">
        <div role="radiogroup" aria-label="Your rating" className="flex flex-wrap items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="cursor-pointer" data-tt={words[n]}>
              <input
                type="radio"
                name="hd-csat"
                value={n}
                checked={score === n}
                onChange={() => setScore(n)}
                className="peer sr-only"
              />
              <span className="grid h-9 w-9 place-items-center rounded-lg text-slate-300 transition hover:bg-slate-100 peer-focus-visible:outline-2 peer-focus-visible:outline-compass-600">
                <Star className={`h-6 w-6 ${n <= score ? "fill-amber-400 text-amber-400" : ""}`} aria-hidden />
              </span>
              <span className="sr-only">
                {n} of 5, {words[n]}
              </span>
            </label>
          ))}
          {score > 0 && <span className="ml-2 text-sm text-slate-600">{words[score]}</span>}
        </div>
        <Field label="Anything to add? (optional)" size="lg">
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
        </Field>
        <FormError>{error}</FormError>
        <div>
          <Button type="submit" busy={busy}>
            Send rating
          </Button>
        </div>
      </form>
    </section>
  );
}
