// PUT /api/helpdesk/admin/m365-mail/addresses/[id]  { m365_mailbox_id: number | null, send_via?: boolean } → { link, view }
// Helpdesk 1.20.7 (lib/helpdesk/m365/mail setM365AddressLink): which connected Microsoft 365 mailbox the help address
// [id] (hd_mailboxes) lives on (null = none: it is forwarded to the inbound webhook), and whether its replies go out
// through Microsoft 365 as that mailbox. Choosing that clears a picked send-from address. 404 when the help address
// is gone, 409 when the mailbox is no longer connected. channels.manage (settings.manage covers it). Audited
// (helpdesk.m365.address_changed).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { HdMailboxError } from "@/lib/helpdesk/mailboxes";
import { M365MailError, m365MailView, setM365AddressLink } from "@/lib/helpdesk/m365/mail";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { badRequest, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];
type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).id;
  if (!/^\d{1,9}$/.test(raw)) return notFound();
  const b = await readJson(req, 4 * 1024);
  if (!b) return badRequest("Send the choice as JSON.");
  try {
    const link = await setM365AddressLink(Number(raw), b, { actor: actorFrom(gate), ip: ipFrom(req) });
    return NextResponse.json({ link, view: await m365MailView() });
  } catch (e) {
    if (e instanceof M365MailError || e instanceof HdMailboxError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
