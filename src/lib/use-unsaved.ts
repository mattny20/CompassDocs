"use client";

// Unsaved-work tracking (STYLEGUIDE §Forms, "Save row"). Extracted from the
// document editor, which keeps using it — so the editor's safety specs guard
// the shared code — and adopted by every settings page with a Save button.
//
// Two conditions must BOTH hold before anything warns anyone, because a
// false "you have unsaved changes" is a worse bug than the one this fixes:
//   1. `touched` — a real user-input handler called markDirty(). Nothing
//      that happens while a page mounts goes through one: loading, a lookup
//      resolving, a control re-normalising the value it was handed. Those
//      reach state by other routes, so they can never set this.
//   2. the serialised state still differs from the last clean snapshot — so
//      a no-op change, or an edit typed and then undone, is clean again.
// While still untouched the baseline *follows* the current values, so any
// programmatic settling during mount re-baselines instead of dirtying.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface UnsavedChanges {
  /** True when the user changed something and it still differs. */
  dirty: boolean;
  /** Call from user-input handlers only — never from a mount/lookup effect. */
  markDirty: () => void;
  /** Back to "nothing unsaved". `at` is the snapshot that was persisted (default: now). */
  markClean: (at?: string) => void;
  /** Ref-backed check for event handlers registered once. */
  hasUnsavedChanges: () => boolean;
}

/** Pass the serialised form state (`JSON.stringify([...fields])`). */
export function useUnsavedChanges(snapshot: string): UnsavedChanges {
  const [touched, setTouched] = useState(false);
  const touchedRef = useRef(false);
  const baselineRef = useRef(snapshot);
  const currentRef = useRef(snapshot);

  useEffect(() => {
    currentRef.current = snapshot;
    if (!touchedRef.current) baselineRef.current = snapshot;
  }, [snapshot]);

  const markDirty = useCallback(() => {
    if (touchedRef.current) return;
    touchedRef.current = true;
    setTouched(true);
  }, []);

  const markClean = useCallback((at?: string) => {
    touchedRef.current = false;
    baselineRef.current = at ?? currentRef.current;
    setTouched(false);
  }, []);

  const hasUnsavedChanges = useCallback(
    () => touchedRef.current && currentRef.current !== baselineRef.current,
    []
  );

  return { dirty: touched && snapshot !== baselineRef.current, markDirty, markClean, hasUnsavedChanges };
}

export const LEAVE_PROMPT = "You have unsaved changes. Discard them and leave?";

/**
 * Warn before work is lost. `beforeunload` covers reloads and tab closes, but
 * the way people actually lose work is clicking the sidebar — a client-side
 * route change the browser never hears about, and the App Router exposes no
 * hook for. So the click that causes it is caught, on the capture phase.
 *
 * Deliberately narrow: only a plain left-click on an in-app link, and only
 * while genuinely dirty. New-tab clicks, downloads, hash links, other
 * origins, and links inside `ignoreWithin` (an editor's own content) are
 * left alone. The prompt is the browser's own on purpose: it must work
 * even while a themed dialog is open, and the editor spec listens for it.
 */
export function useLeaveGuard(
  active: boolean,
  hasUnsavedChanges: () => boolean,
  opts: { message?: string; ignoreWithin?: RefObject<HTMLElement | null> } = {}
): void {
  const { message = LEAVE_PROMPT, ignoreWithin } = opts;

  useEffect(() => {
    if (!active) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!hasUnsavedChanges()) return;
      e.preventDefault();
      // Legacy browsers need returnValue set; the string itself is never shown.
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active, hasUnsavedChanges]);

  useEffect(() => {
    if (!active) return;
    function onClickCapture(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab/window
      const target = e.target as HTMLElement | null;
      const link = target?.closest?.("a");
      if (!link) return;
      if (link.target === "_blank" || link.hasAttribute("download")) return;
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (new URL(link.href, window.location.href).origin !== window.location.origin) return;
      if (ignoreWithin?.current?.contains(link)) return;
      if (!hasUnsavedChanges()) return;
      if (window.confirm(message)) return;
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("click", onClickCapture, true);
    return () => document.removeEventListener("click", onClickCapture, true);
  }, [active, hasUnsavedChanges, message, ignoreWithin]);
}
