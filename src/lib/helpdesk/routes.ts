// Helpdesk 1.19.0: small helpers the helpdesk API routes share (loading a
// ticket by its display number with the caller's relation to it, request
// body pieces, the origin for links). Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { mfaRequired } from "../api-auth";
import { canWorkTicket, deskDuoBarsTicket, ticketRelation } from "./access";
import type { TicketRelation } from "./access";
import { getTicketByNumber, parseTicketNumber } from "./tickets";
import type { HdTicket } from "./types";
import type { Role } from "../types";

export function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

/**
 * The ticket behind a route's [number] and how the caller reaches it. A
 * ticket the caller cannot see answers 404, the same as one that does not
 * exist, so numbers reveal nothing.
 */
export async function loadTicketFor(
  user: { id: number; role: Role },
  rawNumber: string,
  need: "work" | "see"
): Promise<{ ticket: HdTicket; relation: TicketRelation } | NextResponse> {
  const number = parseTicketNumber(rawNumber);
  if (!number) return notFound();
  const ticket = await getTicketByNumber(number);
  if (!ticket) return notFound();
  // 1.20.5: someone who would reach the ticket as its agent, but whose
  // session owes the desk its Duo approval, is told so (`mfa_required`)
  // rather than "not found". Their own request, an approval or a CC still
  // opens as before: canWorkTicket is what the Duo rule holds back.
  if (need === "work") {
    if (!(await canWorkTicket(user, ticket))) return (await deskDuoBarsTicket(user, ticket)) ? mfaRequired() : notFound();
    return { ticket, relation: "agent" };
  }
  const relation = await ticketRelation(user, ticket);
  if (!relation) return (await deskDuoBarsTicket(user, ticket)) ? mfaRequired() : notFound();
  return { ticket, relation };
}

/** The request's origin, for links in the notices it causes. */
export function originOf(req: Request): string {
  try {
    const h = req.headers;
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
    return host ? `${proto}://${host}` : new URL(req.url).origin;
  } catch {
    return "";
  }
}

/** A trimmed string of at most `max` characters, or null when not a string or too long. */
export function textField(v: unknown, max: number, opts: { required?: boolean } = {}): string | null {
  if (v === undefined || v === null) return opts.required ? null : "";
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length > max) return null;
  if (opts.required && !s) return null;
  return s;
}

/**
 * A source_ref from a body: only known keys, positive integer ids. Null when
 * malformed. `space_slug` (the "Request access" button on a private space
 * the person cannot open) is resolved here to `space_id` when such a space
 * exists and dropped when it does not: the caller answers the same either
 * way, so a slug reveals nothing about which spaces exist. This only
 * shapes the value: whether a requester's request may name that space at
 * all (a "Request access" type, a private space they cannot read) is
 * lib/helpdesk/space-access checkRequesterSource, which the requests route
 * applies before the ticket is written.
 */
export async function cleanSourceRef(raw: unknown): Promise<Record<string, number> | null> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "space_slug") {
      if (typeof v !== "string" || !/^[a-z0-9-]{1,100}$/.test(v)) return null;
      const { getSpaceBySlug } = await import("../db");
      const space = await getSpaceBySlug(v);
      if (space && out.space_id === undefined) out.space_id = space.id;
      continue;
    }
    if (!["doc_id", "space_id", "link_id", "handbook_id"].includes(k)) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    out[k] = n;
  }
  return out;
}
