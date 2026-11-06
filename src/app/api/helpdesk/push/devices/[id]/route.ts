// PATCH  /api/helpdesk/push/devices/[id]  rename { label }
// DELETE /api/helpdesk/push/devices/[id]  remove (stops push to it)
// Only the agent's own devices (Helpdesk 1.19.0).

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { cleanLabel, renamePushDevice, unsubscribePush } from "@/lib/helpdesk/push";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function deviceId(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const id = deviceId((await ctx.params).id);
  if (id === null) return NextResponse.json({ error: "Device not found." }, { status: 404 });
  const body = await readJson<{ label?: unknown }>(req, 4 * 1024);
  if (!body || typeof body.label !== "string") return NextResponse.json({ error: "Send the device's new name." }, { status: 400 });
  if (body.label.length > 60) return NextResponse.json({ error: "Name the device in 60 characters or fewer." }, { status: 400 });
  if (!cleanLabel(body.label)) return NextResponse.json({ error: "Give the device a name." }, { status: 400 });
  const device = await renamePushDevice(gate.id, id, body.label);
  if (!device) return NextResponse.json({ error: "Device not found." }, { status: 404 });
  return NextResponse.json({ device });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const id = deviceId((await ctx.params).id);
  if (id === null || !(await unsubscribePush(gate.id, { id }))) {
    return NextResponse.json({ error: "Device not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
