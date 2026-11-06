// GET /support/api/requests/[number]   one of the contact's own requests:
//   the public conversation only (no internal notes, no held replies, no
//   system lines), agents by first name and team. Any number that is not
//   the contact's is a 404, like one that does not exist.
// Customer portal (Helpdesk 1.19.1).

import { contactRequestDetail, portalGate, portalNotFound } from "@/lib/helpdesk/portal";
import { portalJson, portalNumber } from "@/lib/helpdesk/portal-http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await portalGate(req);
  if (gate instanceof Response) return gate;
  const n = portalNumber((await params).number);
  const detail = n ? await contactRequestDetail(gate.contact, n) : null;
  if (!detail) return portalNotFound();
  return portalJson({ request: detail });
}
