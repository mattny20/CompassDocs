"use client";

// Shared toast notifications: fixed bottom-right, auto-dismiss, ok/error
// styling — the one way action feedback is shown app-wide (STYLEGUIDE.md
// "Feedback"). A single <ToastHost /> mounts in the app layout; any client
// component calls toast("ok" | "error", text) — no prop plumbing, and
// multiple panels on one page can't stack competing containers.
//
// Two live regions are always in the DOM — a polite status region for
// successes and an assertive alert region for errors — so the first toast
// is an *update* readers hear, not a region that appears with its text
// already inside (which most screen readers skip). Timers pause while the
// pointer is over a toast; errors stay longer.

import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  kind: "ok" | "error";
  text: string;
  /** One button ("Undo") — the toast stays a little longer when it has one. */
  action?: ToastAction;
  ttl?: number;
}

let toastSeq = 1;
const EVENT = "cdc:toast";
const TTL: Record<Toast["kind"], number> = { ok: 7000, error: 12000 };

/** Show a toast from anywhere client-side. */
export function toast(
  kind: "ok" | "error",
  text: string,
  opts: { action?: ToastAction; ttl?: number } = {}
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(EVENT, { detail: { id: toastSeq++, kind, text, action: opts.action, ttl: opts.ttl } })
  );
}

/** Mounted once in the (app) layout. */
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, { handle: ReturnType<typeof setTimeout>; due: number; left: number }>());

  function dismiss(id: number) {
    const t = timers.current.get(id);
    if (t) clearTimeout(t.handle);
    timers.current.delete(id);
    setToasts((ts) => ts.filter((x) => x.id !== id));
  }
  function arm(id: number, ms: number) {
    const handle = setTimeout(() => dismiss(id), ms);
    timers.current.set(id, { handle, due: Date.now() + ms, left: ms });
  }
  function pause(id: number) {
    const t = timers.current.get(id);
    if (!t) return;
    clearTimeout(t.handle);
    t.left = Math.max(1000, t.due - Date.now());
  }
  function resume(id: number) {
    const t = timers.current.get(id);
    if (t) arm(id, t.left);
  }

  useEffect(() => {
    const onToast = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setToasts((ts) => [...ts.slice(-3), t]);
      arm(t.id, t.ttl ?? (t.action ? 10000 : TTL[t.kind]));
    };
    window.addEventListener(EVENT, onToast);
    const map = timers.current;
    return () => {
      window.removeEventListener(EVENT, onToast);
      map.forEach((t) => clearTimeout(t.handle));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ok = toasts.filter((t) => t.kind === "ok");
  const errors = toasts.filter((t) => t.kind === "error");

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2 print:hidden">
      <div role="status" aria-live="polite" aria-atomic="false" className="contents">
        {ok.map((t) => (
          <ToastCard key={t.id} t={t} onDismiss={dismiss} onPause={pause} onResume={resume} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="false" className="contents">
        {errors.map((t) => (
          <ToastCard key={t.id} t={t} onDismiss={dismiss} onPause={pause} onResume={resume} />
        ))}
      </div>
    </div>
  );
}

function ToastCard({
  t,
  onDismiss,
  onPause,
  onResume,
}: {
  t: Toast;
  onDismiss: (id: number) => void;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
}) {
  const ok = t.kind === "ok";
  return (
    <div
      onMouseEnter={() => onPause(t.id)}
      onMouseLeave={() => onResume(t.id)}
      className={`pointer-events-auto flex items-start gap-2 rounded-lg border py-2 pl-3 pr-1.5 text-sm shadow-float ${
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/70 dark:text-emerald-200"
          : "border-red-200 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-950/70 dark:text-red-200"
      }`}
    >
      {ok ? (
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      ) : (
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 py-0.5">{t.text}</span>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action!.onClick();
            onDismiss(t.id);
          }}
          className="-my-0.5 inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs font-semibold underline-offset-2 transition hover:bg-black/5 hover:underline dark:hover:bg-white/10"
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(t.id)}
        aria-label="Dismiss"
        data-tt="Dismiss"
        className="-my-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
