import { NextResponse } from "next/server";
import pkg from "../../../package.json";

export const dynamic = "force-dynamic";

/**
 * Liveness probe: answers as long as the process is serving requests. No
 * dependencies are checked — that's /readyz — so a struggling database never
 * makes an orchestrator restart a healthy process.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    version: (pkg as { version?: string }).version || "0.0.0",
    uptime_seconds: Math.round(process.uptime()),
  });
}
