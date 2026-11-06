"use client";

// Fetching contact cards (Helpdesk 1.19.0). One request per ticket for the
// stack, one per person for a hover card; a hover card that opens twice
// reads the first answer (kept for the page's life, a minute at most).

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
