import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { countGlobalUserAdmins, recoveryHolders, RECOVERY_PERMISSION } from "@/lib/authz";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

// How many active people could still restore everyone else's access. If this
// ever reads 0 the workspace is stranded, so it is worth being able to ask.
export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({
    permission: RECOVERY_PERMISSION,
    count: await countGlobalUserAdmins(pool()),
    holders: await recoveryHolders(),
  });
}
