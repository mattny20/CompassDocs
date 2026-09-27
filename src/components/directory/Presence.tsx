"use client";

// Teams presence on the directory (Enterprise, 1.3.5): a dot on the avatar
// that says available, busy, in a meeting, away. One request for every
// synced person on the page, refreshed every minute while the tab is
// visible; nothing at all when the workspace has not turned it on.

import { useEffect, useRef, useState } from "react";

export type PresenceState = "available" | "busy" | "dnd" | "away" | "offline" | "unknown";
export interface PresenceEntry {
  state: PresenceState;
  activity: string;
}
export type PresenceMap = Record<number, PresenceEntry>;

const LABEL: Record<PresenceState, string> = {
  available: "Available",
  busy: "Busy",
  dnd: "Do not disturb",
  away: "Away",
  offline: "Offline",
  unknown: "Presence unknown",
};
const ACTIVITY: Record<string, string> = {
  InACall: "In a call",
  InAConferenceCall: "In a conference call",
  InAMeeting: "In a meeting",
  Presenting: "Presenting",
  UrgentInterruptionsOnly: "Urgent interruptions only",
  BeRightBack: "Be right back",
  OutOfOffice: "Out of office",
  OffWork: "Off work",
  Focusing: "Focusing",
};
const COLOR: Record<PresenceState, string> = {
  available: "bg-emerald-500",
  busy: "bg-red-500",
  dnd: "bg-red-600",
  away: "bg-amber-400",
  offline: "bg-slate-300",
  unknown: "bg-slate-300",
};

/** "In a meeting" beats "Busy"; "Available" stands alone. */
export function presenceLabel(p: PresenceEntry): string {
  const act = ACTIVITY[p.activity];
  return act && act !== LABEL[p.state] ? act : LABEL[p.state];
}

/**
 * The dot itself — absolutely positioned in the caller's `relative` wrapper,
 * which carries the label (a data-tt tooltip sets position: relative on its
 * element, so the dot cannot hold it).
 */
export function PresenceDot({ presence, size = "md", className = "" }: { presence?: PresenceEntry; size?: "sm" | "md" | "lg"; className?: string }) {
  if (!presence) return null;
  const dim = size === "lg" ? "h-4 w-4 border-[2.5px]" : size === "sm" ? "h-2.5 w-2.5 border-[1.5px]" : "h-3 w-3 border-2";
  return <span className={`absolute bottom-0 right-0 block rounded-full border-surface ${dim} ${COLOR[presence.state]} ${className}`} aria-hidden />;
}

/**
 * Presence for a set of person ids, polled while the tab is visible. Off
 * (an empty map, no requests) unless `enabled`.
 */
export function usePresence(ids: number[], enabled: boolean, intervalMs = 60_000): PresenceMap {
  const [map, setMap] = useState<PresenceMap>({});
  const key = ids.join(",");
  const failed = useRef(0);
  useEffect(() => {
    if (!enabled || !key) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch("/api/ee/directory/presence", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: key.split(",").map(Number) }),
          });
          if (res.ok) {
            const data = await res.json();
            if (!stop && data?.presence) setMap(data.presence);
            failed.current = 0;
          } else {
            failed.current++;
          }
        } catch {
          failed.current++;
        }
      }
      // Back off when the tenant keeps saying no (a missing permission), so
      // a page left open does not knock every minute.
      if (!stop && failed.current < 3) timer = setTimeout(tick, intervalMs);
    };
    tick();
    const onVisible = () => {
      if (document.visibilityState === "visible" && failed.current < 3) {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, enabled, intervalMs]);
  return map;
}

/** One person's dot beside their name on a profile — fetches its own. */
export function PresenceBadge({ personId, enabled, name }: { personId: number; enabled: boolean; name: string }) {
  const map = usePresence(enabled ? [personId] : [], enabled);
  const p = map[personId];
  if (!p) return null;
  const label = presenceLabel(p);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600" data-tt={`${name} in Teams: ${label}`}>
      <span className={`block h-2.5 w-2.5 rounded-full ${COLOR[p.state]}`} aria-hidden />
      {label}
    </span>
  );
}
