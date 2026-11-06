// Shared pieces of the calendar and holiday-set admin routes (agent L):
// the gate (desk capability sla.manage), id parsing, CalendarError → JSON,
// and the audit row. Not a route (Next serves only route.ts files).

import "server-only";
import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { CalendarError } from "@/lib/helpdesk/calendars";
import type { SessionUser } from "@/lib/types";

/** Calendars, holidays and team targets: the desk capability "SLA and business hours". */
export function calendarGate(): Promise<SessionUser | NextResponse> {
  return hdCapGate("sla.manage");
}

export function idOf(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
}

/** A thrown CalendarError as its JSON answer; anything else rethrown. */
export function calendarErrorResponse(e: unknown): NextResponse {
  if (e instanceof CalendarError) return NextResponse.json({ error: e.message }, { status: e.status });
  throw e;
}

export type CalendarAuditAction =
  | "helpdesk.calendar.created"
  | "helpdesk.calendar.updated"
  | "helpdesk.calendar.deleted"
  | "helpdesk.holiday_set.created"
  | "helpdesk.holiday_set.updated"
  | "helpdesk.holiday_set.deleted"
  | "helpdesk.team.calendar_changed"
  | "helpdesk.team.sla_updated"
  | "helpdesk.team.sla_reset";

export async function auditCalendar(
  req: Request,
  user: SessionUser,
  action: CalendarAuditAction,
  target: { type: "helpdesk_calendar" | "helpdesk_holiday_set" | "helpdesk_team"; id: number; label: string },
  details: Record<string, unknown> = {}
): Promise<void> {
  await audit({
    actor: actorFrom(user),
    action,
    targetType: target.type,
    targetId: target.id,
    targetLabel: target.label,
    details,
    ip: ipFrom(req),
  });
}
