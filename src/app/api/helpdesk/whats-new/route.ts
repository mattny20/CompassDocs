// POST /api/helpdesk/whats-new   { item }  → { ok: true }
// Helpdesk 1.19.2 (agent W5, lib/helpdesk/whats-new): record that the
// signed-in agent has opened one of the release's New settings pages
// (item = its path) or dismissed the release strip (item = "strip:1.19.3").
// Their own record only; an item not on the current list is a 400.

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { markDeskSeen } from "@/lib/helpdesk/whats-new";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 4 * 1024);
  if (!(await markDeskSeen(gate, body?.item))) return NextResponse.json({ error: "Nothing new by that name." }, { status: 400 });
  return NextResponse.json({ ok: true });
}
