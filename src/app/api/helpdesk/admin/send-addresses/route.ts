// GET  /api/helpdesk/admin/send-addresses   → { send_addresses: HdSendAddressView[], limit, mail_ready, transport_from }
//        Each: { id, address, name, last_error, last_error_at, created_at, updated_at, used_by: [{ id, address }] }.
// POST /api/helpdesk/admin/send-addresses   { address, name?: string } → 201 { send_address }.
//        400 with the form's sentence, 409 when the address is already on the list.
// Helpdesk 1.20.5 (lib/helpdesk/send-addresses): the send-from addresses on Desk settings → Email.
// The addresses replies may go out From, through the workspace mail server; each help address picks
// one (PATCH /api/helpdesk/admin/mailboxes/[id] { send_address_id }). The same desk capabilities as
// the help addresses on that page: channels.manage (settings.manage covers it). Audited
// (helpdesk.send_address.created).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { helpdeskMailReady } from "@/lib/helpdesk/email";
import { SEND_ADDRESS_LIMITS } from "@/lib/helpdesk/mailboxes-shared";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { HdSendAddressError, createSendAddress, sendAddressViews } from "@/lib/helpdesk/send-addresses";
import { getSmtpConfig } from "@/lib/smtp-config";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];

/** The workspace transport's bare From address ('' when mail isn't set up). */
async function transportFrom(): Promise<string> {
  try {
    const from = (await getSmtpConfig()).from ?? "";
    return (from.match(/<([^>]+)>/)?.[1] ?? from).trim();
  } catch {
    return "";
  }
}

export async function GET() {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const [send_addresses, mail_ready, transport_from] = await Promise.all([sendAddressViews(), helpdeskMailReady().catch(() => false), transportFrom()]);
  return NextResponse.json({ send_addresses, limit: SEND_ADDRESS_LIMITS.addresses, mail_ready, transport_from });
}

export async function POST(req: Request) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the address as JSON.");
  try {
    const send_address = await createSendAddress(b, { actor: actorFrom(gate), ip: ipFrom(req) });
    return NextResponse.json({ send_address }, { status: 201 });
  } catch (e) {
    if (e instanceof HdSendAddressError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
