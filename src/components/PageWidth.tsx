"use client";

// App-wide page width. The preference lives on the user (Settings default:
// Wide) and is provided to every page via context: `PageContainer` wraps a
// page's content at the chosen width, and `WidthToggle` (shown on document
// pages and the account page) updates the preference for the whole app,
// persisting it to the account via the preferences API.

import { createContext, useContext, useState } from "react";
import { Segmented } from "./Segmented";

export type Width = "normal" | "wide" | "full";

// Normal and Wide are 56rem / 72rem, so they grow with the interface scale.
// Full is bounded at 112rem (about 1,790px at a 16px root, 2,016px at 18px):
// a wide, centred page rather than edge-to-edge on an ultrawide. Nothing
// changes below roughly 2,100px of viewport, where the cap is never reached.
const WIDTH_CLASS: Record<Width, string> = {
  normal: "max-w-4xl",
  wide: "max-w-6xl",
  full: "max-w-[112rem]",
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
    // data-page-width drives the document reading measure in globals.css.
    // Choosing a wider page is a request for density, so the measure widens
    // with it rather than pinning text to one number at every setting — see
    // STYLEGUIDE "Reading measure". The attribute is inert on pages that
    // render no document body.
    <div
      data-page-width={width}
      className={`mx-auto px-8 py-8 print:max-w-none ${WIDTH_CLASS[width]} ${className}`}
    >
      {children}
    </div>
  );
}

/** Compact Normal/Wide/Full switch on document pages; changes apply
 *  app-wide and persist. */
export function WidthToggle() {
  const { width, setWidth } = usePageWidth();
  return (
    <Segmented
      size="sm"
      label="Page width"
      options={OPTIONS.map((o) => ({ ...o, hint: `${o.label} width (applies everywhere)` }))}
      value={width}
      onChange={setWidth}
      className="print:hidden"
    />
  );
}

/** The account Preferences picker: the same live context, so the page
 *  re-flows as the choice is made — that is the preview. */
export function WidthPreference() {
  const { width, setWidth } = usePageWidth();
  return <Segmented label="Page width preference" options={OPTIONS} value={width} onChange={setWidth} />;
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
