// DELETE /api/helpdesk/admin/m365-mail/mailboxes/[id] → { address, unlinked: string[], view }
// PATCH  /api/helpdesk/admin/m365-mail/mailboxes/[id]  { graph_id } → { address, graph_id, view }
// Helpdesk 1.20.7 (lib/helpdesk/m365/mail). DELETE (disconnectM365Mailbox): stop reading a mailbox. Its notification
// subscription is deleted at Microsoft (best effort); the help addresses that lived on it go back to the inbound
// webhook. Nothing in the mailbox is touched. PATCH (setM365MailboxGraphId): the object ID or sign-in name Microsoft
// Graph is asked by for this mailbox ('' = by its address again); 422 when Microsoft finds no mailbox by it.
// settings.manage, as connecting one. Audited.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, readJson } from "@/lib/helpdesk/access";
import { M365MailError, disconnectM365Mailbox, m365MailView, setM365MailboxGraphId } from "@/lib/helpdesk/m365/mail";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).id;
  const r = /^\d{1,9}$/.test(raw) ? await disconnectM365Mailbox(Number(raw), { actor: actorFrom(gate), ip: ipFrom(req) }) : undefined;
  if (!r) return notFound();
  return NextResponse.json({ ...r, view: await m365MailView() });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).id;
  if (!/^\d{1,9}$/.test(raw)) return notFound();
  const b = await readJson(req, 4 * 1024);
  if (!b || typeof b.graph_id !== "string") return badRequest("Send the object ID or sign-in name as JSON.");
  if (hdRateLimited(`m365-lookup:${gate.id}`, 20, 60_000)) return NextResponse.json({ error: "Too many tries. Try again in a minute." }, { status: 429 });
  try {
    const r = await setM365MailboxGraphId(Number(raw), b.graph_id, { actor: actorFrom(gate), ip: ipFrom(req) });
    if (!r) return notFound();
    return NextResponse.json({ ...r, view: await m365MailView() });
  } catch (e) {
    if (e instanceof M365MailError) return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
    throw e;
  }
}
