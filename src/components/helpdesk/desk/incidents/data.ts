"use client";

// Major incidents in the desk (1.19.2, agent W1): the client side's data.
// One GET per ticket feeds the pane's banner, the incident cards and the
// side cards (a small shared cache, so the three mount without three
// requests); any change dispatches "hd-incidents-changed", which reloads
// them, the queue's "Major incidents" group and the list.

import { useCallback, useEffect, useState } from "react";
import type { IncidentForTicket, IncidentNavItem } from "@/lib/helpdesk/incidents-shared";
import { getJson } from "../api";

export const INCIDENTS_CHANGED = "hd-incidents-changed";

/** Tell every incident view (and the queue) to reload. */
export function incidentsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(INCIDENTS_CHANGED));
}

const cache = new Map<number, { at: number; p: Promise<IncidentForTicket> }>();

/** One request serves every view of the ticket: a fresh read reuses one started in the last half second. */
function load(number: number, fresh: boolean): Promise<IncidentForTicket> {
  const hit = cache.get(number);
  if (hit && Date.now() - hit.at < (fresh ? 500 : 2_000)) return hit.p;
  const p = getJson<IncidentForTicket>(`/api/helpdesk/incidents/ticket/${number}`, "Couldn't load the incident.").catch(() => ({ role: null }) as IncidentForTicket);
  cache.set(number, { at: Date.now(), p });
  return p;
}

/** The ticket's incident side: its own incident, its link, or nothing (null while loading). */
export function useTicketIncident(number: number, refreshKey?: unknown): { data: IncidentForTicket | null; reload: () => void } {
  const [data, setData] = useState<IncidentForTicket | null>(null);
  const reload = useCallback(() => {
    void load(number, true).then(setData);
  }, [number]);
  useEffect(() => {
    let live = true;
    setData(null);
    void load(number, false).then((d) => live && setData(d));
    const on = () => void load(number, true).then((d) => live && setData(d));
    window.addEventListener(INCIDENTS_CHANGED, on);
    return () => {
      live = false;
      window.removeEventListener(INCIDENTS_CHANGED, on);
    };
  }, [number]);
  // The ticket itself changed (status, a message): read again, quietly.
  useEffect(() => {
    if (refreshKey === undefined) return;
    let live = true;
    void load(number, false).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [number, refreshKey]);
  return { data, reload };
}

/** Open incidents: the nav's (scope nav) or the link picker's (scope link). */
export function useOpenIncidents(scope: "nav" | "link", enabled = true): IncidentNavItem[] | null {
  const [list, setList] = useState<IncidentNavItem[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const get = () =>
      getJson<{ incidents: IncidentNavItem[] }>(`/api/helpdesk/incidents${scope === "link" ? "?scope=link" : ""}`)
        .then((d) => live && setList(d.incidents ?? []))
        .catch(() => live && setList([]));
    void get();
    window.addEventListener(INCIDENTS_CHANGED, get);
    const t = setInterval(() => document.visibilityState === "visible" && void get(), 60_000);
    return () => {
      live = false;
      window.removeEventListener(INCIDENTS_CHANGED, get);
      clearInterval(t);
    };
  }, [scope, enabled]);
  return list;
}
