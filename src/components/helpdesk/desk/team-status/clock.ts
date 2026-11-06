"use client";

// Times on the desk's status pieces (1.19.2, agent W6): a clock time today,
// the house date and time otherwise, in the person's own settings.

import { useCallback } from "react";
import { useAppSettings, useFormatDate } from "@/components/SettingsProvider";

/** "10:14", or "2026-11-05, 10:14" when not today, in the person's own date and time settings. */
export function useClock(): (iso: string | null | undefined) => string {
  const s = useAppSettings();
  const fmt = useFormatDate();
  return useCallback(
    (iso) => {
      if (!iso) return "";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      const tz = s.timezone || undefined;
      const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
      const time = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: s.time_format === "12h" }).format(d);
      return day(d) === day(new Date()) ? time : fmt.dateTime(iso);
    },
    [s.timezone, s.time_format, fmt]
  );
}
