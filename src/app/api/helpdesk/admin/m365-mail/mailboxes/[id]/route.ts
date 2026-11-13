// DELETE /api/helpdesk/admin/m365-mail/mailboxes/[id] → { address, unlinked: string[], view }
// Helpdesk 1.20.7 (lib/helpdesk/m365/mail disconnectM365Mailbox): stop reading a mailbox. Its notification
// subscription is deleted at Microsoft (best effort); the help addresses that lived on it go back to the inbound
// webhook. Nothing in the mailbox is touched. channels.manage (settings.manage covers it). Audited.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { disconnectM365Mailbox, m365MailView } from "@/lib/helpdesk/m365/mail";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];
type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).id;
  const r = /^\d{1,9}$/.test(raw) ? await disconnectM365Mailbox(Number(raw), { actor: actorFrom(gate), ip: ipFrom(req) }) : undefined;
  if (!r) return notFound();
  return NextResponse.json({ ...r, view: await m365MailView() });
}
