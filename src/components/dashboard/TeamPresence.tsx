"use client";

// Teams presence inside the dashboard's My team tile (1.17.0, Enterprise):
// one poll for everyone the tile shows who is synced from Microsoft, through
// the directory's own hook (components/directory/Presence), shared by the
// dots and labels below. The tile renders on the server; these are the only
// client parts, and with presence off (no provider) they render nothing.

import { createContext, useContext, type ReactNode } from "react";
import { PresenceDot, presenceLabel, usePresence, type PresenceMap } from "@/components/directory/Presence";

const PresenceCtx = createContext<PresenceMap>({});

export function TeamPresence({ ids, children }: { ids: number[]; children: ReactNode }) {
  const map = usePresence(ids, ids.length > 0);
  return <PresenceCtx.Provider value={map}>{children}</PresenceCtx.Provider>;
}

/** The dot on an avatar; the caller's wrapper is `relative`. */
export function TeamPresenceDot({ personId }: { personId: number }) {
  const p = useContext(PresenceCtx)[personId];
  return <PresenceDot presence={p} size="sm" />;
}

/** "● Busy" at the end of a row. */
export function TeamPresenceLabel({ personId }: { personId: number }) {
  const p = useContext(PresenceCtx)[personId];
  if (!p) return null;
  const color =
    p.state === "available" ? "bg-emerald-500" : p.state === "busy" || p.state === "dnd" ? "bg-red-500" : p.state === "away" ? "bg-amber-400" : "bg-slate-300";
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-2xs text-slate-500">
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
      {presenceLabel(p)}
    </span>
  );
}
