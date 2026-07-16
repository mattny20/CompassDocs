import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { createLinkCategory } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "A name is required." }, { status: 400 });

  const category = await createLinkCategory(name);
  await audit({
    actor: actorFrom(gate),
    action: "link_category.created",
    targetLabel: category.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ category });
}
