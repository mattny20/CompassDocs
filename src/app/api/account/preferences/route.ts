import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { setPageWidth } from "@/lib/db";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const WIDTHS = ["normal", "wide", "full"] as const;

// Personal UI preferences (currently just the app-wide page width).
export async function PATCH(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (body?.page_width !== undefined) {
    if (!WIDTHS.includes(body.page_width)) {
      return NextResponse.json({ error: "page_width must be normal, wide, or full." }, { status: 400 });
    }
    await setPageWidth(user.id, body.page_width);
  }
  return NextResponse.json({ ok: true });
}
