"use client";

// The deck player: one slide at a time, next/back (buttons + arrow keys),
// progress dots, resume position, and a final compliance gate whose
// confirmation is recorded server-side with the doc version.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  GraduationCap,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import { MarkdownView } from "@/components/MarkdownView";

export function TrainingPlayer({
  assignmentId,
  title,
  spaceName,
  slides,
  complianceText,
  initialSlide,
  completedAt,
  dueAt,
}: {
  assignmentId: number;
  title: string;
  spaceName: string;
  slides: string[];
  complianceText: string;
  initialSlide: number;
  completedAt: string | null;
  dueAt: string | null;
}) {
  const router = useRouter();
  // Index slides.length is the compliance gate.
  const total = slides.length + 1;
  const [idx, setIdx] = useState(Math.min(initialSlide, slides.length));
  const [done, setDone] = useState(Boolean(completedAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(next, total - 1));
      setIdx(clamped);
      // Fire-and-forget resume position (content slides only).
      void fetch(`/api/training/assignments/${assignmentId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "progress", slide: Math.min(clamped, slides.length) }),
      }).catch(() => {});
    },
    [assignmentId, slides.length, total]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "ArrowRight") go(idx + 1);
      if (e.key === "ArrowLeft") go(idx - 1);
      if (e.key === "Escape") router.push("/training");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, go]);

  async function confirm() {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/training/assignments/${assignmentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm" }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Could not record your confirmation — try again.");
    } else {
      setDone(true);
    }
    setBusy(false);
  }

  const onGate = idx === slides.length;

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl flex-col px-4 py-6">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <GraduationCap className="h-3.5 w-3.5" /> Training · {spaceName}
            {dueAt && !done && <span>· due {new Date(dueAt).toLocaleDateString()}</span>}
          </div>
          <h1 className="truncate text-lg font-bold tracking-tight text-slate-900">{title}</h1>
        </div>
        <button
          onClick={() => router.push("/training")}
          title="Your place is saved — pick up where you left off any time (Esc)"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          <X className="h-4 w-4" /> {done ? "Exit" : "Save & exit"}
        </button>
      </div>

      {/* Progress dots */}
      <div className="mb-4 flex items-center gap-1.5" aria-label={`Slide ${idx + 1} of ${total}`}>
        {Array.from({ length: total }, (_, i) => (
          <button
            key={i}
            onClick={() => go(i)}
            aria-label={i === total - 1 ? "Confirmation" : `Slide ${i + 1}`}
            className={`h-1.5 flex-1 rounded-full transition ${
              i < idx ? "bg-compass-400" : i === idx ? "bg-compass-600" : "bg-slate-200"
            }`}
          />
        ))}
      </div>

      {/* Slide */}
      <div className="flex-1 rounded-xl border border-slate-200 bg-surface p-6 shadow-xs sm:p-8">
        {onGate ? (
          <div className="flex h-full flex-col items-center justify-center py-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-compass-50 text-compass-600">
              {done ? <CircleCheck className="h-6 w-6 text-emerald-500" /> : <ShieldCheck className="h-6 w-6" />}
            </span>
            <h2 className="mt-3 text-lg font-bold text-slate-900">
              {done ? "Training complete" : "One last step"}
            </h2>
            <div className="prose prose-sm mt-2 max-w-md text-slate-600 dark:prose-invert">
              <MarkdownView content={complianceText} />
            </div>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            {done ? (
              <p className="mt-4 text-sm text-slate-400">
                Your confirmation is recorded{completedAt ? ` (${new Date(completedAt).toLocaleDateString()})` : ""}.
              </p>
            ) : (
              <button
                onClick={() => void confirm()}
                disabled={busy}
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-compass-600 px-5 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                I confirm — mark complete
              </button>
            )}
          </div>
        ) : (
          <MarkdownView content={slides[idx]} docKey={`training-${assignmentId}-${idx}`} />
        )}
      </div>

      {/* Nav */}
      <div className="mt-4 flex items-center justify-between">
        <button
          onClick={() => go(idx - 1)}
          disabled={idx === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <span className="text-xs text-slate-400">
          {onGate ? "Confirmation" : `Slide ${idx + 1} of ${slides.length}`}
        </span>
        <button
          onClick={() => go(idx + 1)}
          disabled={onGate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-40"
        >
          Next <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
