"use client";

// The one correct way to be a modal in this app: Escape ownership, focus
// save/restore, an inert background, and a scroll lock — all reversible and
// reference-counted, so two overlapping overlays can't leave the page
// half-locked. Modals should use this instead of hand-rolling a keydown
// listener plus a body-overflow poke (the pattern Lightbox / VideoPlayer /
// VideoInsertDialog carry today; their migration is deferred).
//
// The scroll lock targets #main, not <body>: the app shell is
// `h-screen overflow-hidden` with `<main id="main" className="flex-1
// overflow-y-auto">`, so <main> is the scroller and <body> never scrolls —
// which is why the existing `document.body.style.overflow = "hidden"` locks
// have always been no-ops. Outside the app shell we fall back to <body>.

import { useEffect, useRef } from "react";
import { pushOverlay } from "@/lib/overlay-stack";

/**
 * Background regions taken out of the tab order, the pointer, and the
 * accessibility tree while an overlay is open.
 */
const DEFAULT_INERT_SELECTORS = ["#main", "[data-app-sidebar]"];

export interface ModalOverlayOptions {
  /**
   * The overlay's own panel. Any inert target that *contains* it is skipped,
   * so an overlay rendered inside #main doesn't make itself inert.
   */
  panelRef?: React.RefObject<HTMLElement | null>;
  /** Background regions to make inert. Defaults to #main + the app sidebar. */
  inertSelectors?: string[];
}

// Ref-counted: a nested overlay closing must not unlock the page under the one
// still open. The *stored* value is put back, never a blind "" — that is how
// the hand-rolled locks clobber each other.
let scrollLocks = 0;
let scrollTarget: HTMLElement | null = null;
let scrollPrev = "";

function lockScroll(): void {
  if (scrollLocks++ > 0) return;
  const el = document.querySelector<HTMLElement>("#main") ?? document.body;
  scrollTarget = el;
  scrollPrev = el.style.overflow;
  el.style.overflow = "hidden";
}

function unlockScroll(): void {
  if (scrollLocks === 0) return;
  if (--scrollLocks > 0) return;
  if (scrollTarget) scrollTarget.style.overflow = scrollPrev;
  scrollTarget = null;
  scrollPrev = "";
}

/**
 * Everything a modal owes the rest of the page, for as long as `open` is true:
 * a layer on the LIFO overlay stack (so Escape reaches only the top-most one),
 * an inert + aria-hidden background, a scroll lock, and focus handed back to
 * whatever opened it. Fully reversible on close and on unmount.
 */
export function useModalOverlay(open: boolean, onClose: () => void, opts?: ModalOverlayOptions): void;
/** Panel-first form, for an overlay that has to exclude itself from `inert`. */
export function useModalOverlay(
  panelRef: React.RefObject<HTMLElement | null>,
  opts: ModalOverlayOptions & { open: boolean; onClose: () => void }
): void;
export function useModalOverlay(
  a: boolean | React.RefObject<HTMLElement | null>,
  b: (() => void) | (ModalOverlayOptions & { open: boolean; onClose: () => void }),
  c: ModalOverlayOptions = {}
): void {
  const conf = typeof b === "function" ? c : b;
  const open = typeof a === "boolean" ? a : (b as { open: boolean }).open;
  const onClose = typeof b === "function" ? b : b.onClose;
  const panelRef = typeof a === "boolean" ? conf.panelRef : a;
  // A comma-joined selector list is itself a valid selector, and doubles as a
  // stable dependency for a caller-supplied array literal.
  const selectorList = (conf.inertSelectors ?? DEFAULT_INERT_SELECTORS).join(", ");

  // `onClose` is nearly always an inline arrow at the call site. Keeping it in
  // a ref means the effect below depends on `open` alone, instead of tearing
  // the whole overlay down and back up on every parent render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    // Snapshot the opener before anything below can steal or drop focus.
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef?.current ?? null;

    const hidden = Array.from(document.querySelectorAll<HTMLElement>(selectorList))
      .filter((el) => !panel || !el.contains(panel))
      .map((el) => ({
        el,
        inert: el.hasAttribute("inert"),
        ariaHidden: el.getAttribute("aria-hidden"),
      }));
    for (const h of hidden) {
      h.el.setAttribute("inert", "");
      h.el.setAttribute("aria-hidden", "true");
    }

    lockScroll();
    const popOverlay = pushOverlay(() => onCloseRef.current());

    return () => {
      popOverlay();
      unlockScroll();
      // Un-inert first: focus() on a still-inert element silently does nothing.
      for (const h of hidden) {
        if (!h.inert) h.el.removeAttribute("inert");
        if (h.ariaHidden === null) h.el.removeAttribute("aria-hidden");
        else h.el.setAttribute("aria-hidden", h.ariaHidden);
      }
      // Hand focus back only if the overlay still had it — if the user closed
      // by clicking something else, that something else keeps focus. A panel
      // that unmounted with focus inside it leaves activeElement on <body>.
      const active = document.activeElement;
      const stillOurs =
        !active || active === document.body || (panel !== null && panel.contains(active));
      if (stillOurs && opener?.isConnected && typeof opener.focus === "function") {
        opener.focus({ preventScroll: true });
      }
    };
    // panelRef is a ref object: stable for the life of the overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectorList]);
}
