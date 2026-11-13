// POST /api/helpdesk/admin/m365-mail/mailboxes  { address } → 201 { mailbox: { id, address, waiting, linked }, view }
// Helpdesk 1.20.7 (lib/helpdesk/m365/mail connectM365Mailbox): connect a shared or user mailbox by its main address.
// Microsoft is asked for its Inbox first: 422 with what to use instead when the address is no mailbox (a distribution
// list, a Microsoft 365 group, a contact, another organisation's); `waiting: true` when the app may not read it yet
// (the restrict-access commands need the address first). 409 when it is already connected or nothing is set up.
// channels.manage (settings.manage covers it). Audited (helpdesk.m365.mailbox_connected).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, readJson } from "@/lib/helpdesk/access";
import { M365MailError, connectM365Mailbox, m365MailView } from "@/lib/helpdesk/m365/mail";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];

export async function POST(req: Request) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 4 * 1024);
  if (!b) return badRequest("Send the mailbox's address as JSON.");
  if (hdRateLimited(`m365-connect:${gate.id}`, 20, 60_000)) return NextResponse.json({ error: "Too many tries. Try again in a minute." }, { status: 429 });
  try {
    const mailbox = await connectM365Mailbox(b.address, { actor: actorFrom(gate), ip: ipFrom(req) });
    return NextResponse.json({ mailbox, view: await m365MailView() }, { status: 201 });
  } catch (e) {
    if (e instanceof M365MailError) return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
    throw e;
  }
}
