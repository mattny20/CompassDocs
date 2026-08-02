import { NextResponse } from "next/server";
import { listRolesWithCounts } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

// Read-only view of the role catalog. The editor lands in 0.93; this exists so
// the migration can be inspected (and asserted on) before anything depends on it.
export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ roles: await listRolesWithCounts() });
}
