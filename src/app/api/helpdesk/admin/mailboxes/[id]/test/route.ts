// POST /api/helpdesk/admin/mailboxes/[id]/test   → { ok, to, from, error? }
// Helpdesk 1.20.2 (lib/helpdesk/mailboxes): "Send test" on Desk settings → Email. One short
// mail to the caller's own address, sent exactly as a reply on this address would leave: From
// the send-from address it picked (1.20.5, lib/helpdesk/send-addresses), else the workspace
// address, under the name a reply carries. The mail provider's refusal comes back in its own
// words (ok: false, status 200: the request worked, the provider said no). A permanent refusal
// of the From address itself (lib/helpdesk/email isSenderRejection) is kept on the send-from
// address (the lists' warning line), any other failure only comes back in the answer; a test
// that goes through clears it. channels.manage (settings.manage covers it). Five a minute per
// person. Audited (helpdesk.mailbox.tested).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { sendMailboxTestMail } from "@/lib/helpdesk/email";
import { getMailbox } from "@/lib/helpdesk/mailboxes";
import { clearSendAddressFailure, recordSendAddressFailure } from "@/lib/helpdesk/send-addresses";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";

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
  const box = /^\d{1,9}$/.test(raw) ? await getMailbox(Number(raw)) : undefined;
  if (!box) return notFound();
  const to = (gate.email ?? "").trim();
  if (!to || !/^[^\s@<>]+@[^\s@<>]+$/.test(to)) {
    return NextResponse.json({ error: "Your account has no email address to send the test to. Add one under Account first." }, { status: 400 });
  }
  if (limited(gate.id)) return NextResponse.json({ error: "Too many tests. Try again in a minute." }, { status: 429 });
  const r = await sendMailboxTestMail(box, to);
  if (box.send_address_id && r.from) {
    if (r.ok) await clearSendAddressFailure(box.send_address_id).catch(() => {});
    // Only a refusal of the address itself: a bad recipient, a timeout or a "try again" says nothing about it.
    else if (r.error && r.senderRejected) await recordSendAddressFailure(box.send_address_id, r.error, box.address).catch(() => {});
  }
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.mailbox.tested",
    targetType: "helpdesk_mailbox",
    targetId: box.id,
    targetLabel: box.address,
    details: { address: box.address, sent_from: r.from || null, result: r.ok ? "sent" : "refused", ...(r.error ? { error: r.error } : {}) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: r.ok, to, from: r.from, ...(r.error ? { error: r.error } : {}) });
}
