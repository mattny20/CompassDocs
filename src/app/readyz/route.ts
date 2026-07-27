import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { logEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Readiness probe: 200 only when the app can actually serve traffic (database
 * reachable). Load balancers should route on this; orchestrators should
 * restart on /healthz.
 */
export async function GET() {
  const started = Date.now();
  try {
    await Promise.race([
      pool().query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    return NextResponse.json({ status: "ready", db_latency_ms: Date.now() - started });
  } catch (e) {
    logEvent("error", "readyz.db_unreachable", { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { status: "unavailable", reason: "database unreachable" },
      { status: 503 }
    );
  }
}
