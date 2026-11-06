"use client";

// The desk's counts (GET /api/helpdesk/counts): the views' and teams'
// numbers, the headline tiles and the approvals badge. Loaded once by the
// shell and polled every minute while the tab is visible; screens that
// change a ticket call refresh() so the numbers follow at once.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { HdCounts } from "@/lib/helpdesk/types";
import { getJson } from "./api";

export const DeskCountsContext = createContext<{ counts: HdCounts | null; refresh: () => void }>({
  counts: null,
  refresh: () => {},
});

export function useDeskCounts() {
  return useContext(DeskCountsContext);
}

export function useCountsPoll(enabled: boolean) {
  const [counts, setCounts] = useState<HdCounts | null>(null);
  const refresh = useCallback(() => {
    if (!enabled) return;
    getJson<HdCounts>("/api/helpdesk/counts")
      .then((c) => setCounts(c))
      .catch(() => {
        // Counts are decoration: a failed poll keeps the last numbers.
      });
  }, [enabled]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    const onVis = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  return { counts, refresh };
}
