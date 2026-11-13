// PATCH  /api/helpdesk/admin/send-addresses/[id]   { address?, name? } → { send_address }
//          The help addresses that picked it keep it. `name: ""` (or null) = no name of its own:
//          replies then carry the help address's name.
// DELETE /api/helpdesk/admin/send-addresses/[id]   → { ok, released: [{ id, address }] }
//          The help addresses that picked it (released) go back to the workspace address. The page
//          asks first and names them; the API removes at once.
// Helpdesk 1.20.5 (lib/helpdesk/send-addresses). channels.manage (settings.manage covers it), as
// the help addresses. Audited (helpdesk.send_address.updated with the changed fields from → to,
// helpdesk.send_address.deleted with the help addresses released).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { HdSendAddressError, deleteSendAddress, updateSendAddress } from "@/lib/helpdesk/send-addresses";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];
type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the changes as JSON.");
  try {
    const send_address = await updateSendAddress(id, b, { actor: actorFrom(gate), ip: ipFrom(req) });
    if (!send_address) return notFound();
    return NextResponse.json({ send_address });
  } catch (e) {
    if (e instanceof HdSendAddressError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const r = await deleteSendAddress(id, { actor: actorFrom(gate), ip: ipFrom(req) });
  if (!r) return notFound();
  return NextResponse.json({ ok: true, released: r.released });
}
