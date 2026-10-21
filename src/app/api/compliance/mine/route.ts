import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { listMyPolicies } from "@/lib/db";
import { teamViewAccess } from "@/lib/team-access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// My policies (B4, 1.12.0): the signed-in person's own standing on every
// policy in their scope, as the page shows it. Any role: a policy is asked
// of people, not of managers. The licence answers 402 like the rest of the
// read-confirmation API. Nothing here names anyone else; the per-person
// CSV and the history wait for the person record (F3). Since 1.13.0 (E1)
// each row carries the person's deadline (`due_at`, null without one) and
// the state union has 'overdue' (the deadline plus the policy's grace has
// passed), and the rows arrive in the page's order: overdue first, then the
// soonest deadline, then the most recently changed. Since 1.14.0 (D3) each
// row carries `set_names` (the active policy sets the policy belongs to, by
// name; [] when none) and `set_position` (its 0-based place in the first of
// them; null when none), so the page can group rows by set.
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
      // F4 (1.14.0): whether this person leads a group and /compliance/team
      // would open for them (the team page's own rule), for the lead's
      // banner on My policies ("You lead a team."); a compliance.team_read
      // holder who leads nothing has the Team tab and no banner.
      lead_team: await teamViewAccess(user.id).then((a) => a.allowed && a.leads),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
