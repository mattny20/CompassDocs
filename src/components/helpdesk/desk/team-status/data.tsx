"use client";

// Status page services per team on the desk (1.19.2, agent W6; mock-ups s1
// and s3). One provider in DeskShell polls GET /api/helpdesk/team-status
// every minute while the tab is visible (and at once when it comes back),
// and shares the answer with the top-bar pill, the pop-ups and the team
// queue's banner, so the desk asks once. It also owns the "Declare major
// incident" dialog started from a service: W1's DeclareIncidentDialog,
// prefilled from GET /api/helpdesk/team-status/declare.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DeclarePrefill, SeenAction, TeamStatusView } from "@/lib/helpdesk/status-teams-shared";
import { toast } from "@/components/Toasts";
import { getJson, sendJson } from "../api";
import { DeclareIncidentDialog } from "../incidents/DeclareIncidentDialog";

export { useClock } from "./clock";

interface Ctx {
  view: TeamStatusView | null;
  refresh: () => void;
  /** Remember a dismissal ("one pop-up per person"), a hidden banner or "Not now"; the item goes at once. */
  mark: (action: SeenAction, ids: { episode_id?: number; incident_id?: number; until?: string }) => void;
  /** Open W1's declare dialog prefilled from a service, for a team (a pop-up's episode is dismissed once declared). */
  declare: (serviceId: number, teamId: number, episodeId?: number) => void;
  /** The top-bar popover (the pop-up's "View details" opens it). */
  pillOpen: boolean;
  setPillOpen: (open: boolean) => void;
}

const TeamStatusContext = createContext<Ctx>({
  view: null,
  refresh: () => {},
  mark: () => {},
  declare: () => {},
  pillOpen: false,
  setPillOpen: () => {},
});

export const useTeamStatus = () => useContext(TeamStatusContext);

/** The end of the viewer's day, for "Hide for today". */
export function endOfToday(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export function TeamStatusProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [view, setView] = useState<TeamStatusView | null>(null);
  const [pillOpen, setPillOpen] = useState(false);
  const [prefill, setPrefill] = useState<(DeclarePrefill & { episode_id?: number }) | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) return;
    getJson<TeamStatusView>("/api/helpdesk/team-status")
      .then((v) => {
        setView(v);
        // The poll started a sync in the background: its result is a few seconds away.
        if (v.syncing) setTimeout(() => document.visibilityState === "visible" && refresh(), 4_000);
      })
      .catch(() => {
        // Decoration: a failed poll keeps the last answer; the next one catches up.
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

  const mark = useCallback<Ctx["mark"]>((action, ids) => {
    setView((v) => {
      if (!v) return v;
      if (action === "dismiss_ask") return { ...v, asks: v.asks.filter((a) => a.incident_id !== ids.incident_id) };
      if (action === "hide_banner") return { ...v, banners: v.banners.filter((b) => b.episode_id !== ids.episode_id) };
      const kind = action === "dismiss" ? "down" : "recovered";
      return { ...v, popups: v.popups.filter((p) => !(p.episode_id === ids.episode_id && p.kind === kind)) };
    });
    sendJson("/api/helpdesk/team-status", "POST", { action, ...ids }, "Couldn't remember that. It may show again.").catch((e: Error) => toast("error", e.message));
  }, []);

  const declare = useCallback((serviceId: number, teamId: number, episodeId?: number) => {
    getJson<DeclarePrefill>(`/api/helpdesk/team-status/declare?service=${serviceId}&team=${teamId}`, "Couldn't start the incident.")
      .then((p) => {
        setPillOpen(false);
        setPrefill({ ...p, episode_id: episodeId });
      })
      .catch((e: Error) => toast("error", e.message));
  }, []);

  const value = useMemo(() => ({ view, refresh, mark, declare, pillOpen, setPillOpen }), [view, refresh, mark, declare, pillOpen]);

  return (
    <TeamStatusContext.Provider value={value}>
      {children}
      {enabled && (
        <DeclareIncidentDialog
          open={prefill !== null}
          onClose={() => setPrefill(null)}
          tickets={[]}
          fromStatus={prefill ?? undefined}
          onDeclared={() => {
            if (prefill?.episode_id) mark("dismiss", { episode_id: prefill.episode_id });
            setPrefill(null);
            refresh();
          }}
        />
      )}
    </TeamStatusContext.Provider>
  );
}
