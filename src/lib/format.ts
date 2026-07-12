import type { AppSettings, DateFormat } from "./settings";

// Render absolute timestamps according to the workspace's configured timezone
// and date/time format. All timestamps in the app are stored as ISO-8601 UTC
// strings; these helpers turn them into locale-aware display strings.

const LOCALE_FOR: Record<DateFormat, string> = {
  medium: "en-US", // Jul 12, 2026
  long: "en-US", // July 12, 2026
  iso: "en-CA", // 2026-07-12
  us: "en-US", // 07/12/2026
  eu: "en-GB", // 12/07/2026
};

function dateOptions(fmt: DateFormat): Intl.DateTimeFormatOptions {
  switch (fmt) {
    case "long":
      return { year: "numeric", month: "long", day: "numeric" };
    case "iso":
    case "us":
    case "eu":
      return { year: "numeric", month: "2-digit", day: "2-digit" };
    case "medium":
    default:
      return { year: "numeric", month: "short", day: "numeric" };
  }
}

function build(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions, fmt: DateFormat): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(LOCALE_FOR[fmt], opts).format(d);
  } catch {
    // Stored timezone became invalid — fall back to UTC rather than throw.
    return new Intl.DateTimeFormat(LOCALE_FOR[fmt], { ...opts, timeZone: "UTC" }).format(d);
  }
}

/** Format a date only, e.g. "Jul 12, 2026" (per the workspace settings). */
export function formatDate(iso: string | null | undefined, settings: AppSettings): string {
  return build(
    iso,
    { ...dateOptions(settings.date_format), timeZone: settings.timezone },
    settings.date_format
  );
}

/** Format date + time, e.g. "Jul 12, 2026, 14:05" (per the workspace settings). */
export function formatDateTime(iso: string | null | undefined, settings: AppSettings): string {
  return build(
    iso,
    {
      ...dateOptions(settings.date_format),
      hour: "numeric",
      minute: "2-digit",
      hour12: settings.time_format === "12h",
      timeZone: settings.timezone,
    },
    settings.date_format
  );
}
