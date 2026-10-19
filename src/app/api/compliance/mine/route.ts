import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { listMyPolicies } from "@/lib/db";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// My policies (B4, 1.12.0): the signed-in person's own standing on every
// policy in their scope, as the page shows it. Any role: a policy is asked
// of people, not of managers. The licence answers 402 like the rest of the
// read-confirmation API. Nothing here names anyone else; the per-person
// CSV and the history wait for the person record (F3). 'overdue' joins the
// state union with due dates (E1, 1.13.0).
export async function GET() {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Read confirmations are not included in your license." },
      { status: 402 }
    );
  }
  const rows = await listMyPolicies(user.id, await spaceScopeFor(user));
  return NextResponse.json(
    {
      rows,
      confirmed: rows.filter((r) => r.state === "confirmed").length,
      total: rows.length,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
