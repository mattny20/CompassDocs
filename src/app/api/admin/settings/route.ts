import { NextResponse } from "next/server";
import { setSetting } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (body?.approval_mode !== undefined) {
    const mode = body.approval_mode === "open" ? "open" : "strict";
    setSetting("approval_mode", mode);
  }
  return NextResponse.json({ ok: true });
}
