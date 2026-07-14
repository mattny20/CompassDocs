import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { deleteApiToken } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const ok = await deleteApiToken(user.id, Number(id));
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });

  await audit({
    actor: actorFrom(user),
    action: "account.token_revoked",
    details: { id: Number(id) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
