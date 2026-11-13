// DELETE /api/helpdesk/calendar/feeds/[id] → { ok: true }
//          Revoke a calendar feed link: its owner, or anyone with settings.manage. The address stops working at
//          once. Audited (helpdesk.calendar_feed.revoked). 404 for a link that isn't there or isn't the caller's.
// 1.20.6 (lib/helpdesk/desk-calendar-feed). Agents (helpdesk.agent).

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { notFound } from "@/lib/helpdesk/routes";
import { hdCan } from "@/lib/helpdesk/roles";
import { revokeFeed } from "@/lib/helpdesk/desk-calendar-feed";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return notFound();
  const ok = await revokeFeed(gate, id, { manage: await hdCan(gate, "settings.manage"), ip: ipFrom(req) });
  return ok ? NextResponse.json({ ok: true }) : notFound();
}
