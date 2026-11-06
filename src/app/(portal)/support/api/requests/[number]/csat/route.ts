// POST /support/api/requests/[number]/csat   { rating: "good"|"ok"|"not_good", comment?, token? }
//   The contact rates their own solved request, once (Helpdesk 1.19.2,
//   lib/helpdesk/portal-csat): the same data Get help's survey writes.
//   `token` is the one in the solved email's rating link; a wrong one is
//   refused, none is fine. → 200 { csat: { rating, comment, at } }.
// Customer portal.

import { contactTicket, portalGate, portalNotFound } from "@/lib/helpdesk/portal";
import { submitPortalCsat } from "@/lib/helpdesk/portal-csat";
import { portalJson, portalNumber, readSmallJson } from "@/lib/helpdesk/portal-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await portalGate(req, { write: true });
  if (gate instanceof Response) return gate;
  const n = portalNumber((await params).number);
  const t = n ? await contactTicket(gate.contact.id, n) : undefined;
  if (!t) return portalNotFound();
  const b = await readSmallJson(req, 16 * 1024);
  if (!b) return portalJson({ error: "Send the rating as JSON." }, 400);
  const r = await submitPortalCsat(gate.contact, t.id, { rating: b.rating, comment: b.comment, token: b.token });
  if (!r.ok) return portalJson({ error: r.error }, r.status);
  return portalJson({ csat: { rating: r.rating, comment: r.comment, at: r.at } });
}
