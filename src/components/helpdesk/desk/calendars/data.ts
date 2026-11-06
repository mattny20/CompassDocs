"use client";

// The calendars pages' data (agent L): GET /api/helpdesk/admin/calendars
// (calendars with their summaries, holiday sets, teams, the default) and the
// small formatting the pages share.

import { useCallback, useEffect, useState } from "react";
import type { HdCalendar, HdCalendarTeam, HdHolidaySet } from "@/lib/helpdesk/calendars-shared";
import { getJson } from "../api";

export type CalendarRow = HdCalendar & { summary: string };

export interface CalendarsData {
  calendars: CalendarRow[];
  holiday_sets: HdHolidaySet[];
  teams: HdCalendarTeam[];
  default_id: number | null;
}

export function useCalendarsData() {
  const [data, setData] = useState<CalendarsData | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(0);
  const reload = useCallback(async () => {
    try {
      const d = await getJson<CalendarsData>("/api/helpdesk/admin/calendars", "Couldn't load the calendars.");
      setData(d);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setStatus((e as { status?: number }).status ?? 0);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, status, reload };
}

/** "4h", "90m", "2d" (a day being 8 business hours, as Reply targets shows it). */
export function shortTarget(minutes: number): string {
  if (minutes >= 480 && minutes % 480 === 0) return `${minutes / 480}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes > 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** The calendar a team uses (its own or the default). */
export function calendarOfTeam(d: CalendarsData, teamId: number | null): CalendarRow | undefined {
  const t = teamId != null ? d.teams.find((x) => x.id === teamId) : undefined;
  const id = t?.calendar_id ?? d.default_id;
  return d.calendars.find((c) => c.id === id) ?? d.calendars.find((c) => c.is_default);
}
