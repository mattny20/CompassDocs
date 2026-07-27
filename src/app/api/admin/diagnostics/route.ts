import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { runDiagnostics } from "@/lib/diagnostics";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ checks: await runDiagnostics(), at: new Date().toISOString() });
}
