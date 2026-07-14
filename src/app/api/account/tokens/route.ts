import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { createApiToken, listApiTokens } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ tokens: await listApiTokens((gate as SessionUser).id) });
}

export async function POST(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { token, record } = await createApiToken(user.id, String(body?.name ?? ""));
  await audit({
    actor: actorFrom(user),
    action: "account.token_created",
    details: { name: record.name },
    ip: ipFrom(req),
  });
  // The raw token appears in this response ONLY — it is never retrievable again.
  return NextResponse.json({ token, record }, { status: 201 });
}
