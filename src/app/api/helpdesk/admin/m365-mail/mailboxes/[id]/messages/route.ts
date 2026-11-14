// GET /api/helpdesk/admin/m365-mail/mailboxes/[id]/messages → { messages: M365MessageDiag[] }
// Helpdesk 1.20.7 (lib/helpdesk/m365/mail m365MailboxMessages): the last messages seen in one connected mailbox, for
// the settings page's "Last messages": when each arrived, the sender's domain, how the sender check went (passed,
// failed, internal, no result) with one line on what Exchange's headers said, and what became of it. Never a
// subject, an address or any content. channels.manage (settings.manage covers it). Reads only.

import { NextResponse } from "next/server";
import { m365MailboxMessages } from "@/lib/helpdesk/m365/mail";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).id;
  const messages = /^\d{1,9}$/.test(raw) ? await m365MailboxMessages(Number(raw)) : undefined;
  if (!messages) return notFound();
  return NextResponse.json({ messages });
}
