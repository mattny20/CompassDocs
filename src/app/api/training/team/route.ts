import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { userLeadGroups, teamTrainingRows } from "@/lib/db";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The team-lead scoped view: training status for the members of the groups
// this user leads. No training-section grant needed — leading a group IS the
// grant, and the data is scoped to those groups only.
export async function GET() {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  const groups = await userLeadGroups(user.id);
  if (!groups.length) {
    return NextResponse.json({ error: "You don't lead any groups." }, { status: 403 });
  }
  const rows = await teamTrainingRows(groups.map((g) => g.id));
  return NextResponse.json({ groups, rows });
}
