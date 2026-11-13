// POST /api/helpdesk/admin/send-addresses/[id]/test   → { ok, to, from, error? }
// Helpdesk 1.20.5 (lib/helpdesk/send-addresses): "Send a test" on a send-from address (Desk
// settings → Email). One short mail to the caller's own address, From that send-from address,
// through the workspace mail server. The mail provider's refusal comes back in its own words
// (ok: false, status 200: the request worked, the provider said no). A permanent refusal of the
// address itself (lib/helpdesk/email isSenderRejection) is kept on the address (the list's
// warning line); any other failure only comes back in the answer; a test that goes through
// clears it. channels.manage (settings.manage covers it). Five a minute per person. Audited
// (helpdesk.send_address.tested).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hqOne } from "@/lib/helpdesk/db-core";
import { sendSendAddressTestMail } from "@/lib/helpdesk/email";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";
import { clearSendAddressFailure, getSendAddress, recordSendAddressFailure } from "@/lib/helpdesk/send-addresses";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];
type Ctx = { params: Promise<{ id: string }> };

const hits = new Map<number, { count: number; resetAt: number }>();
function limited(userId: number, now = Date.now()): boolean {
  let w = hits.get(userId);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + 60_000 };
    hits.set(userId, w);
  }
  w.count++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
  return w.count > 5;
}

export async function POST(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).id;
  const sender = /^\d{1,9}$/.test(raw) ? await getSendAddress(Number(raw)) : undefined;
  if (!sender) return notFound();
  const to = (gate.email ?? "").trim();
  if (!to || !/^[^\s@<>]+@[^\s@<>]+$/.test(to)) {
    return NextResponse.json({ error: "Your account has no email address to send the test to. Add one under Account first." }, { status: 400 });
  }
  if (limited(gate.id)) return NextResponse.json({ error: "Too many tests. Try again in a minute." }, { status: 429 });
  // With no name of its own, the test carries the name of the first help address that sends from it, as its replies do.
  const user = sender.name ? undefined : await hqOne<{ name: string }>("SELECT name FROM hd_mailboxes WHERE send_address_id = $1 ORDER BY position, id LIMIT 1", [sender.id]);
  const r = await sendSendAddressTestMail(sender, to, user?.name ?? "");
  if (r.from) {
    if (r.ok) await clearSendAddressFailure(sender.id).catch(() => {});
    // Only a refusal of the address itself: a bad recipient, a timeout or a "try again" says nothing about it.
    else if (r.error && r.senderRejected) await recordSendAddressFailure(sender.id, r.error).catch(() => {});
  }
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.send_address.tested",
    targetType: "helpdesk_send_address",
    targetId: sender.id,
    targetLabel: sender.address,
    details: { address: sender.address, result: r.ok ? "sent" : "refused", ...(r.error ? { error: r.error } : {}) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: r.ok, to, from: r.from, ...(r.error ? { error: r.error } : {}) });
}
