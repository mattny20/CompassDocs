import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getPersonById, updatePerson, deletePerson } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readPersonBody } from "../body";

export const dynamic = "force-dynamic";

/**
 * Edit a directory entry. Manual rows take every field; synced rows take only
 * what the admin owns — hidden, pin, the manual layer, manual links (see
 * ./body.ts for the rule).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "directory.person_manage");
  if (gate instanceof NextResponse) return gate;

  const { id: idRaw } = await ctx.params;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const existing = await getPersonById(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let pinOrder = readPersonBody(body, existing.source).pin_order;
  if (pinOrder === Number.MAX_SAFE_INTEGER) {
    // "pinned: true" — append after the current last pin.
    const { pool } = await import("@/lib/db");
    const r = await pool().query<{ m: number | null }>("SELECT MAX(pin_order) AS m FROM directory_people");
    pinOrder = (r.rows[0]?.m ?? -1) + 1;
  }
  const patch = readPersonBody(body, existing.source);
  if (patch.pin_order !== undefined) patch.pin_order = pinOrder ?? null;

  const person = await updatePerson(id, patch);
  if (!person) return NextResponse.json({ error: "Not found." }, { status: 404 });

  await audit({
    actor: actorFrom(gate),
    action: "directory.person_updated",
    targetType: "directory_person",
    targetId: String(id),
    targetLabel: person.name,
    details: { keys: Object.keys(patch), source: existing.source },
    ip: ipFrom(req),
  });
  return NextResponse.json({ person });
}

/** Remove a directory entry. (Synced entries reappear on the next sync — hide those instead.) */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "directory.person_manage");
  if (gate instanceof NextResponse) return gate;

  const { id: idRaw } = await ctx.params;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const ok = await deletePerson(id);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });

  await audit({
    actor: actorFrom(gate),
    action: "directory.person_deleted",
    targetType: "directory_person",
    targetId: String(id),
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
