import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listStatusServices, listStatusIncidents } from "@/lib/db";

export const dynamic = "force-dynamic";

// The status board's data: every tracked service plus incident timelines.
// Any signed-in user may read it — outage comms are for the whole org.
export async function GET() {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const [services, incidents] = await Promise.all([
    listStatusServices(),
    listStatusIncidents(),
  ]);
  return NextResponse.json({ services, incidents });
}
