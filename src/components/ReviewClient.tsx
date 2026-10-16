"use client";

import { useState } from "react";
import { chipClass } from "@/components/Chip";
import { buttonClass } from "@/components/Button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardList, House } from "lucide-react";
import { DocDiff } from "./DocDiff";
import { MarkdownView } from "./MarkdownView";
import { EmptyState } from "./form";
import { toast } from "./Toasts";
import { people } from "./compliance/copy";
import {
  ReconfirmHost,
  assessChange,
  assessRefusal,
  fetchReconfirmContext,
  reconfirmDialog,
  returnFocus,
  revFromLabel,
} from "./ReconfirmModal";
import type { AckDecisionRefusalBody, ChangeAssessment, ReconfirmResult, ReconfirmText } from "./ReconfirmModal";
import { changeSummary, describeChange } from "@/lib/diff";
import type { ChangeRequest, Suggestion } from "@/lib/types";
import { timeAgo } from "@/lib/ui";

// The review queue (A6, 1.11.0): each change request says what approving it
// does to the readers' confirmations before the approver decides. The page
// batches, per request, the live text (for the "Changes vs live" diff) and,
// for a document that requires read confirmation, the summary with the
// confirmed text (counts, the version people confirmed). From those the card
// shows a chip beside "Edit", the submitter's recommendation and reason, and
// the diff with the one-sentence measurement. Approve on a request that
// changes the text of a confirmed, published document opens the same
// question as a save (ReconfirmModal) with the recommendation pre-selected
// and the note prefilled; the answer rides on the PATCH as ack_policy /
// ack_reason. A 428 from the route (the page's precomputation missed it)
// opens the same question from the body and sends the PATCH again.

/** The live document, for the diff and the "metadata only" rule. */
export type CrLiveText = { title: string; content: string; status: string };

/** The read-confirmation standing of the target, when it requires confirmation and the feature is licensed. */
export type CrAckDetails = {
  current: number;
  eligible: number;
  /** The confirmed version's number ("v12"); null when none. */
  rev: number | null;
  /** The text people confirmed; null when no version is marked. */
  baseline: ReconfirmText | null;
};

export type CrDetails = { live: CrLiveText | null; ack: CrAckDetails | null };

/** What approving does to confirmations (the chip), worked out as the route's pre-flight does. */
type Standing =
  | { kind: "none" }
  | { kind: "metadata" }
  | { kind: "unaffected" }
  | { kind: "recommend"; policy: "keep" | "reset"; assessed: ChangeAssessment }
  | { kind: "undecided"; assessed: ChangeAssessment };

/** "1 confirmation" / "42 confirmations". */
function confirmations(n: number): string {
  return `${n} confirmation${n === 1 ? "" : "s"}`;
}

/** The sentence the diff is captioned with, measured like the editor's question. */
function assess(cr: ChangeRequest, d: CrDetails): ChangeAssessment | null {
  if (!d.live) return null;
  return assessChange({
    baseline: d.ack?.baseline ?? null,
    loaded: { title: d.live.title, content: d.live.content },
    next: { title: cr.title, content: cr.content },
    baselineLabel: d.ack?.rev != null ? `v${d.ack.rev}` : undefined,
  });
}

function standingOf(cr: ChangeRequest, d: CrDetails | undefined): Standing {
  if (!d || !d.live || !d.ack || cr.target_status !== "published") return { kind: "none" };
  const versionWorthy = cr.content !== d.live.content || cr.title !== d.live.title;
  const publishing = d.live.status !== "published";
  if (!versionWorthy && !publishing) return { kind: "metadata" };
  const base = d.ack.baseline ?? { title: d.live.title, content: d.live.content };
  if (cr.content === base.content && cr.title === base.title) return { kind: "unaffected" };
  const assessed = assess(cr, d);
  if (!assessed) return { kind: "none" };
  if (cr.ack_policy === "keep" || cr.ack_policy === "reset") return { kind: "recommend", policy: cr.ack_policy, assessed };
  return { kind: "undecided", assessed };
}

/** The toast after an approval, from the route's ack_outcome. */
function approvedToast(outcome: { substantive?: boolean; reset?: boolean; confirmations_reset?: number; decision_id?: number | null } | undefined): string {
  if (!outcome || !outcome.substantive || outcome.decision_id == null) return "Approved.";
  if (!outcome.reset) return "Approved. Confirmations kept.";
  const n = outcome.confirmations_reset ?? 0;
  return n === 0 ? "Approved. Everyone will be asked to re-confirm." : `Approved. ${people(n)} will be asked to re-confirm.`;
}

export function ReviewClient({
  changeRequests,
  suggestions,
  details = {},
  keepReasonRequired = true,
}: {
  changeRequests: ChangeRequest[];
  suggestions: Suggestion[];
  /** Per change request id: the live text and, for a confirmed document, its standing. */
  details?: Record<number, CrDetails>;
  /** Program settings' "Require a reason for editorial fixes too" (E4). */
  keepReasonRequired?: boolean;
}) {
  const router = useRouter();
  const [crs, setCrs] = useState(changeRequests);
  const [sugs, setSugs] = useState(suggestions);
  const [busy, setBusy] = useState<string | null>(null);

  /** The question, with the recommendation (or the guess) pre-selected and the note prefilled. */
  async function askApprove(
    cr: ChangeRequest,
    ack: { current: number; eligible: number; rev: number | null; baseline: ReconfirmText | null },
    live: ReconfirmText | null,
    hint: string,
    suggested: "keep" | "reset"
  ): Promise<ReconfirmResult | null> {
    const next: ReconfirmText = { title: cr.title, content: cr.content };
    return reconfirmDialog({
      mode: "approve",
      docId: cr.document_id,
      docTitle: cr.document_title || cr.title,
      current: ack.current,
      eligible: ack.eligible,
      rev: ack.rev,
      baseline: ack.baseline ?? live ?? next,
      next,
      hint,
      suggested,
      initialNote: cr.ack_reason || cr.note || "",
      keepReasonRequired,
    });
  }

  async function approveCr(cr: ChangeRequest) {
    const d = details[cr.id];
    const standing = standingOf(cr, d);
    let decision: ReconfirmResult | undefined;
    if (standing.kind === "recommend" || standing.kind === "undecided") {
      // Awaited before anything is busy (STYLEGUIDE §Overlays): Cancel
      // leaves the card as it was.
      const answer = await askApprove(
        cr,
        d!.ack!,
        d!.live,
        standing.assessed.hint,
        standing.kind === "recommend" ? standing.policy : standing.assessed.suggested
      );
      if (!answer) return;
      decision = answer;
    }
    await sendApprove(cr, decision, false);
  }

  async function sendApprove(cr: ChangeRequest, decision: ReconfirmResult | undefined, retried: boolean) {
    // The Approve button that was clicked: the 428 question below opens
    // while it is disabled, so focus is handed back to it by hand.
    const opener = document.activeElement;
    setBusy(`cr-${cr.id}`);
    const res = await fetch(`/api/change-requests/${cr.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        ...(decision ? { ack_policy: decision.policy, ack_reason: decision.note } : {}),
      }),
    });
    setBusy(null);
    if (res.status === 428 && !retried) {
      // The route found a decision due that the page's precomputation did
      // not (the document changed since the page rendered, or its summary
      // could not be read). Ask from the body, with the confirmed text
      // fetched for the evidence, and send once more.
      const body = (await res.json().catch(() => ({}))) as AckDecisionRefusalBody;
      const ctx = await fetchReconfirmContext(cr.document_id);
      const d = details[cr.id];
      const live: ReconfirmText | null = d?.live ? { title: d.live.title, content: d.live.content } : null;
      const next: ReconfirmText = { title: cr.title, content: cr.content };
      const assessed = assessRefusal(body, { baseline: ctx?.baseline ?? null, loaded: live ?? next, next });
      const answer = await askApprove(
        cr,
        {
          current: body.confirmations ?? ctx?.current ?? 0,
          eligible: body.eligible ?? ctx?.eligible ?? 0,
          rev: revFromLabel(body.baseline) ?? ctx?.rev ?? null,
          baseline: ctx?.baseline ?? null,
        },
        live,
        assessed.hint,
        cr.ack_policy === "keep" || cr.ack_policy === "reset" ? cr.ack_policy : assessed.suggested
      );
      returnFocus(opener);
      if (!answer) return;
      await sendApprove(cr, answer, true);
      return;
    }
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { ack_outcome?: Parameters<typeof approvedToast>[0] };
      toast("ok", approvedToast(data?.ack_outcome));
      setCrs((prev) => prev.filter((c) => c.id !== cr.id));
      router.refresh();
    } else {
      // The API explains *why* (stale request, lost edit rights, space gone,
      // a short reason): show that instead of swallowing it behind a generic
      // failure.
      const msg = (await res.json().catch(() => ({})))?.error;
      toast("error", msg || "Couldn't approve this change request.");
      // The card is live again: the button takes focus back when a question
      // along the way left it on <body>.
      returnFocus(opener);
    }
  }

  async function rejectCr(id: number) {
    setBusy(`cr-${id}`);
    const res = await fetch(`/api/change-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
    setBusy(null);
    if (res.ok) {
      setCrs((prev) => prev.filter((c) => c.id !== id));
      router.refresh();
    } else {
      const msg = (await res.json().catch(() => ({})))?.error;
      toast("error", msg || "Couldn't reject this change request.");
    }
  }

  async function reviewSug(id: number, action: "accept" | "dismiss") {
    setBusy(`sg-${id}`);
    const res = await fetch(`/api/suggestions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(null);
    if (res.ok) {
      setSugs((prev) => prev.filter((s) => s.id !== id));
      router.refresh();
    } else {
      const msg = (await res.json().catch(() => ({})))?.error;
      toast(
        "error",
        msg || `Couldn't ${action === "accept" ? "mark that suggestion done" : "dismiss that suggestion"}.`
      );
    }
  }

  const empty = crs.length === 0 && sugs.length === 0;
  if (empty) {
    return (
      <EmptyState
        icon={<ClipboardList />}
        title="The queue is empty"
        body="Nothing to review right now. Change requests and suggestions from writers land here."
        action={{ href: "/", label: "Back to dashboard", icon: <House /> }}
      />
    );
  }

  return (
    <div className="space-y-8">
      <ReconfirmHost />
      {crs.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Pending changes ({crs.length})
          </h2>
          <div className="space-y-3">
            {crs.map((cr) => {
              const d = details[cr.id];
              const standing = standingOf(cr, d);
              const n = d?.ack?.current ?? 0;
              // The sentence under the diff: the editor's own measurement
              // against the confirmed text (naming "since v12") when the
              // document requires confirmation, else the plain change size.
              const sentence =
                standing.kind === "recommend" || standing.kind === "undecided"
                  ? standing.assessed.hint
                  : d?.live
                    ? describeChange(
                        changeSummary(d.live.content, cr.content, { oldTitle: d.live.title, newTitle: cr.title })
                      )
                    : null;
              return (
                // One article per request, named by its title, so a test or
                // a screen reader finds the card without reading its classes.
                <article key={cr.id} aria-label={cr.title} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className={chipClass("warn")}>
                          {cr.kind === "publish" ? "Publish request" : "Edit"}
                        </span>
                        {standing.kind === "recommend" && standing.policy === "reset" && (
                          <span className={chipClass("warn")}>Resets {confirmations(n)}</span>
                        )}
                        {standing.kind === "recommend" && standing.policy === "keep" && (
                          <span className={chipClass("info")}>Keeps {confirmations(n)} (editorial)</span>
                        )}
                        {standing.kind === "undecided" && (
                          <span
                            className={chipClass("warn")}
                            data-tt="The submitter gave no recommendation. Approve opens the question."
                            data-tt-wrap=""
                            tabIndex={0}
                          >
                            Decision needed. {confirmations(n)}
                          </span>
                        )}
                        {standing.kind === "metadata" && (
                          <span className={chipClass("info")}>Metadata only. Confirmations unaffected</span>
                        )}
                        {standing.kind === "unaffected" && (
                          <span
                            className={chipClass("info")}
                            data-tt="The proposed text equals the version people confirmed."
                            data-tt-wrap=""
                            tabIndex={0}
                          >
                            Confirmations unaffected
                          </span>
                        )}
                        {cr.target_space_name && (
                          <span
                            className={chipClass("info")}
                            data-tt="Approving also moves the document to this space."
                          >
                            → moves to {cr.target_space_name}
                          </span>
                        )}
                        {cr.space_visibility === "public" && (
                          <span
                            className={chipClass("ok")}
                            data-tt="This space is public — approved changes are visible on the internet without signing in."
                            data-tt-wrap=""
                          >
                            🌐 Goes public
                          </span>
                        )}
                        <span className="text-xs text-slate-500">{timeAgo(cr.created_at)}</span>
                      </div>
                      <h3 className="font-semibold text-slate-900">{cr.title}</h3>
                      <p className="text-sm text-slate-500">
                        Proposed by {cr.author_name}
                        {cr.document_title ? (
                          <>
                            {" · "}
                            <Link href={`/doc/${cr.document_id}`} className="text-compass-600 hover:underline">
                              view current doc
                            </Link>
                          </>
                        ) : null}
                      </p>
                      {cr.note && <p className="mt-1 text-sm italic text-slate-500">“{cr.note}”</p>}
                      {standing.kind === "recommend" && (
                        <p className="mt-1 text-sm text-slate-700">
                          {cr.author_name} recommends: {standing.policy === "keep" ? "editorial fix" : "material change"}.
                          {cr.ack_reason ? ` "${cr.ack_reason}"` : ""}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        onClick={() => void approveCr(cr)}
                        disabled={busy === `cr-${cr.id}`}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => void rejectCr(cr.id)}
                        disabled={busy === `cr-${cr.id}`}
                        className={buttonClass("secondary")}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                  {d?.live ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-medium text-compass-600">Changes vs live</summary>
                      {sentence && <p className="mt-2 text-sm text-slate-600">{sentence}</p>}
                      <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-200">
                        <DocDiff
                          oldText={d.live.content}
                          newText={cr.content}
                          oldTitle={d.live.title}
                          newTitle={cr.title}
                          docKey={`review-${cr.id}`}
                        />
                      </div>
                    </details>
                  ) : (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-medium text-compass-600">
                        Preview proposed content
                      </summary>
                      <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-100 bg-slate-50 p-4">
                        <MarkdownView content={cr.content} />
                      </div>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {sugs.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Suggestions ({sugs.length})
          </h2>
          <div className="space-y-3">
            {sugs.map((sg) => (
              <div key={sg.id} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm text-slate-700">{sg.body}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      From {sg.author_name} · {timeAgo(sg.created_at)}
                      {sg.document_title ? (
                        <>
                          {" · on "}
                          <Link href={`/doc/${sg.document_id}`} className="text-compass-600 hover:underline">
                            {sg.document_title}
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => reviewSug(sg.id, "accept")}
                      disabled={busy === `sg-${sg.id}`}
                      className="rounded-lg border border-emerald-200 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                    >
                      Mark done
                    </button>
                    <button
                      onClick={() => reviewSug(sg.id, "dismiss")}
                      disabled={busy === `sg-${sg.id}`}
                      className={buttonClass("secondary")}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
