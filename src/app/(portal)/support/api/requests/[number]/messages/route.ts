// POST /support/api/requests/[number]/messages   multipart { body, files* }
//   The contact's reply on their own request (public). A request waiting on
//   them, or solved, opens again; a closed one takes none (409).
//   → 201 { status }. 20 a minute per contact.
// Customer portal (Helpdesk 1.19.1).

import { originOf } from "@/lib/helpdesk/routes";
import { addPortalReply, portalGate, portalNotFound, portalReplyLimited } from "@/lib/helpdesk/portal";
import { portalJson, portalNumber, readPortalForm, refusalResponse } from "@/lib/helpdesk/portal-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await portalGate(req, { write: true });
  if (gate instanceof Response) return gate;
  const n = portalNumber((await params).number);
  if (!n) return portalNotFound();
  if (portalReplyLimited(gate.contact.id)) return portalJson({ error: "Too many replies. Wait a moment and try again." }, 429);
  try {
    const { fields, files } = await readPortalForm(req);
    const r = await addPortalReply(gate.contact, n, { body: fields.body ?? "", files }, { settings: gate.settings, origin: originOf(req) });
    return portalJson({ status: r.status }, 201);
  } catch (e) {
    return refusalResponse(e);
  }
}
