"use client";

import { useEffect } from "react";

// Invisible analytics beacon mounted on document pages. Registers one view on
// mount, then heartbeats every 15s while the tab is visible so time-on-page
// reflects real reading time (server caps at 30 minutes). Fire-and-forget:
// failures never affect the reader.

export function ViewTracker({ docId }: { docId: number }) {
  useEffect(() => {
    let viewId: number | null = null;
    let alive = true;
    const started = Date.now();

    (async () => {
      try {
        const res = await fetch("/api/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docId }),
        });
        if (res.ok && alive) viewId = (await res.json()).viewId ?? null;
      } catch {
        /* analytics must never break reading */
      }
    })();

    const beat = () => {
      if (viewId === null || document.visibilityState !== "visible") return;
      const seconds = Math.round((Date.now() - started) / 1000);
      void fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewId, seconds }),
        keepalive: true,
      }).catch(() => {});
    };
    const timer = setInterval(beat, 15_000);
    const onHide = () => {
      if (document.visibilityState === "hidden") beat();
    };
    document.addEventListener("visibilitychange", onHide);

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [docId]);

  return null;
}
