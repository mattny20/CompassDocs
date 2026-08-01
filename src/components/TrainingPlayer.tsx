"use client";

// The deck player: one slide at a time, next/back (buttons + arrow keys),
// progress dots, resume position, and a final compliance gate whose
// confirmation is recorded server-side with the doc version.

import { useCallback, useEffect, useState } from "react";
import { PageContainer } from "@/components/PageWidth";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Award,
  CircleCheck,
  GraduationCap,
  ListChecks,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import { MarkdownView } from "@/components/MarkdownView";

export interface PlayerQuizQuestion {
  text: string;
  options: string[];
  multi: boolean;
}

export interface PlayerSignature {
  required: boolean;
  /** Local accounts re-enter their password; SSO accounts sign by name only. */
  passwordRequired: boolean;
  /** The name the trainee must type (their account name). */
  expectedName: string;
}

export function TrainingPlayer({
  assignmentId,
  preview = false,
  title,
  spaceName,
  slides,
  quizzes,
  passPct,
  quizScore,
  quizTotal,
  complianceText,
  initialSlide,
  completedAt,
  waived = false,
  dueAt,
  signature,
}: {
  assignmentId: number;
  /** Manager preview: nothing is recorded; quiz + confirm are disabled. */
  preview?: boolean;
  title: string;
  spaceName: string;
  slides: string[];
  /** Per-slide quiz questions (answer key stays server-side). */
  quizzes: PlayerQuizQuestion[][];
  passPct: number;
  quizScore: number | null;
  quizTotal: number | null;
  complianceText: string;
  initialSlide: number;
  completedAt: string | null;
  /** Waived completions don't earn a certificate. */
  waived?: boolean;
  dueAt: string | null;
  /** E-signature gate: typed name (+ password for local accounts). */
  signature?: PlayerSignature;
}) {
  const router = useRouter();
  // Index slides.length is the compliance gate.
  const total = slides.length + 1;
  const [idx, setIdx] = useState(Math.min(initialSlide, slides.length));
  const [done, setDone] = useState(Boolean(completedAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signatureRequired = signature?.required === true && !done;
  const [typedName, setTypedName] = useState("");
  const [signPassword, setSignPassword] = useState("");
  const signatureIncomplete =
    signatureRequired &&
    (!typedName.trim() || (signature?.passwordRequired === true && !signPassword));

  // Quiz state: answers[qi] = selected option indexes, in deck-wide question
  // order. Result comes back from the server (graded there).
  const totalQuestions = quizzes.reduce((n, qs) => n + qs.length, 0);
  const [answers, setAnswers] = useState<number[][]>(() =>
    Array.from({ length: totalQuestions }, () => [])
  );
  const [quizResult, setQuizResult] = useState<{
    score: number;
    total: number;
    passed: boolean;
    results: boolean[];
  } | null>(
    quizScore !== null && quizTotal
      ? {
          score: quizScore,
          total: quizTotal,
          passed: quizScore / quizTotal >= passPct / 100,
          results: [],
        }
      : null
  );
  const [quizBusy, setQuizBusy] = useState(false);
  // First question index of each slide (deck-wide numbering).
  const questionBase: number[] = [];
  for (let i = 0, acc = 0; i < quizzes.length; i++) {
    questionBase.push(acc);
    acc += quizzes[i].length;
  }
  const quizGateBlocked = totalQuestions > 0 && !done && !(quizResult?.passed ?? false);

  function toggleAnswer(qi: number, oi: number, multi: boolean) {
    setAnswers((prev) => {
      const next = prev.map((a) => [...a]);
      if (multi) {
        next[qi] = next[qi].includes(oi) ? next[qi].filter((x) => x !== oi) : [...next[qi], oi];
      } else {
        next[qi] = [oi];
      }
      return next;
    });
    setQuizResult((r) => (r && r.results.length ? null : r));
  }

  async function submitQuiz() {
    setQuizBusy(true);
    setError("");
    const res = await fetch(`/api/training/assignments/${assignmentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "quiz", answers }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      score?: number;
      total?: number;
      passed?: boolean;
      results?: boolean[];
    };
    if (!res.ok) setError(data.error || "Could not grade the quiz — try again.");
    else
      setQuizResult({
        score: data.score ?? 0,
        total: data.total ?? 0,
        passed: data.passed === true,
        results: data.results ?? [],
      });
    setQuizBusy(false);
  }

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(next, total - 1));
      setIdx(clamped);
      if (preview) return;
      // Fire-and-forget resume position (content slides only).
      void fetch(`/api/training/assignments/${assignmentId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "progress", slide: Math.min(clamped, slides.length) }),
      }).catch(() => {});
    },
    [assignmentId, preview, slides.length, total]
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
      body: JSON.stringify({
        action: "confirm",
        ...(signatureRequired ? { typed_name: typedName, password: signPassword } : {}),
      }),
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
    <PageContainer className="flex min-h-[calc(100vh-4rem)] flex-col">
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
          data-tt="Your place is saved — pick up where you left off any time (Esc)" aria-label="Your place is saved — pick up where you left off any time (Esc)"
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
            {preview && (
              <p className="mt-4 w-full max-w-md rounded-lg border border-slate-200 bg-canvas px-4 py-3 text-sm text-slate-500">
                Preview — nothing is recorded. Trainees answer the quiz and confirm here.
              </p>
            )}
            {totalQuestions > 0 && !done && !preview && (
              <div className="mt-4 w-full max-w-md rounded-lg border border-slate-200 bg-canvas px-4 py-3 text-sm">
                {quizResult ? (
                  <p className={quizResult.passed ? "text-emerald-600" : "text-red-600"}>
                    Quiz: {quizResult.score}/{quizResult.total} correct
                    {quizResult.passed
                      ? " — passed."
                      : ` — ${passPct}% needed. Review the slides and try again.`}
                  </p>
                ) : (
                  <p className="text-slate-500">
                    This deck has a {totalQuestions}-question quiz — answer on the slides, then
                    submit here. {passPct}% or better unlocks the confirmation.
                  </p>
                )}
                <button
                  onClick={() => void submitQuiz()}
                  disabled={quizBusy}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                >
                  {quizBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
                  {quizResult ? "Resubmit answers" : "Submit answers"}
                </button>
              </div>
            )}
            {signatureRequired && !preview && (
              <div className="mt-4 w-full max-w-md rounded-lg border border-slate-200 bg-canvas px-4 py-3 text-left text-sm">
                <p className="font-medium text-slate-700">Sign to confirm</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  Type your full name{signature?.passwordRequired ? " and re-enter your password" : ""} —
                  recorded with this confirmation.
                </p>
                <input
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  placeholder={signature?.expectedName}
                  aria-label="Type your full name to sign"
                  className="mt-2 w-full rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm outline-hidden focus:border-compass-400"
                />
                {signature?.passwordRequired && (
                  <input
                    type="password"
                    value={signPassword}
                    onChange={(e) => setSignPassword(e.target.value)}
                    placeholder="Account password"
                    aria-label="Re-enter your account password to sign"
                    autoComplete="current-password"
                    className="mt-2 w-full rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm outline-hidden focus:border-compass-400"
                  />
                )}
              </div>
            )}
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            {done ? (
              <div className="mt-4 text-sm text-slate-400">
                <p>
                  Your confirmation is recorded
                  {completedAt ? ` (${new Date(completedAt).toLocaleDateString()})` : ""}.
                </p>
                {!waived && (
                  <a
                    href={`/training/certificate/${assignmentId}`}
                    className="mt-2 inline-flex items-center gap-1.5 font-medium text-compass-600 hover:underline"
                  >
                    <Award className="h-4 w-4" /> View certificate
                  </a>
                )}
              </div>
            ) : (
              <button
                onClick={() => void confirm()}
                disabled={busy || quizGateBlocked || preview || signatureIncomplete}
                data-tt={
                  quizGateBlocked
                    ? `Pass the quiz first (${passPct}% or better)`
                    : signatureIncomplete
                      ? "Sign above to confirm"
                      : undefined
                }
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-compass-600 px-5 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                I confirm — mark complete
              </button>
            )}
          </div>
        ) : (
          <>
            <MarkdownView content={slides[idx]} docKey={`training-${assignmentId}-${idx}`} />
            {quizzes[idx]?.length > 0 && (
              <div className="mt-6 rounded-xl border border-compass-200 bg-compass-50/60 p-4 dark:bg-compass-100/20">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                  <ListChecks className="h-4 w-4 text-compass-600" /> Check your understanding
                </h3>
                <div className="mt-3 space-y-4">
                  {quizzes[idx].map((q, si) => {
                    const qi = questionBase[idx] + si;
                    const graded = quizResult?.results.length ? quizResult.results[qi] : undefined;
                    return (
                      <fieldset key={qi}>
                        <legend className="text-sm font-medium text-slate-800">
                          {q.text}
                          {graded !== undefined && (
                            <span className={`ml-2 text-xs font-semibold ${graded ? "text-emerald-600" : "text-red-600"}`}>
                              {graded ? "Correct" : "Incorrect"}
                            </span>
                          )}
                        </legend>
                        <div className="mt-1.5 space-y-1">
                          {q.options.map((opt, oi) => (
                            <label
                              key={oi}
                              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm text-slate-700 hover:bg-compass-100/60"
                            >
                              <input
                                type={q.multi ? "checkbox" : "radio"}
                                name={`q-${qi}`}
                                checked={answers[qi]?.includes(oi) ?? false}
                                onChange={() => toggleAnswer(qi, oi, q.multi)}
                                disabled={done}
                              />
                              {opt}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    );
                  })}
                </div>
              </div>
            )}
          </>
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
    </PageContainer>
  );
}
