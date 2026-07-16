import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { dismissAnnouncement } from "@/lib/db";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Personal dismiss: hides the announcement from this user's dashboard only.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  await dismissAnnouncement(Number(id), user.id);
  return NextResponse.json({ ok: true });
}
