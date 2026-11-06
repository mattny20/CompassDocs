"use client";

// Major incidents in the desk (1.19.2, agent W1): the client side's data.
// One GET per ticket feeds the pane's banner, the incident cards and the
// side cards (a small shared cache, so the three mount without three
// requests); any change dispatches "hd-incidents-changed", which reloads
// them, the queue's "Major incidents" group and the list.

import { useCallback, useEffect, useRef, useState } from "react";
import type { IncidentForTicket, IncidentNavItem } from "@/lib/helpdesk/incidents-shared";
import { getJson } from "../api";

export const INCIDENTS_CHANGED = "hd-incidents-changed";

const cache = new Map<number, { at: number; key: unknown; p: Promise<IncidentForTicket> }>();

/** Tell every incident view (and the queue) to reload. */
export function incidentsChanged(): void {
  // A read started before the change must never answer for after it.
  cache.clear();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(INCIDENTS_CHANGED));
}

/**
 * One request serves every view of the ticket. A view reading for a version
 * of the ticket (`key`, its updated_at) reuses a read for that same version
 * started in the last `maxAge` ms; `anyKey` (a view without a version, or a
 * reload after incidentsChanged emptied the cache) takes any recent one.
 * The reuse is never across a change: incidentsChanged() empties the cache
 * and a new version of the ticket has a new key. (A fast server used to
 * answer the change inside the reuse window, and the views kept the state
 * from before it: a posted update or a link that never showed.)
 */
function load(number: number, key: unknown, maxAge: number, anyKey: boolean): Promise<IncidentForTicket> {
  const hit = cache.get(number);
  if (hit && (anyKey || hit.key === key) && Date.now() - hit.at < maxAge) return hit.p;
  const p = getJson<IncidentForTicket>(`/api/helpdesk/incidents/ticket/${number}`, "Couldn't load the incident.").catch(() => ({ role: null }) as IncidentForTicket);
  cache.set(number, { at: Date.now(), key, p });
  return p;
}

/** The ticket's incident side: its own incident, its link, or nothing (null while loading). */
export function useTicketIncident(number: number, refreshKey?: unknown): { data: IncidentForTicket | null; reload: () => void } {
  const [data, setData] = useState<IncidentForTicket | null>(null);
  const key = useRef(refreshKey);
  key.current = refreshKey;
  // The newest read wins: an older one answering late never overwrites it.
  const seq = useRef(0);
  const take = useCallback((p: Promise<IncidentForTicket>) => {
    const mine = ++seq.current;
    void p.then((d) => mine === seq.current && setData(d));
  }, []);
  const reload = useCallback(() => {
    cache.delete(number);
    take(load(number, key.current, 500, true));
  }, [number, take]);
  useEffect(() => {
    setData(null);
    take(load(number, key.current, 2_000, key.current === undefined));
    const on = () => take(load(number, key.current, 500, true));
    window.addEventListener(INCIDENTS_CHANGED, on);
    return () => {
      seq.current++;
      window.removeEventListener(INCIDENTS_CHANGED, on);
    };
  }, [number, take]);
  // The ticket itself changed (status, a message): read again, quietly.
  useEffect(() => {
    if (refreshKey === undefined) return;
    take(load(number, refreshKey, 2_000, false));
  }, [number, refreshKey, take]);
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
