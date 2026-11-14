// POST /api/helpdesk/admin/m365-mail/mailboxes  { address, graph_id?, confirm_tenant_wide? }
//        → 201 { mailbox: { id, address, waiting, linked, tenant_wide }, view }
// Helpdesk 1.20.7 (lib/helpdesk/m365/mail connectM365Mailbox): connect a shared or user mailbox by its main address.
// `graph_id` (optional): the mailbox's object ID or sign-in name, for one Microsoft Graph does not find by its address.
// Microsoft is asked for its Inbox first: 422 with what to use instead when the address is no mailbox (a distribution
// list, a Microsoft 365 group, a contact, another organisation's); `waiting: true` when the app may not read it yet
// (the restrict-access commands need the address first). 409 when it is already connected or nothing is set up.
// While the app's token carries Graph mail permissions granted in Entra it can read EVERY mailbox: 409 with code
// "tenant_wide" unless `confirm_tenant_wide: true` says the admin knows, and the audit entry says so.
// settings.manage: connecting a mailbox makes the desk read it. Audited (helpdesk.m365.mailbox_connected).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, readJson } from "@/lib/helpdesk/access";
import { M365MailError, connectM365Mailbox, m365MailView } from "@/lib/helpdesk/m365/mail";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 4 * 1024);
  if (!b) return badRequest("Send the mailbox's address as JSON.");
  if (hdRateLimited(`m365-connect:${gate.id}`, 20, 60_000)) return NextResponse.json({ error: "Too many tries. Try again in a minute." }, { status: 429 });
  try {
    const mailbox = await connectM365Mailbox(b.address, { actor: actorFrom(gate), ip: ipFrom(req) }, { confirmTenantWide: b.confirm_tenant_wide === true, graphId: b.graph_id });
    return NextResponse.json({ mailbox, view: await m365MailView() }, { status: 201 });
  } catch (e) {
    if (e instanceof M365MailError) return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
    throw e;
  }
}
