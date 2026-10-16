"use client";

// Shared read-confirmation state for the document page (B1, 1.10.0). The
// pointer row in DocNotices, the sticky-bar control and the end-of-document
// card are siblings under the page, so the one thing they must agree on —
// has this reader confirmed, and which version — lives here rather than in
// any of them. The server seeds it; the card updates it after a successful
// POST; the other two only read it.
//
// The provider also owns the reached-the-end latch (B5), so one scroll
// listener serves every consumer and C3 can read the same value when it
// records `reached_end`.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { CONFIRM_SECTION_ID, useReachedEnd } from "@/lib/use-reached-end";

/** What the server knows when the page renders. */
export interface AckSeed {
  /** The reader's current confirmation, if one counts for this document. */
  ackedAt: string | null;
  ackedVersionId: number | null;
  /** 1-based version number of that confirmation ("version 12"); null when
   *  the record predates version binding. */
  ackedRev: number | null;
  /** The version readers confirm today (documents.ack_version_id, A1). */
  versionId: number | null;
  rev: number | null;
  /** Holds document.ack_submit in this space. */
  canSubmit: boolean;
}

export interface AckState extends AckSeed {
  /** Called by the card after a 200 from POST /ack. */
  setAckedAt: (at: string | null, version?: { versionId: number | null; rev: number | null }) => void;
  /** The end of the article has been on screen (or focus entered the card). */
  reachedEnd: boolean;
}

const AckContext = createContext<AckState | null>(null);

/**
 * Wraps the document page from the notice strip down. `seed` is null when
 * read confirmation does not apply to this page (unlicensed, not required,
 * a draft or a branch); consumers then render nothing.
 */
export function AckProvider({ seed, children }: { seed: AckSeed | null; children: ReactNode }) {
  const [acked, setAcked] = useState<{ at: string | null; versionId: number | null; rev: number | null }>({
    at: seed?.ackedAt ?? null,
    versionId: seed?.ackedVersionId ?? null,
    rev: seed?.ackedRev ?? null,
  });

  // A refreshed page (router.refresh after a confirm, or after a stale 409)
  // knows better than a state seeded earlier: follow the server's record.
  const seededAt = seed?.ackedAt ?? null;
  const seededVersionId = seed?.ackedVersionId ?? null;
  const seededRev = seed?.ackedRev ?? null;
  useEffect(() => {
    setAcked((prev) =>
      prev.at === seededAt && prev.versionId === seededVersionId && prev.rev === seededRev
        ? prev
        : { at: seededAt, versionId: seededVersionId, rev: seededRev }
    );
  }, [seededAt, seededVersionId, seededRev]);

  const setAckedAt = useCallback<AckState["setAckedAt"]>((at, version) => {
    setAcked({ at, versionId: version?.versionId ?? null, rev: version?.rev ?? null });
  }, []);

  const reachedEnd = useReachedEnd(Boolean(seed && seed.canSubmit && !acked.at));

  const value = useMemo<AckState | null>(
    () =>
      seed
        ? {
            ...seed,
            ackedAt: acked.at,
            ackedVersionId: acked.versionId,
            ackedRev: acked.rev,
            setAckedAt,
            reachedEnd,
          }
        : null,
    [seed, acked, setAckedAt, reachedEnd]
  );

  return <AckContext.Provider value={value}>{children}</AckContext.Provider>;
}

/** Null outside the provider or when read confirmation does not apply. */
export function useAckState(): AckState | null {
  return useContext(AckContext);
}

/**
 * Click handler for the "#confirm-reading" anchors (the pointer row and the
 * sticky control). The href is a real anchor so the jump works without JS;
 * with JS it scrolls smoothly unless the person prefers reduced motion, then
 * moves focus to the section so the next Tab lands on the confirm button and
 * screen readers announce where they are. Leaves the browser's own anchor
 * behaviour alone when the section is not on the page.
 */
export function jumpToConfirmation(e: MouseEvent<HTMLAnchorElement>): void {
  const target = document.getElementById(CONFIRM_SECTION_ID);
  if (!target) return;
  e.preventDefault();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
}
