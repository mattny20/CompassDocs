"use client";

// App-wide page width. The preference lives on the user (Settings default:
// Wide) and is provided to every page via context: `PageContainer` wraps a
// page's content at the chosen width, and `WidthToggle` (shown on document
// pages and the account page) updates the preference for the whole app,
// persisting it to the account via the preferences API.

import { createContext, useContext, useState } from "react";

export type Width = "normal" | "wide" | "full";

const WIDTH_CLASS: Record<Width, string> = {
  normal: "max-w-4xl",
  wide: "max-w-6xl",
  full: "max-w-none",
};
const OPTIONS: { value: Width; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];

const WidthContext = createContext<{ width: Width; setWidth: (w: Width) => void }>({
  width: "wide",
  setWidth: () => {},
});

export function WidthProvider({
  initial,
  children,
}: {
  initial: Width;
  children: React.ReactNode;
}) {
  const [width, setWidthState] = useState<Width>(initial);

  function setWidth(w: Width) {
    setWidthState(w);
    // Persist to the account (fire-and-forget; the UI already updated).
    void fetch("/api/account/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_width: w }),
    }).catch(() => {});
  }

  return <WidthContext.Provider value={{ width, setWidth }}>{children}</WidthContext.Provider>;
}

export function usePageWidth() {
  return useContext(WidthContext);
}

/** The standard page wrapper: consistent padding, user-preferred width. */
export function PageContainer({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { width } = usePageWidth();
  return (
    <div className={`mx-auto px-8 py-8 print:max-w-none ${WIDTH_CLASS[width]} ${className}`}>
      {children}
    </div>
  );
}

/** Compact Normal/Wide/Full switch; changes apply app-wide and persist. */
export function WidthToggle() {
  const { width, setWidth } = usePageWidth();
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-surface p-0.5 print:hidden"
      role="group"
      aria-label="Page width"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          onClick={() => setWidth(o.value)}
          title={`${o.label} width (applies everywhere)`}
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
  );
}

/** Standalone width picker for the account page (outside the provider). */
export function WidthPreference({ initial }: { initial: Width }) {
  const [width, setWidthState] = useState<Width>(initial);
  const [saved, setSaved] = useState(false);

  async function pick(w: Width) {
    setWidthState(w);
    setSaved(false);
    const res = await fetch("/api/account/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_width: w }),
    }).catch(() => null);
    if (res?.ok) setSaved(true);
  }

  return (
    <div className="flex items-center gap-3">
      <div
        className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-surface p-0.5"
        role="group"
        aria-label="Page width preference"
      >
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => pick(o.value)}
            className={`rounded-md px-3 py-1 text-sm font-medium transition ${
              width === o.value
                ? "bg-compass-600 text-white shadow-sm"
                : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {saved && <span className="text-sm text-green-600">✓ Saved</span>}
    </div>
  );
}

/** Back-compat wrapper for the document page: container + top-right toggle. */
export function PageWidth({ children }: { children: React.ReactNode }) {
  return (
    <PageContainer>
      <div className="mb-2 flex justify-end print:hidden">
        <WidthToggle />
      </div>
      {children}
    </PageContainer>
  );
}
