"use client";

import { useState } from "react";
import { Spinner } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { GitBranch, GitMerge, Trash2 } from "lucide-react";
import {
  ReconfirmHost,
  assessChange,
  assessRefusal,
  fetchReconfirmContext,
  reconfirmDialog,
  returnFocus,
  revFromLabel,
  sameText,
} from "./ReconfirmModal";
import type { AckDecisionRefusalBody, ReconfirmContext, ReconfirmResult, ReconfirmText } from "./ReconfirmModal";

// Banner shown on a draft-branch document: link to the original, merge back
// (with an optional change note), or discard the branch.
//
// Merging into a confirmed document (A6, 1.11.0) is the same decision as a
// save: the merge is sent with the source's updated_at the page rendered
// with (a source saved since is answered 409 and shown, never overwritten),
// and a 428 opens the editor's question with the confirmed text as the
// evidence; the answer rides on the second POST as ack_policy / ack_reason
// and as the version note. A merge that queues for review asks the same
// question in "submit" mode before the POST, so the request carries the
// submitter's recommendation and the approver decides with it in view.

export function BranchBanner({
  branchId,
  sourceId,
  sourceTitle,
  sourceUpdatedAt = "",
  sourceAckRequired = false,
  branchTitle = "",
  branchContent = "",
  canEdit,
  needsReview,
}: {
  branchId: number;
  sourceId: number;
  sourceTitle: string;
  /** The source's updated_at as rendered: the merge's base_updated_at. */
  sourceUpdatedAt?: string;
  /** The source requires read confirmation: a direct merge is sent first and the route's 428 opens the question. */
  sourceAckRequired?: boolean;
  /** The branch's own text, the "next" side of the question's evidence. */
  branchTitle?: string;
  branchContent?: string;
  canEdit: boolean;
  /** True when a merge will go to the review queue instead of applying. */
  needsReview: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"merge" | "discard" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function postMerge(decision?: ReconfirmResult) {
    return fetch(`/api/documents/${branchId}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // The decision's note is the version note too, as the editor's is.
        note: decision ? decision.note : note.trim(),
        ...(sourceUpdatedAt ? { base_updated_at: sourceUpdatedAt } : {}),
        ...(decision ? { ack_policy: decision.policy, ack_reason: decision.note } : {}),
      }),
    });
  }

  /**
   * The texts of the question: the source's confirmed text (fetched once)
   * against the branch's; without a confirmed text the live source stands in
   * for the "before" side.
   */
  async function mergeTexts(): Promise<{ ctx: ReconfirmContext | null; loaded: ReconfirmText; next: ReconfirmText }> {
    const ctx = await fetchReconfirmContext(sourceId);
    const next: ReconfirmText = { title: branchTitle || sourceTitle, content: branchContent };
    let loaded: ReconfirmText = ctx?.baseline ?? next;
    if (!ctx?.baseline) {
      try {
        const res = await fetch(`/api/documents/${sourceId}`, { cache: "no-store" });
        if (res.ok) {
          const j = (await res.json()) as { doc?: { title?: string; content?: string } };
          if (j?.doc && typeof j.doc.content === "string") {
            loaded = { title: j.doc.title ?? sourceTitle, content: j.doc.content };
          }
        }
      } catch {
        // The hint then comes from the body's own numbers.
      }
    }
    return { ctx, loaded, next };
  }

  /** The merge question, from the route's 428: the confirmed text is fetched once for the evidence. */
  async function askMerge(body: AckDecisionRefusalBody): Promise<ReconfirmResult | null> {
    const { ctx, loaded, next } = await mergeTexts();
    const assessed = assessRefusal(body, { baseline: ctx?.baseline ?? null, loaded, next });
    return reconfirmDialog({
      mode: "merge",
      docId: sourceId,
      docTitle: sourceTitle,
      current: body.confirmations ?? ctx?.current ?? 0,
      eligible: body.eligible ?? ctx?.eligible ?? 0,
      rev: revFromLabel(body.baseline) ?? ctx?.rev ?? null,
      baseline: ctx?.baseline ?? loaded,
      next,
      hint: assessed.hint,
      suggested: assessed.suggested,
      initialNote: note.trim() || `Merged branch "${branchTitle || sourceTitle}"`,
      keepReasonRequired: ctx?.keepReasonRequired ?? true,
    });
  }

  /**
   * The question a merge that will queue for review asks (A6): the same
   * cards in "submit" mode, measured locally as the editor's submission is,
   * so the request carries the recommendation. Undefined when the branch's
   * text equals what people confirmed (nothing for readers to decide, the
   * plain question stands); null is Cancel.
   */
  async function askSubmit(): Promise<ReconfirmResult | null | undefined> {
    const { ctx, loaded, next } = await mergeTexts();
    if (sameText(ctx?.baseline ?? loaded, next)) return undefined;
    const assessed = assessChange({
      baseline: ctx?.baseline ?? null,
      loaded,
      next,
      baselineLabel: ctx?.rev != null ? `v${ctx.rev}` : undefined,
    });
    return reconfirmDialog({
      mode: "submit",
      docId: sourceId,
      docTitle: sourceTitle,
      current: ctx?.current ?? 0,
      eligible: ctx?.eligible ?? 0,
      rev: ctx?.rev ?? null,
      baseline: ctx?.baseline ?? loaded,
      next,
      hint: assessed.hint,
      suggested: assessed.suggested,
      initialNote: note.trim() || `Merged branch "${branchTitle || sourceTitle}"`,
      keepReasonRequired: ctx?.keepReasonRequired ?? true,
    });
  }

  async function merge() {
    // The Merge button that was clicked: the 428 question below opens while
    // it is disabled, so focus is handed back to it by hand.
    const opener = document.activeElement;
    // A direct merge into a confirmed document may be a decision (the route
    // answers 428 when the branch's text differs from what people
    // confirmed), so it is sent first and the 428 opens the one question. A
    // merge that queues for review asks the submit-mode question first, so
    // the request carries the recommendation; every other merge asks the
    // plain question it always did.
    let decision: ReconfirmResult | undefined;
    let plain = !sourceAckRequired || needsReview;
    if (needsReview && sourceAckRequired) {
      const asked = await askSubmit();
      if (asked === null) return;
      if (asked) {
        decision = asked;
        plain = false;
      }
    }
    if (plain) {
      const ok = needsReview
        ? await confirmDialog({
            title: "Submit this branch to the review queue?",
            body: "The live document changes once it's approved.",
            confirmLabel: "Submit",
          })
        : await confirmDialog({
            title: `Merge this branch into “${sourceTitle}”?`,
            body: "The branch will move to the Trash.",
            confirmLabel: "Merge",
          });
      if (!ok) return;
    }
    if (decision) setNote(decision.note);
    setBusy("merge");
    setError("");
    try {
      let res = await postMerge(decision);
      if (res.status === 428) {
        const body = (await res.json().catch(() => ({}))) as AckDecisionRefusalBody;
        setBusy(null);
        const answer = await askMerge(body);
        returnFocus(opener);
        if (!answer) return;
        setNote(answer.note);
        setBusy("merge");
        res = await postMerge(answer);
      }
      const data = await res.json();
      if (res.status === 409 && data?.conflict) {
        // The live document moved on: say so and re-render with its new
        // updated_at, so the next attempt compares against what is there now.
        setError(data.error || "The live document changed since this branch was created. Review it before merging.");
        setBusy(null);
        returnFocus(opener);
        router.refresh();
        return;
      }
      if (!res.ok) throw new Error(data?.error || "Merge failed.");
      if (data.pending) {
        setNotice("Merge submitted for review — an approver or admin will apply it.");
        setBusy(null);
        returnFocus(opener);
        return;
      }
      router.push(`/doc/${sourceId}`);
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Merge failed.");
      setBusy(null);
      returnFocus(opener);
    }
  }

  // Discarding is reversible (the branch goes to the Trash), so it does not
  // ask — it tells, with Undo.
  async function discard() {
    setBusy("discard");
    setError("");
    const res = await fetch(`/api/documents/${branchId}`, { method: "DELETE" });
    if (res.ok) {
      router.push(`/doc/${sourceId}`);
      router.refresh();
      toast("ok", "Branch discarded.", {
        action: {
          label: "Undo",
          onClick: async () => {
            const r = await fetch(`/api/trash/${branchId}`, { method: "POST" });
            if (r.ok) {
              toast("ok", "Branch restored.");
              router.push(`/doc/${branchId}`);
              router.refresh();
            } else {
              toast("error", (await r.json().catch(() => ({})))?.error || "Couldn't restore the branch — look in Settings → Trash.");
            }
          },
        },
      });
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data?.error || "Couldn't discard the branch.");
      setBusy(null);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900 print:hidden dark:border-violet-800/60 dark:bg-violet-950/40 dark:text-violet-200">
      <ReconfirmHost />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <GitBranch className="h-4 w-4 shrink-0" />
        <span>
          This is a <strong>draft branch</strong> of{" "}
          <Link href={`/doc/${sourceId}`} className="font-semibold underline">
            {sourceTitle}
          </Link>
          . Edits here don&apos;t touch the live document until you merge.
        </span>
      </div>
      {canEdit && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Describe this change (optional)"
            maxLength={200}
            className="w-64 max-w-full rounded-md border border-violet-200 bg-surface px-2.5 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-hidden focus:ring-1 focus:ring-violet-400 dark:border-violet-800/60"
          />
          <button
            onClick={merge}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {busy === "merge" ? (
              <Spinner size="sm" />
            ) : (
              <GitMerge className="h-3.5 w-3.5" />
            )}
            {needsReview ? "Submit merge for review" : "Merge into original"}
          </button>
          <button
            onClick={discard}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md border border-violet-300 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-60 dark:border-violet-700 dark:text-violet-300"
          >
            {busy === "discard" ? (
              <Spinner size="sm" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Discard
          </button>
        </div>
      )}
      {(notice || error) && (
        <p className={`mt-2 text-xs font-medium ${error ? "text-red-600" : "text-emerald-700 dark:text-emerald-300"}`}>
          {error || notice}
        </p>
      )}
    </div>
  );
}
