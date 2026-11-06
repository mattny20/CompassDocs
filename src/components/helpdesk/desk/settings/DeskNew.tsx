"use client";

// "New" in the desk settings (Helpdesk 1.19.2, mock e2): the rail's New
// chip on the pages a release adds (lib/helpdesk/whats-new-shared), until
// the person opens the page, and the "New in 1.19.x" strip until they
// dismiss it. The settings layout reads what this person has not seen
// (lib/helpdesk/whats-new) and hands it to <DeskNewProvider>; opening a
// New page records it (POST /api/helpdesk/whats-new) and the chip goes at
// once. A failed record only means the chip shows again next time.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Sparkles, X } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { DESK_NEW_PAGES, DESK_NEW_STRIP, andList, deskNewPageFor, type DeskNewState } from "@/lib/helpdesk/whats-new-shared";

interface Ctx {
  state: DeskNewState;
  isNew(href: string): boolean;
  seen(item: string): void;
}

const DeskNewContext = createContext<Ctx | null>(null);

function record(item: string): void {
  void fetch("/api/helpdesk/whats-new", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ item }),
    keepalive: true,
  }).catch(() => {});
}

export function DeskNewProvider({ initial, children }: { initial: DeskNewState; children: React.ReactNode }) {
  const [state, setState] = useState(initial);
  const current = useRef(initial);
  const pathname = usePathname() || "";

  const seen = useCallback((item: string) => {
    const s = current.current;
    if (item === DESK_NEW_STRIP ? !s.strip : !s.unseen.includes(item)) return;
    const next = item === DESK_NEW_STRIP ? { ...s, strip: false } : { ...s, unseen: s.unseen.filter((h) => h !== item) };
    current.current = next;
    setState(next);
    record(item);
  }, []);

  // Opening a New page is what clears its chip.
  useEffect(() => {
    const page = deskNewPageFor(pathname);
    if (page) seen(page.href);
  }, [pathname, seen]);

  const value = useMemo<Ctx>(() => ({ state, isNew: (href) => state.unseen.includes(href), seen }), [state, seen]);
  return <DeskNewContext.Provider value={value}>{children}</DeskNewContext.Provider>;
}

export function useDeskNew(): Ctx | null {
  return useContext(DeskNewContext);
}

/** The violet "New" chip (STYLEGUIDE §Helpdesk: what's new). */
export function DeskNewChip() {
  return <span className={chipClass("label", "sm")}>New</span>;
}

/**
 * "New in 1.19.3: Assets.
 * The New badge goes once you've opened the page." Dismissable; shown
 * until dismissed, to people whose rail has at least one of the pages.
 */
export function DeskNewStrip({ className = "mb-4" }: { className?: string }) {
  const ctx = useDeskNew();
  if (!ctx || !ctx.state.strip) return null;
  const names = andList(DESK_NEW_PAGES.map((p) => p.label));
  return (
    <div role="note" className={`flex items-start gap-2 rounded-lg border border-compass-200 bg-compass-50 px-3 py-2.5 text-sm text-slate-800 print:hidden ${className}`}>
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
      <p className="min-w-0 flex-1">
        <b className="font-semibold text-slate-900">New in {ctx.state.release}:</b> {names}. The <DeskNewChip /> badge goes once you&apos;ve opened the page.
      </p>
      <button
        type="button"
        onClick={() => ctx.seen(DESK_NEW_STRIP)}
        aria-label={`Dismiss what's new in ${ctx.state.release}`}
        data-tt="Dismiss"
        className={`${iconButtonClass("quiet", "sm")} -my-1 -mr-1 shrink-0`}
      >
        <X aria-hidden />
      </button>
    </div>
  );
}
