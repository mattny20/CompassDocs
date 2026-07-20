"use client";

// Review-schedule card in the doc side panel (staff with edit rights):
// choose a re-review cadence, see when the next review is due, and mark the
// document reviewed. Content edits reset the clock automatically. The server
// page owns the formatted dates; actions here just call the API and refresh.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, LoaderCircle } from "lucide-react";

const INTERVAL_LABEL: Record<number, string> = {
  30: "Every month",
  60: "Every 2 months",
  90: "Every quarter",
  180: "Every 6 months",
  365: "Every year",
};

export function ReviewSchedule({
  docId,
  intervals,
  interval,
  overdue,
  dueDateLabel,
  lastReviewedLabel,
  isPublished,
}: {
  docId: number;
  intervals: number[];
  interval: number | null;
  overdue: boolean;
  /** Server-formatted due date (workspace date format), "" when no schedule. */
  dueDateLabel: string;
  /** Server-formatted "Last reviewed …" line ("" = never). */
  lastReviewedLabel: string;
  isPublished: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function call(init: RequestInit) {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/documents/${docId}/review`, init);
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || "Could not update.");
      return;
    }
    router.refresh();
  }

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">
        <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Review schedule
      </h2>
      <select
        value={interval ?? ""}
        onChange={(e) =>
          call({
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              interval_days: e.target.value ? Number(e.target.value) : null,
            }),
          })
        }
        disabled={busy}
        aria-label="Review cadence"
        className="w-full rounded-lg border border-slate-200 bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-compass-400 disabled:opacity-60"
      >
        <option value="">No review schedule</option>
        {intervals.map((d) => (
          <option key={d} value={d}>
            {INTERVAL_LABEL[d] ?? `Every ${d} days`}
          </option>
        ))}
      </select>
      {interval !== null && (
        <div className="mt-2 space-y-1.5 text-xs">
          {!isPublished ? (
            <p className="text-slate-400">Reminders start once the document is published.</p>
          ) : (
            <p className={overdue ? "font-medium text-amber-700" : "text-slate-500"}>
              {overdue ? "Review overdue — was due " : "Next review due "}
              {dueDateLabel}.
            </p>
          )}
          {lastReviewedLabel && <p className="text-slate-400">{lastReviewedLabel}</p>}
          <button
            onClick={() => call({ method: "POST" })}
            disabled={busy}
            className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            {busy && <LoaderCircle className="h-3 w-3 animate-spin" />}
            Mark as reviewed
          </button>
          <p className="text-slate-400">Editing the document also resets the clock.</p>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </section>
  );
}
