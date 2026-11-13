import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { createApiToken, listApiTokens } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { deskDoorRefusal } from "@/lib/helpdesk/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("viewer", "account.token_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ tokens: await listApiTokens((gate as SessionUser).id) });
}

export async function POST(req: Request) {
  const gate = await apiGuard("viewer", "account.token_create");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  // 1.20.5: a token outlives the session and reaches the desk through the
  // API and the connector, where Duo is never asked. So someone with
  // desk-side access cannot mint one while their session owes the desk its
  // Duo approval. Everyone else is unaffected.
  const duo = await deskDoorRefusal(user);
  if (duo) return duo;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const scopes = Array.isArray(body?.scopes)
    ? body.scopes.map(String)
    : ["read", "write"]; // pre-scope clients (and MCP setup) keep full access
  const { token, record } = await createApiToken(user.id, String(body?.name ?? ""), scopes);
  await audit({
    actor: actorFrom(user),
    action: "account.token_created",
    details: { name: record.name, scopes: record.scopes },
    ip: ipFrom(req),
  });
  // The raw token appears in this response ONLY — it is never retrievable again.
  return NextResponse.json({ token, record }, { status: 201 });
}
