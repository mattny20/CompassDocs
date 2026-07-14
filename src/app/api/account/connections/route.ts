import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listOAuthGrants, revokeOAuthGrant } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ connections: await listOAuthGrants((gate as SessionUser).id) });
}

export async function DELETE(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const clientId = new URL(req.url).searchParams.get("client_id") || "";
  const ok = await revokeOAuthGrant(user.id, clientId);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });

  await audit({
    actor: actorFrom(user),
    action: "account.oauth_revoked",
    details: { client_id: clientId },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
