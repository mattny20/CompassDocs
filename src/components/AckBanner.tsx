"use client";

// Reader-side acknowledgement UI (enterprise). Shown on published docs with
// ack_required: an amber "please confirm" bar, or a quiet "you confirmed on…"
// line once done. Any edit to the doc resets everyone to pending.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheckBig, FileCheck } from "lucide-react";

export function AckBanner({
  docId,
  initialAckedAt,
}: {
  docId: number;
  initialAckedAt: string | null;
}) {
  const router = useRouter();
  const [ackedAt, setAckedAt] = useState<string | null>(initialAckedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (ackedAt) {
    return (
      <p className="mb-4 flex items-center gap-1.5 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700 print:hidden">
        <CircleCheckBig className="h-4 w-4" />
        You confirmed reading this document on {new Date(ackedAt).toLocaleString()}.
      </p>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 print:hidden">
      <div className="flex flex-wrap items-center gap-3">
        <FileCheck className="h-5 w-5 shrink-0 text-amber-600" />
        <p className="min-w-0 flex-1 text-sm text-amber-900">
          <strong>Please read this document carefully.</strong> Your confirmation is recorded
          for compliance.
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
          className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 disabled:opacity-60"
        >
          {busy ? "Recording…" : "I've read and understood this"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

/** Approver-side switch + report link, shown under the doc header. */
export function AckControls({
  docId,
  initialRequired,
  ackedCount,
  requiredCount,
  isPublished,
}: {
  docId: number;
  initialRequired: boolean;
  ackedCount: number;
  requiredCount: number;
  isPublished: boolean;
}) {
  const router = useRouter();
  const [required, setRequired] = useState(initialRequired);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-surface px-4 py-2.5 text-sm print:hidden">
      <label className={`flex items-center gap-2 ${isPublished ? "cursor-pointer" : "opacity-50"}`}>
        <input
          type="checkbox"
          checked={required}
          disabled={busy || !isPublished}
          onChange={async (e) => {
            const next = e.target.checked;
            setBusy(true);
            setError("");
            const res = await fetch(`/api/documents/${docId}/ack`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ required: next }),
            });
            setBusy(false);
            if (res.ok) {
              setRequired(next);
              router.refresh();
            } else {
              setError((await res.json().catch(() => ({}))).error || "Could not update.");
            }
          }}
          className="h-4 w-4 accent-compass-600"
        />
        <span className="font-medium text-slate-700">Require read confirmation</span>
      </label>
      {!isPublished && <span className="text-xs text-slate-400">(publish first)</span>}
      {required && (
        <a
          href={`/doc/${docId}/acknowledgements`}
          className="ml-auto font-medium text-compass-700 hover:underline"
        >
          {ackedCount}/{requiredCount} confirmed — view record →
        </a>
      )}
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}
