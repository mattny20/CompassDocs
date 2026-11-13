// GET  /api/helpdesk/admin/mailboxes   → { mailboxes: HdMailboxView[], teams: [{ id, name }], mail_ready, transport_from,
//          send_addresses: HdSendAddressView[], send_address_limit } (the last two from 1.20.5: the send-from
//          addresses the page's second list and the dialog's picker show, lib/helpdesk/send-addresses)
// POST /api/helpdesk/admin/mailboxes   { address, name, team_id?: number | null, send_address_id?: number | null,
//          send_from?: boolean, is_default?: boolean }
//        → 201 { mailbox }. 400 with the form's sentence, 409 when the address is already listed.
//          `send_address_id` / `send_from`: as on PATCH (the [id] route).
// Helpdesk 1.20.2 (lib/helpdesk/mailboxes): the help addresses on Desk settings → Email. The
// same desk capabilities as that page's other email fields: channels.manage (settings.manage
// covers it). Audited (helpdesk.mailbox.created). Saving the first address ticks the setup
// checklist's Email step for a holder of settings.manage, as saving the old single address did.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hq } from "@/lib/helpdesk/db-core";
import { helpdeskMailReady } from "@/lib/helpdesk/email";
import { HdMailboxError, createMailbox, mailboxViews } from "@/lib/helpdesk/mailboxes";
import { SEND_ADDRESS_LIMITS } from "@/lib/helpdesk/mailboxes-shared";
import { sendAddressViews } from "@/lib/helpdesk/send-addresses";
import { hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { markSetupSteps } from "@/lib/helpdesk/settings";
import { getSmtpConfig } from "@/lib/smtp-config";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];

/** The workspace transport's bare From address, for the page's "sent from" help ('' when mail isn't set up). */
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
  const [mailboxes, send_addresses, teams, mail_ready, transport_from] = await Promise.all([
    mailboxViews(),
    sendAddressViews(),
    // The dialog's team choice: names only (the Teams page needs teams.manage; this page does not).
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, id"),
    helpdeskMailReady().catch(() => false),
    transportFrom(),
  ]);
  return NextResponse.json({ mailboxes, teams, mail_ready, transport_from, send_addresses, send_address_limit: SEND_ADDRESS_LIMITS.addresses });
}

export async function POST(req: Request) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the address as JSON.");
  try {
    const mailbox = await createMailbox(b, { actor: actorFrom(gate), ip: ipFrom(req) });
    if (await hdCan(gate, "settings.manage")) await markSetupSteps(["email"]).catch(() => {});
    return NextResponse.json({ mailbox }, { status: 201 });
  } catch (e) {
    if (e instanceof HdMailboxError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
