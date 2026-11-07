// GET  /support/api/requests   the signed-in contact's own requests.
// POST /support/api/requests   multipart { request_type_id, subject?, body?,
//        answers (JSON), name?, files* } → 201 { number }. Only a request
//        type the portal offers (exposed, needing nothing from the
//        directory); answers checked like the form; blocked words refused;
//        the portal's per-hour limit; files within the contact's quota.
// Customer portal (Helpdesk 1.19.1).

import { ipFrom } from "@/lib/audit";
import { originOf } from "@/lib/helpdesk/routes";
import { PortalRefusal, createPortalRequest, listContactRequests, portalGate, portalHumanCheck } from "@/lib/helpdesk/portal";
import { portalJson, readPortalForm, refusalResponse } from "@/lib/helpdesk/portal-http";
import { journeyRaisedRequest } from "@/lib/helpdesk/help-centre";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await portalGate(req);
  if (gate instanceof Response) return gate;
  return portalJson({ requests: await listContactRequests(gate.contact.id) });
}

export async function POST(req: Request) {
  const gate = await portalGate(req, { write: true });
  if (gate instanceof Response) return gate;
  try {
    const { fields, files } = await readPortalForm(req);
    if (!(await portalHumanCheck(req, "request", fields.human_token))) throw new PortalRefusal("Please complete the check and try again.", 403);
    let answers: unknown = {};
    if (fields.answers) {
      try {
        answers = JSON.parse(fields.answers);
      } catch {
        throw new PortalRefusal("The form could not be read. Try again.");
      }
    }
    const typeId = Number(fields.request_type_id);
    const r = await createPortalRequest(
      gate.contact,
      { request_type_id: Number.isInteger(typeId) ? typeId : 0, subject: fields.subject ?? "", body: fields.body ?? "", answers, name: fields.name, files },
      { settings: gate.settings, origin: originOf(req), ip: ipFrom(req) }
    );
    // A help centre journey (1.19.4 C3) that ends in this request is not "answered without a request".
    if (fields.j) await journeyRaisedRequest(fields.j);
    return portalJson({ number: r.number }, 201);
  } catch (e) {
    return refusalResponse(e);
  }
}
