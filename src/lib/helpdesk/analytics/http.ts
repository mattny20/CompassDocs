// Helpdesk 1.19.0 reports (agent K): what the /api/helpdesk/analytics
// routes share. The gate admits anyone with a report capability
// (reports.own, reports.team or reports.all; J's desk roles) and answers
// 401 / 402 / 403 like every helpdesk route; exports also need
// tickets.export. Errors from the engine and the store keep their status
// and sentence. Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { hdAnyCapGate, hdCan } from "../roles";
import { hdRateLimited } from "../access";
import type { SessionUser } from "../../types";
import { AnalyticsError } from "./engine";
import { DashboardError } from "./store";

export const REPORT_CAPS = ["reports.own", "reports.team", "reports.all"] as const;

export function reportsGate(): Promise<SessionUser | NextResponse> {
  return hdAnyCapGate([...REPORT_CAPS]);
}

export async function canExport(user: SessionUser): Promise<boolean> {
  return hdCan(user, "tickets.export");
}

export const EXPORT_FORBIDDEN = "Exporting needs the Export tickets capability.";

/** 240 report queries a minute per person: a dashboard is ~20, refreshed every minute at most. */
export function queryLimited(userId: number): boolean {
  return hdRateLimited(`hd-analytics:${userId}`, 240, 60_000);
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof AnalyticsError || e instanceof DashboardError) return NextResponse.json({ error: e.message }, { status: e.status });
  const msg = e instanceof Error ? e.message : String(e);
  if (/statement timeout|canceling statement/i.test(msg)) {
    return NextResponse.json({ error: "That report took too long. Try a shorter range or fewer splits." }, { status: 503 });
  }
  console.error("[helpdesk.analytics]", e);
  return NextResponse.json({ error: "Couldn't run that report. Try again shortly." }, { status: 500 });
}

export function idParam(raw: string): number | null {
  const n = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;
