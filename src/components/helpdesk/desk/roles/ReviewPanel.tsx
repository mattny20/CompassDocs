"use client";

// Reviews (agent J; agent D mounts it, e.g. at /desk/reviews, for people
// whose desk role holds replies.review): newbies' replies held before they
// reach the requester, oldest first. Each card shows the ticket, who wrote
// the reply and when, and the reply itself; the reviewer
//   Approve and send   sends it as written,
//   Edit               opens the text to change, then Approve and send,
//   Return…            sends it back to the newbie with a note (required),
// and the card leaves the list. GET /api/helpdesk/reviews,
// POST /api/helpdesk/reviews/[id].

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check, ClipboardCheck, Pencil, Undo2 } from "lucide-react";
import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { formDialog } from "@/components/Dialog";
import { EmptyState, Field, Textarea } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { RelativeTime } from "@/components/RelativeTime";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { UserAvatar } from "@/components/UserAvatar";
import type { HdPendingReview } from "@/lib/helpdesk/roles-shared";
import { getJson, sendJson } from "../api";

export function ReviewPanel({ withHeader = true, onCountChange }: { withHeader?: boolean; onCountChange?: (n: number) => void }) {
  const [reviews, setReviews] = useState<HdPendingReview[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getJson<{ reviews: HdPendingReview[] }>("/api/helpdesk/reviews", "Couldn't load the replies waiting for review.")
      .then((d) => {
        setReviews(d.reviews);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => load(), [load]);
  useEffect(() => {
    if (reviews) onCountChange?.(reviews.length);
  }, [reviews, onCountChange]);

  const done = (id: number) => setReviews((list) => (list ? list.filter((r) => r.message_id !== id) : list));

  const body = (
    <>
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {reviews === null && !error && <LoadingRow className="py-10" />}
      {reviews && reviews.length === 0 && (
        <EmptyState
          icon={<ClipboardCheck />}
          title="No replies waiting"
          body="When a newbie in your teams replies to a requester, the reply waits here for you before it is sent."
        />
      )}
      {reviews && reviews.length > 0 && (
        <ul className="flex flex-col gap-4" aria-label="Replies waiting for review">
          {reviews.map((r) => (
            <ReviewCard key={r.message_id} review={r} onDone={() => done(r.message_id)} />
          ))}
        </ul>
      )}
    </>
  );

  if (!withHeader) return body;
  return (
    <PageContainer>
      <PageHeader
        icon={<ClipboardCheck />}
        title="Reviews"
        subtitle="Newbies' replies wait here for a team lead before they reach the requester."
      />
      {body}
    </PageContainer>
  );
}

function ReviewCard({ review, onDone }: { review: HdPendingReview; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(review.body);
  const [busy, setBusy] = useState(false);
  const headingId = `review-${review.message_id}`;

  async function decide(payload: { decision: "approve" | "return"; edited_body?: string; note?: string }, ok: string) {
    setBusy(true);
    try {
      await sendJson(`/api/helpdesk/reviews/${review.message_id}`, "POST", payload, "Couldn't save the review.");
      toast("ok", ok);
      onDone();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    const edited = editing && text.trim() !== review.body.trim();
    if (editing && !text.trim()) return toast("error", "The reply is empty.");
    await decide(
      edited ? { decision: "approve", edited_body: text.trim() } : { decision: "approve" },
      edited ? `Your edited reply went to ${review.requester_name || "the requester"}.` : `${review.author_name}'s reply went to ${review.requester_name || "the requester"}.`
    );
  }

  async function giveBack() {
    const v = await formDialog({
      title: `Return ${review.author_name}'s reply`,
      body: "They see your note on the ticket and get a notification. The requester sees nothing.",
      fields: [{ key: "note", label: "What to change", type: "textarea", placeholder: "Offer the loan laptop while theirs is repaired." }],
      confirmLabel: "Return reply",
    });
    if (!v) return;
    await decide({ decision: "return", note: v.note.trim() }, `Returned to ${review.author_name} with your note.`);
  }

  return (
    <li aria-labelledby={headingId} className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="truncate text-sm font-semibold text-slate-900">
            <Link href={`/desk/tickets/${review.ticket_number}`} className="hover:underline">
              #{review.ticket_number} {review.ticket_subject}
            </Link>
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {review.requester_name ? `For ${review.requester_name}` : "For the requester"}
            {review.team_name ? ` · ${review.team_name}` : ""}
          </p>
        </div>
        <Chip tone="warn" size="sm">
          Waiting for review
        </Chip>
      </div>
      <div className="mt-4 flex items-start gap-3">
        <UserAvatar name={review.author_name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-slate-500">
            <span className="font-medium text-slate-700">{review.author_name}</span> wrote <RelativeTime value={review.created_at} />
          </p>
          {editing ? (
            <Field label="Reply" className="mt-2">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} className="h-36" maxLength={50000} data-autofocus />
            </Field>
          ) : (
            <p className="mt-2 whitespace-pre-wrap rounded-lg bg-canvas px-3 py-2 text-sm text-slate-800">{review.body}</p>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Check />} busy={busy} onClick={approve}>
          {editing ? "Approve edited reply" : "Approve and send"}
        </Button>
        {!editing && (
          <Button size="sm" variant="secondary" icon={<Pencil />} disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {editing && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setText(review.body);
            }}
          >
            Cancel edit
          </Button>
        )}
        <Button size="sm" variant="secondary" icon={<Undo2 />} disabled={busy} onClick={giveBack}>
          Return…
        </Button>
      </div>
    </li>
  );
}
