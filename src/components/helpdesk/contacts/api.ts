"use client";

// Fetching contact cards (Helpdesk 1.19.0). One request per ticket for the
// stack, one per person for a hover card; a hover card that opens twice
// reads the first answer (kept for the page's life, a minute at most).

import { useEffect, useState } from "react";
import type { HdContactCard, HdTicketContacts } from "@/lib/helpdesk/contact-cards-shared";

const TTL = 60_000;
const cache = new Map<string, { at: number; p: Promise<HdContactCard | null> }>();

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { credentials: "same-origin", signal, headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status === 402 ? "The helpdesk is not included in your licence." : "Couldn't load the contact card.");
  return (await res.json()) as T;
}

export function fetchTicketContacts(ticket: number, signal?: AbortSignal): Promise<HdTicketContacts | null> {
  return getJson<HdTicketContacts>(`/api/helpdesk/contacts?ticket=${encodeURIComponent(String(ticket))}`, signal);
}

export function fetchContactCard(ticket: number, userId: number | null, email = ""): Promise<HdContactCard | null> {
  const qs = new URLSearchParams({ ticket: String(ticket) });
  if (!userId && email) qs.set("email", email);
  const url = `/api/helpdesk/contacts/${userId ?? 0}?${qs}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = getJson<{ card: HdContactCard }>(url).then((d) => d?.card ?? null);
  cache.set(url, { at: Date.now(), p });
  p.catch(() => cache.delete(url));
  return p;
}

// The ticket has two readers of the same answer since 1.20.3: the requester
// strip under the header and "Also on this ticket" in the side panel. They
// share one request per ticket and refresh key.
const shared = new Map<string, { at: number; p: Promise<HdTicketContacts | null> }>();
const SHARED_TTL = 5_000;

function sharedTicketContacts(ticket: number, refreshKey: unknown): Promise<HdTicketContacts | null> {
  const key = `${ticket}:${String(refreshKey ?? "")}`;
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < SHARED_TTL) return hit.p;
  if (shared.size > 20) shared.clear();
  const p = fetchTicketContacts(ticket);
  shared.set(key, { at: Date.now(), p });
  p.catch(() => shared.delete(key));
  return p;
}

/** The ticket's cards: `undefined` while loading, `null` when there are none to see (404). */
export function useTicketContacts(ticket: number, refreshKey?: unknown): { data: HdTicketContacts | null | undefined; error: string } {
  const [data, setData] = useState<HdTicketContacts | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    sharedTicketContacts(ticket, refreshKey)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError("");
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [ticket, refreshKey]);
  return { data, error };
}
