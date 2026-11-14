// POST /api/helpdesk/admin/m365-mail/mailboxes/[id]/check → { ok, busy?, error?, view }
// Helpdesk 1.20.7 (lib/helpdesk/m365/mail checkM365MailboxNow): "Check now" on a connected mailbox. Reads it at once,
// whatever the timer says, and sets up or renews its notifications. `busy`: another read of it is running. The
// request worked either way (200); `error` is the sentence the row shows. channels.manage (settings.manage covers
// it). Ten a minute per person.

import { NextResponse } from "next/server";
import { hdRateLimited } from "@/lib/helpdesk/access";
import { M365MailError, checkM365MailboxNow, m365MailView } from "@/lib/helpdesk/m365/mail";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];
type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).id;
  if (!/^\d{1,9}$/.test(raw)) return notFound();
  if (hdRateLimited(`m365-check:${gate.id}`, 10, 60_000)) return NextResponse.json({ error: "Too many checks. Try again in a minute." }, { status: 429 });
  try {
    const r = await checkM365MailboxNow(Number(raw));
    if (!r) return notFound();
    return NextResponse.json({ ...r, view: await m365MailView() });
  } catch (e) {
    if (e instanceof M365MailError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
