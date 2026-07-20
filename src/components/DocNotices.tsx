"use client";

// One place for everything that used to be a stack of colored banners on the
// doc page: read-confirmation (reader + approver progress), draft, branches in
// progress, and pending changes. A single neutral container with one compact
// row per notice, so document workflow state stops competing with the content.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  CircleCheckBig,
  FileCheck,
  GitBranch,
  Hourglass,
  LoaderCircle,
  ShieldCheck,
  SquarePen,
} from "lucide-react";

const ROW = "flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm";
const ICON = "h-4 w-4 shrink-0";

export function DocNotices({
  docId,
  ack,
  ackProgress,
  isDraft = false,
  branchCount = 0,
  pendingCount = 0,
}: {
  docId: number;
  /** Reader-side read confirmation (enterprise): null = not applicable. */
  ack?: { ackedAt: string | null } | null;
  /** Approver-side progress (enterprise), when confirmation is required. */
  ackProgress?: { ackedCount: number; requiredCount: number } | null;
  isDraft?: boolean;
  branchCount?: number;
  pendingCount?: number;
}) {
  const router = useRouter();
  const [ackedAt, setAckedAt] = useState<string | null>(ack?.ackedAt ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const hasAckRow = ack !== undefined && ack !== null;
  const rows =
    (hasAckRow ? 1 : 0) +
    (ackProgress ? 1 : 0) +
    (isDraft ? 1 : 0) +
    (branchCount > 0 ? 1 : 0) +
    (pendingCount > 0 ? 1 : 0);
  if (rows === 0) return null;

  return (
    <div className="mb-8 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-surface print:hidden">
      {hasAckRow &&
        (ackedAt ? (
          <p className={`${ROW} text-emerald-700`}>
            <CircleCheckBig className={`${ICON} text-emerald-600`} />
            You confirmed reading this document on {new Date(ackedAt).toLocaleString()}.
          </p>
        ) : (
          <div className={`${ROW} bg-amber-50/60 dark:bg-amber-950/20`}>
            <FileCheck className={`${ICON} text-amber-600`} />
            <p className="min-w-0 flex-1 text-slate-700">
              <strong>Please read this document carefully</strong> — your confirmation is
              recorded for compliance.
            </p>
            <button
              onClick={async () => {
                setBusy(true);
                setError("");
                const res = await fetch(`/api/documents/${docId}/ack`, { method: "POST" });
                setBusy(false);
                if (res.ok) {
                  setAckedAt((await res.json()).acknowledged_at ?? new Date().toISOString());
                  router.refresh();
                } else {
                  setError((await res.json().catch(() => ({}))).error || "Could not record it.");
                }
              }}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 disabled:opacity-60"
            >
              {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
              I&apos;ve read and understood this
            </button>
            {error && <span className="w-full text-xs text-red-600">{error}</span>}
          </div>
        ))}

      {ackProgress && (
        <div className={`${ROW} text-slate-600`}>
          <ShieldCheck className={`${ICON} text-compass-600`} />
          <span className="min-w-0 flex-1">
            Read confirmation required — {ackProgress.ackedCount}/{ackProgress.requiredCount}{" "}
            confirmed.
          </span>
          <a
            href={`/doc/${docId}/acknowledgements`}
            className="shrink-0 font-medium text-compass-700 hover:underline"
          >
            View record →
          </a>
        </div>
      )}

      {isDraft && (
        <p className={`${ROW} text-slate-600`}>
          <SquarePen className={`${ICON} text-slate-400`} />
          <span>
            This is a <strong>draft</strong> — it isn&apos;t visible to viewers yet.
          </span>
        </p>
      )}

      {branchCount > 0 && (
        <div className={`${ROW} text-slate-600`}>
          <GitBranch className={`${ICON} text-violet-600`} />
          <span className="min-w-0 flex-1">
            {branchCount} draft branch{branchCount === 1 ? "" : "es"} in progress.
          </span>
          <Link
            href={`/doc/${docId}/history`}
            className="shrink-0 font-medium text-compass-700 hover:underline"
          >
            View in history →
          </Link>
        </div>
      )}

      {pendingCount > 0 && (
        <div className={`${ROW} text-slate-600`}>
          <Hourglass className={`${ICON} text-amber-600`} />
          <span className="min-w-0 flex-1">
            {pendingCount} pending change{pendingCount === 1 ? "" : "s"} awaiting review.
          </span>
          <Link href="/review" className="shrink-0 font-medium text-compass-700 hover:underline">
            Open review queue →
          </Link>
        </div>
      )}
    </div>
  );
}
