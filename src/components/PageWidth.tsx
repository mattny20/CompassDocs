"use client";

// Reader-selectable page width for document pages: Normal (comfortable
// reading measure), Wide, or Full. The choice is a personal preference, so it
// lives in localStorage — not on the document — and applies immediately.

import { useEffect, useState } from "react";

type Width = "normal" | "wide" | "full";

const WIDTH_CLASS: Record<Width, string> = {
  normal: "max-w-3xl",
  wide: "max-w-5xl",
  full: "max-w-none",
};
const OPTIONS: { value: Width; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];
const KEY = "compass-page-width";

export function PageWidth({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = useState<Width>("normal");

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    if (stored === "wide" || stored === "full") setWidth(stored);
  }, []);

  function pick(w: Width) {
    setWidth(w);
    try {
      localStorage.setItem(KEY, w);
    } catch {
      /* private mode */
    }
  }

  return (
    <div className={`mx-auto px-8 py-8 ${WIDTH_CLASS[width]}`}>
      <div className="mb-2 flex justify-end print:hidden">
        <div
          className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-surface p-0.5"
          role="group"
          aria-label="Page width"
        >
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => pick(o.value)}
              title={`${o.label} width`}
              className={`rounded-md px-2 py-0.5 text-xs font-medium transition ${
                width === o.value
                  ? "bg-compass-50 text-compass-700"
                  : "text-slate-400 hover:bg-slate-50 hover:text-slate-600"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}
