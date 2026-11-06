// The holidays in a request body (agent L): { holidays: [{ date, name,
// recurring_yearly?, closed_from?, closed_to? }] } or { text } (pasted
// lines, lib/helpdesk/calendars-shared parseHolidayLines). Not a route.

import "server-only";
import { CALENDAR_LIMITS, parseHolidayLines, validateHoliday } from "@/lib/helpdesk/calendars-shared";
import type { HdHolidayInput } from "@/lib/helpdesk/calendars-shared";

export function holidaysFromBody(
  b: Record<string, unknown>
): { ok: true; holidays: HdHolidayInput[]; errors: { line: number; text: string; error: string }[] } | { ok: false; error: string } {
  if (typeof b.text === "string") {
    if (b.text.length > 200 * 1024) return { ok: false, error: "That paste is too long." };
    const r = parseHolidayLines(b.text);
    if (r.holidays.length > CALENDAR_LIMITS.holidaysPerRequest) return { ok: false, error: `Up to ${CALENDAR_LIMITS.holidaysPerRequest} holidays at a time.` };
    if (!r.holidays.length) return { ok: false, error: r.errors[0] ? `Line ${r.errors[0].line}: ${r.errors[0].error}` : "Paste one holiday per line, like 2026-12-25 Christmas Day." };
    return { ok: true, holidays: r.holidays, errors: r.errors };
  }
  if (!Array.isArray(b.holidays)) return { ok: false, error: "Send holidays: [{ date, name }] or text." };
  if (b.holidays.length > CALENDAR_LIMITS.holidaysPerRequest) return { ok: false, error: `Up to ${CALENDAR_LIMITS.holidaysPerRequest} holidays at a time.` };
  const out: HdHolidayInput[] = [];
  for (const raw of b.holidays) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "Each holiday is { date, name }." };
    const v = validateHoliday(raw as Record<string, unknown>);
    if (!v.ok) return { ok: false, error: v.error };
    out.push(v.value);
  }
  return { ok: true, holidays: out, errors: [] };
}
