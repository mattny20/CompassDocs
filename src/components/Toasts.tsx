"use client";

// Shared toast notifications: fixed bottom-right, auto-dismiss, ok/error
// styling — the one way action feedback is shown app-wide (STYLEGUIDE.md
// "Feedback"). A single <ToastHost /> mounts in the app layout; any client
// component calls toast("ok" | "error", text) — no prop plumbing, and
// multiple panels on one page can't stack competing containers.

import { useEffect, useState } from "react";
import { X } from "lucide-react";

export interface Toast {
  id: number;
  kind: "ok" | "error";
  text: string;
}

let toastSeq = 1;
const EVENT = "cdc:toast";

/** Show a toast from anywhere client-side. */
export function toast(kind: "ok" | "error", text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id: toastSeq++, kind, text } }));
}

/** Mounted once in the (app) layout. */
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const onToast = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setToasts((ts) => [...ts.slice(-3), t]);
      setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), 6000);
    };
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${
            t.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/70"
              : "border-red-200 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-950/70"
          }`}
        >
          <span>{t.text}</span>
          <button
            onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}
            aria-label="Dismiss"
            className="opacity-60 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
