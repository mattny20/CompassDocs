// POST /api/helpdesk/admin/m365-mail/mailboxes/[id]/retry → { retried, ok, busy?, error?, view }
// Helpdesk 1.20.7 (lib/helpdesk/m365/mail retryM365Messages): "Try again" for the messages the desk gave up on after
// the retry cap. Their count starts over and the mailbox is read at once. `retried`: how many were started over.
// channels.manage (settings.manage covers it), as Check now. Ten a minute per person. Audited when any was retried.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited } from "@/lib/helpdesk/access";
import { M365MailError, m365MailView, retryM365Messages } from "@/lib/helpdesk/m365/mail";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).id;
  if (!/^\d{1,9}$/.test(raw)) return notFound();
  if (hdRateLimited(`m365-retry:${gate.id}`, 10, 60_000)) return NextResponse.json({ error: "Too many checks. Try again in a minute." }, { status: 429 });
  try {
    const r = await retryM365Messages(Number(raw), { actor: actorFrom(gate), ip: ipFrom(req) });
    if (!r) return notFound();
    return NextResponse.json({ ...r, view: await m365MailView() });
  } catch (e) {
    if (e instanceof M365MailError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
