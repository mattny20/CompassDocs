import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { updatePerson, deletePerson } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Edit a directory entry (manual fields, or hide/show any entry). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
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

  const person = await updatePerson(id, {
    ...(body?.name !== undefined ? { name: String(body.name) } : {}),
    ...(body?.title !== undefined ? { title: String(body.title) } : {}),
    ...(body?.department !== undefined ? { department: String(body.department) } : {}),
    ...(body?.email !== undefined ? { email: String(body.email) } : {}),
    ...(body?.phone !== undefined ? { phone: String(body.phone) } : {}),
    ...(body?.mobile !== undefined ? { mobile: String(body.mobile) } : {}),
    ...(body?.office !== undefined ? { office: String(body.office) } : {}),
    ...(body?.hidden !== undefined ? { hidden: Boolean(body.hidden) } : {}),
    ...(body?.assistant_id !== undefined
      ? { assistant_id: body.assistant_id === null ? null : Number(body.assistant_id) }
      : {}),
    ...(body?.custom !== undefined && typeof body.custom === "object" ? { custom: body.custom } : {}),
  });
  if (!person) return NextResponse.json({ error: "Not found." }, { status: 404 });

  await audit({
    actor: actorFrom(gate),
    action: "directory.person_updated",
    targetType: "directory_person",
    targetId: String(id),
    targetLabel: person.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ person });
}

/** Remove a directory entry. (Graph entries reappear on the next sync — hide those instead.) */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
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
