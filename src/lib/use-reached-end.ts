"use client";

// Has the end of the article been on screen? (B5, 1.10.0.) A latch, not a
// gate: nothing is ever disabled by it. The sticky control's label flips from
// "Confirmation pending" to "Confirm now" once it is true, and C3 will later
// store it on the attestation record as the self-reported `reached_end`.
//
// Mechanics, shared with DocToc's "current heading" tracking: the app shell
// scrolls `#main`, not the window, so the scroll listener sits on the
// document in the capture phase (every scroll container reports there),
// throttled to one layout read per frame. The check runs once on mount so a
// short article counts immediately, and again on resize. Focus entering the
// confirmation section also latches, so a heading-navigation or Tab user who
// never scrolls still counts. The viewport height comes from
// `visualViewport` where it exists (a pinch-zoomed or keyboard-shortened
// phone screen), with a small slack so a bottom border on the article does
// not keep the latch open.

import { useEffect, useState } from "react";

/** The id of the end-of-document confirmation section (AckCard). */
export const CONFIRM_SECTION_ID = "confirm-reading";

/** Pixels of slack below the viewport that still count as "on screen". */
export const REACHED_END_SLACK_PX = 8;

/** The article to measure: the document body, never a nested article. */
function readingArticle(): Element | null {
  return document.querySelector("article.doc-read") ?? document.querySelector("article");
}

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

/**
 * True once the bottom of the article has been on screen (or focus has
 * entered the confirmation section). Stays true for the life of the page;
 * `enabled: false` leaves it false and registers nothing.
 */
export function useReachedEnd(enabled = true): boolean {
  const [reached, setReached] = useState(false);

  useEffect(() => {
    if (!enabled || reached) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const article = readingArticle();
      if (!article) return;
      if (article.getBoundingClientRect().bottom <= viewportHeight() + REACHED_END_SLACK_PX) {
        setReached(true);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(`#${CONFIRM_SECTION_ID}`)) setReached(true);
    };

    // Once now (layout exists after commit) and once after the first paint,
    // for images and fonts that settle a frame later.
    check();
    schedule();
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [enabled, reached]);

  return reached;
}
