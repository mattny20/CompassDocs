import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { isDashboardSection, setHiddenDashboardSections } from "@/lib/dashboard-sections";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Edit dashboard (1.17.0): the home sections this person has switched off.
// The whole set is sent each time, so the dialog's state is what is stored.
export async function PUT(req: Request) {
  const gate = await apiGuard("viewer", "account.preferences_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const hidden = body?.hidden;
  if (!Array.isArray(hidden) || hidden.length > 50) {
    return NextResponse.json({ error: "hidden must be a list of dashboard sections." }, { status: 400 });
  }
  const unknown = hidden.find((k: unknown) => !isDashboardSection(k));
  if (unknown !== undefined) {
    return NextResponse.json({ error: `Unknown dashboard section: ${String(unknown).slice(0, 40)}` }, { status: 400 });
  }
  const stored = await setHiddenDashboardSections(user.id, hidden);
  return NextResponse.json({ ok: true, hidden: stored });
}
