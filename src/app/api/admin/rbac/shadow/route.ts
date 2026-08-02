import { NextResponse } from "next/server";
import { shadowReport } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

// The porting scoreboard. Every guard that has been given a permission records
// whether the legacy ladder and the RBAC model agreed; `disagreements` must be
// zero before enforcement flips from one to the other.
export async function GET() {
  const gate = await apiGuard("admin", "role.read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await shadowReport());
}
