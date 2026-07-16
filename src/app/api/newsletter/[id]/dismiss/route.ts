import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getNewsletter, dismissNewsletter } from "@/lib/db";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Hide a sent newsletter from this user's dashboard. Any signed-in user —
// the dashboard card shows to everyone, module access or not.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n || n.status !== "sent") {
    return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  }
  await dismissNewsletter(user.id, n.id);
  return NextResponse.json({ ok: true });
}
