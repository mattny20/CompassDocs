// The caller's active sessions. Sessions are identified to the client by an
// md5 of the token (an identifier, never a credential — the raw token stays
// server-side only).

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { apiGuard } from "@/lib/api-auth";
import { SESSION_COOKIE } from "@/lib/auth";
import { listUserSessions, deleteSessionBySid, deleteOtherSessions } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

async function currentToken(): Promise<string> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? "";
}

export async function GET() {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const sessions = await listUserSessions((gate as SessionUser).id, await currentToken());
  return NextResponse.json({ sessions });
}

export async function DELETE(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const url = new URL(req.url);
  const sid = url.searchParams.get("sid");
  const others = url.searchParams.get("others") === "1";

  if (others) {
    const n = await deleteOtherSessions(user.id, await currentToken());
    await audit({
      actor: actorFrom(user),
      action: "account.sessions_revoked",
      details: { count: n },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, revoked: n });
  }

  if (!sid) return NextResponse.json({ error: "sid or others=1 required." }, { status: 400 });
  const ok = await deleteSessionBySid(user.id, sid);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(user),
    action: "account.session_revoked",
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
