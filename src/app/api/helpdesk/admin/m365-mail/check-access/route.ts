// POST /api/helpdesk/admin/m365-mail/check-access  { probe?: "someone@yourcompany.com" } → { access, view }
// Helpdesk 1.20.7 (lib/helpdesk/m365/mail checkM365Access): what the Microsoft 365 app can reach right now. It signs
// in afresh and reports the Graph mail permissions granted in Entra (any of them reaches every mailbox), whether each
// connected mailbox can be read, and, when `probe` names a mailbox the desk should NOT reach, whether it really is
// out of reach. channels.manage (settings.manage covers it). Ten a minute per person. Audited.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, readJson } from "@/lib/helpdesk/access";
import { M365MailError, checkM365Access, m365MailView } from "@/lib/helpdesk/m365/mail";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];

export async function POST(req: Request) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const b = (await readJson(req, 4 * 1024)) ?? {};
  if (hdRateLimited(`m365-access:${gate.id}`, 10, 60_000)) return NextResponse.json({ error: "Too many checks. Try again in a minute." }, { status: 429 });
  try {
    const access = await checkM365Access(b, { actor: actorFrom(gate), ip: ipFrom(req) });
    return NextResponse.json({ access, view: await m365MailView() });
  } catch (e) {
    if (e instanceof M365MailError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
