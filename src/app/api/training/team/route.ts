import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { userLeadGroups, teamTrainingRows, listGroups } from "@/lib/db";
import { grantsFor, admits } from "@/lib/authz";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The team-lead scoped view: training status for the members of the groups
// this user leads.
//
// Two routes in (0.94). Leading a group is still a grant in its own right —
// that is what leadership means, and the data stays scoped to those groups. But
// `training.team_read` now also opens it, which closes the last hole the audit
// found: this was the one check in the app with NO admin path at all, so an
// administrator could not see a team view even to debug it, and no role could
// be given the capability.
export async function GET() {
  // Authentication only at the guard: the decision below is either-or, and
  // annotating it would claim the guard grants it (shadow mode caught exactly
  // that shape in 0.92).
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }

  const [groups, grants] = await Promise.all([userLeadGroups(user.id), grantsFor(user.id)]);
  const viaPermission = admits(grants, "training.team_read");
  if (!groups.length && !viaPermission) {
    return NextResponse.json({ error: "You don't lead any groups." }, { status: 403 });
  }

  // A permission holder sees every group; a lead sees theirs. Passing "all"
  // through the group filter would be a second way to express scope, so the
  // holder's view is built from the full group list instead.
  const scopeGroups = groups.length ? groups : (await listGroups()).map((g) => ({ id: g.id, name: g.name }));
  const rows = await teamTrainingRows(scopeGroups.map((g) => g.id));
  return NextResponse.json({ groups: scopeGroups, rows });
}
