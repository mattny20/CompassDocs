// A preset's email schedule — what it is, when it is due, how to say it.
// Pure: the preset sanitizer and the hourly runner share it.

export const EXPORT_FREQUENCIES = ["off", "weekly", "monthly"] as const;
export type ExportFrequency = (typeof EXPORT_FREQUENCIES)[number];
export const EXPORT_FORMATS = ["pdf", "csv"] as const;

export interface ExportSchedule {
  frequency: ExportFrequency;
  /** Weekly: 0–6, Sunday first. Monthly: 1–28. */
  day: number;
  /** UTC hour, 0–23. */
  hour: number;
  recipients: string[];
  format: (typeof EXPORT_FORMATS)[number];
  /** When this schedule was set (ISO); the first send is the first slot after it. */
  since?: string;
}

export const SCHEDULE_OFF: ExportSchedule = { frequency: "off", day: 1, hour: 6, recipients: [], format: "pdf" };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function parseRecipientList(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.map(String).join(",") : String(raw ?? "");
  return [...new Set(text.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)))].slice(0, 20);
}

export function sanitizeSchedule(raw: unknown): ExportSchedule {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const frequency = (EXPORT_FREQUENCIES as readonly string[]).includes(String(o.frequency)) ? (String(o.frequency) as ExportFrequency) : "off";
  const day = Number(o.day);
  const hour = Number(o.hour);
  return {
    frequency,
    day: frequency === "weekly" ? (Number.isInteger(day) && day >= 0 && day <= 6 ? day : 1) : Number.isInteger(day) && day >= 1 && day <= 28 ? day : 1,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 6,
    recipients: parseRecipientList(o.recipients),
    format: o.format === "csv" ? "csv" : "pdf",
    ...(typeof o.since === "string" && !Number.isNaN(Date.parse(o.since)) ? { since: new Date(Date.parse(o.since)).toISOString() } : {}),
  };
}

/** The schedule with `since` stamped when it was just turned on or moved; kept when unchanged. */
export function stampSchedule(next: ExportSchedule, prev: ExportSchedule | undefined, now: Date): ExportSchedule {
  if (next.frequency === "off") return { ...next, since: undefined };
  const moved = !prev || prev.frequency !== next.frequency || prev.day !== next.day || prev.hour !== next.hour || !prev.since;
  return { ...next, since: moved ? now.toISOString() : prev.since };
}

/**
 * Due when the schedule is on, has recipients, the clock has passed its
 * day-and-hour this period, and nothing has run since that moment — the
 * last run, or the time the schedule was set, whichever is later. Missing
 * the exact hour (a restart) does not skip the period: any later hour still
 * runs it, once.
 */
export function isExportDue(s: ExportSchedule, lastAt: string | undefined, now: Date): boolean {
  if (s.frequency === "off" || s.recipients.length === 0) return false;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  // The moment this period's run becomes due.
  let due: Date;
  if (s.frequency === "weekly") {
    const back = (now.getUTCDay() - s.day + 7) % 7;
    due = new Date(Date.UTC(y, m, now.getUTCDate() - back, s.hour));
  } else {
    due = new Date(Date.UTC(y, m, s.day, s.hour));
    if (due > now) due = new Date(Date.UTC(y, m - 1, s.day, s.hour));
  }
  if (due > now) return false;
  const last = Math.max(lastAt ? Date.parse(lastAt) || 0 : 0, s.since ? Date.parse(s.since) || 0 : 0);
  return last < due.getTime();
}

/** "Every Monday at 06:00 UTC" / "On the 1st of every month at 06:00 UTC". */
export function describeSchedule(s: ExportSchedule): string {
  if (s.frequency === "off") return "Not scheduled";
  const hh = `${String(s.hour).padStart(2, "0")}:00 UTC`;
  if (s.frequency === "weekly") return `Every ${WEEKDAYS[s.day]} at ${hh}`;
  const n = s.day;
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `On the ${n}${suffix} of every month at ${hh}`;
}

export { WEEKDAYS };
