"use client";

// The desk's bare-key shortcuts (/, j, k, Enter, r, n, e, a). They go
// through the house guards (lib/hotkeys blockBareKey: never while typing,
// never with an overlay open, AltGr counts as typing) and the account's
// single-key preference (WCAG 2.1.4, STYLEGUIDE §Keyboard shortcuts): with
// it off none of them fires. The preference is handed down by the desk
// layout and mirrored from localStorage, as the palette does.

import { createContext, useContext, useEffect, useRef } from "react";
import { blockBareKey } from "@/lib/hotkeys";
import { overlayOpen } from "@/lib/overlay-stack";
import { readSingleKey, SINGLE_KEY_EVENT } from "@/components/palette/single-key";

export const SingleKeyContext = createContext<boolean>(true);

/** Bind bare-key shortcuts while mounted. Keys are matched on e.key. */
export function useDeskKeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true): void {
  const accountPref = useContext(SingleKeyContext);
  const mapRef = useRef(map);
  mapRef.current = map;
  const on = useRef(accountPref);

  useEffect(() => {
    on.current = readSingleKey(accountPref);
    const sync = () => (on.current = readSingleKey(accountPref));
    window.addEventListener(SINGLE_KEY_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SINGLE_KEY_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [accountPref]);

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (!on.current) return;
      const fn = mapRef.current[e.key];
      if (!fn) return;
      // Enter on a focused control is that control's own: only a bare
      // Enter on the page itself opens the queue's cursor row.
      if (e.key === "Enter" && e.target instanceof HTMLElement && e.target.closest("button, a, [role='option']")) return;
      if (blockBareKey(e, overlayOpen)) return;
      e.preventDefault();
      fn(e);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** Single-key shortcuts on? (for showing keycaps only when they work). */
export function useSingleKeyOn(): boolean {
  return useContext(SingleKeyContext);
}
