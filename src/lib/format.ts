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

/** Workspace settings with a user's personal time zone / date format applied
 * on top ("auto"/empty keeps the workspace default). Pass the result to
 * formatDate/formatDateTime on user-facing pages. */
export function settingsForUser(
  settings: AppSettings,
  user?: { timezone?: string; date_format?: string } | null
): AppSettings {
  if (!user) return settings;
  const tz = (user.timezone ?? "").trim();
  const df = user.date_format ?? "auto";
  if (!tz && df === "auto") return settings;
  return {
    ...settings,
    timezone: tz || settings.timezone,
    date_format: df !== "auto" && df in LOCALE_FOR ? (df as DateFormat) : settings.date_format,
  };
}

/** Format a date only, e.g. "Jul 12, 2026" (per the workspace settings). */
export function formatDate(iso: string | null | undefined, settings: AppSettings): string {
  return build(
    iso,
    { ...dateOptions(settings.date_format), timeZone: settings.timezone },
    settings.date_format
  );
}

/** Format a calendar *bucket* key ("YYYY-MM-DD") as a short day label, e.g.
 * "Aug 1" / "08-01" / "01/08" — month + day only, no year.
 *
 * Chart buckets are calendar days, not instants: the grouping already happened
 * in the database, so re-projecting the label into another time zone would
 * mislabel the bar it sits under. This formats the bucket verbatim (pinned to
 * UTC so no shift can occur) while still honoring the workspace date format. */
export function formatDayShort(ymd: string | null | undefined, settings: AppSettings): string {
  if (!ymd) return "";
  const fmt = settings.date_format;
  const opts: Intl.DateTimeFormatOptions =
    fmt === "iso" || fmt === "us" || fmt === "eu"
      ? { month: "2-digit", day: "2-digit", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" };
  return build(`${ymd}T00:00:00Z`, opts, fmt);
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
