// Admin pins: the ordered set of people shown first in the directory. One
// PUT replaces the set, so reordering is a single request.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { setPinnedPeople } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const gate = await apiGuard("admin", "directory.person_manage");
  if (gate instanceof NextResponse) return gate;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!Array.isArray(body?.ids)) return NextResponse.json({ error: "ids must be an array." }, { status: 400 });
  const ids = [...new Set(body.ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[];
  await setPinnedPeople(ids.slice(0, 50));
  await audit({ actor: actorFrom(gate), action: "directory.pins_updated", details: { ids }, ip: ipFrom(req) });
  return NextResponse.json({ ok: true, ids });
}
