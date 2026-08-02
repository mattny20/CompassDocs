import { NextResponse } from "next/server";
import { rbacMigrationAudit } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

// Does the new assignment data agree with the legacy ladder it was derived
// from? Both are still live (the ladder is the enforcement path until 0.92), so
// any drift between them is a bug worth surfacing loudly rather than a
// curiosity — hence an endpoint rather than a one-off script.
export async function GET() {
  const gate = await apiGuard("admin", "system.diagnostics_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await rbacMigrationAudit());
}
