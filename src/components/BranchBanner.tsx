"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { GitBranch, GitMerge, LoaderCircle, Trash2 } from "lucide-react";

// Banner shown on a draft-branch document: link to the original, merge back
// (with an optional change note), or discard the branch.

export function BranchBanner({
  branchId,
  sourceId,
  sourceTitle,
  canEdit,
  needsReview,
}: {
  branchId: number;
  sourceId: number;
  sourceTitle: string;
  canEdit: boolean;
  /** True when a merge will go to the review queue instead of applying. */
  needsReview: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"merge" | "discard" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function merge() {
    const q = needsReview
      ? "Submit this branch to the review queue? The live document changes once it's approved."
      : `Merge this branch into “${sourceTitle}”? The branch will move to the Trash.`;
    if (!confirm(q)) return;
    setBusy("merge");
    setError("");
    try {
      const res = await fetch(`/api/documents/${branchId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Merge failed.");
      if (data.pending) {
        setNotice("Merge submitted for review — an approver or admin will apply it.");
        setBusy(null);
        return;
      }
      router.push(`/doc/${sourceId}`);
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Merge failed.");
      setBusy(null);
    }
  }

  async function discard() {
    if (!confirm("Discard this draft branch? It moves to the Trash; the original is unaffected."))
      return;
    setBusy("discard");
    setError("");
    const res = await fetch(`/api/documents/${branchId}`, { method: "DELETE" });
    if (res.ok) {
      router.push(`/doc/${sourceId}`);
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data?.error || "Couldn't discard the branch.");
      setBusy(null);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900 print:hidden dark:border-violet-800/60 dark:bg-violet-950/40 dark:text-violet-200">
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
            className="w-64 max-w-full rounded-md border border-violet-200 bg-surface px-2.5 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-400 dark:border-violet-800/60"
          />
          <button
            onClick={merge}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {busy === "merge" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
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
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
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
