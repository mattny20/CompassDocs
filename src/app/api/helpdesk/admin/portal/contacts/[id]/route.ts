// PATCH /api/helpdesk/admin/portal/contacts/[id]  { blocked: boolean } → { contact }
//   Block a customer portal contact (every browser of theirs is signed out
//   at once, unused links are spent; no sign-in, request, reply or notice
//   until unblocked; their email opens nothing) or unblock them.
// Helpdesk 1.19.1 (agent V6). Desk capability settings.manage. Audited as
// helpdesk.portal.contact_blocked / helpdesk.portal.contact_unblocked.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { setContactBlocked } from "@/lib/helpdesk/portal";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return notFound();
  const b = await readJson(req, 1024);
  if (!b || typeof b.blocked !== "boolean") return badRequest("Say whether the contact is blocked.");
  const r = await setContactBlocked(id, b.blocked);
  if (!r) return notFound();
  if (r.changed) {
    await audit({
      actor: actorFrom(gate),
      action: b.blocked ? "helpdesk.portal.contact_blocked" : "helpdesk.portal.contact_unblocked",
      targetType: "helpdesk_portal_contact",
      targetId: r.contact.id,
      targetLabel: r.contact.email,
      details: b.blocked ? { signed_out: r.signedOut } : null,
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ contact: r.contact });
}
