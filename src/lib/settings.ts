// Appearance & workspace settings — pure types, defaults, and validators.
// This module has NO server-only imports so it is safe to import from client
// components. The DB-backed read/write helpers live in `settings-store.ts`.

export type DateFormat = "medium" | "long" | "iso" | "us" | "eu";
export type TimeFormat = "12h" | "24h";

export interface AppSettings {
  /** Displayed in the sidebar, login screen, and browser title. */
  company_name: string;
  /** Optional logo (an image URL or a data: URL). Empty → default compass mark. */
  logo_url: string;
  /** IANA timezone used to render absolute timestamps (e.g. "America/New_York"). */
  timezone: string;
  /** How calendar dates are formatted. */
  date_format: DateFormat;
  /** 12-hour (with AM/PM) or 24-hour clock. */
  time_format: TimeFormat;
  /** Idle session timeout in minutes before a signed-in user is logged out. */
  session_timeout_minutes: number;
  /** Days to keep documents in the Trash before auto-purging (0 = forever). */
  trash_retention_days: number;
  /** Automatic full-database backup cadence. */
  backup_frequency: BackupFrequency;
  /** How many local backups to keep before pruning the oldest. */
  backup_keep: number;
}

export type BackupFrequency = "off" | "daily" | "weekly";
export const BACKUP_FREQUENCIES: BackupFrequency[] = ["off", "daily", "weekly"];
export const BACKUP_KEEP_MIN = 1;
export const BACKUP_KEEP_MAX = 90;

export const SETTINGS_DEFAULTS: AppSettings = {
  company_name: "CompassDocs",
  logo_url: "",
  timezone: "UTC",
  date_format: "medium",
  time_format: "24h",
  session_timeout_minutes: 480, // 8 hours
  trash_retention_days: 30,
  backup_frequency: "off",
  backup_keep: 7,
};

export const DATE_FORMATS: DateFormat[] = ["medium", "long", "iso", "us", "eu"];

export const DATE_FORMAT_LABEL: Record<DateFormat, string> = {
  medium: "Jul 12, 2026 (medium)",
  long: "July 12, 2026 (long)",
  iso: "2026-07-12 (ISO)",
  us: "07/12/2026 (US)",
  eu: "12/07/2026 (European)",
};

export const SESSION_TIMEOUT_MIN = 5;
export const SESSION_TIMEOUT_MAX = 43200; // 30 days

export const TRASH_RETENTION_MIN = 0; // 0 = keep forever
export const TRASH_RETENTION_MAX = 3650; // 10 years

export const LOGO_MAX_LEN = 500_000; // generous, allows a small embedded data: URL

/** True if `tz` is an IANA timezone the runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function clampTimeout(n: number): number {
  if (!Number.isFinite(n)) return SETTINGS_DEFAULTS.session_timeout_minutes;
  return Math.min(SESSION_TIMEOUT_MAX, Math.max(SESSION_TIMEOUT_MIN, Math.round(n)));
}

export function clampRetention(n: number): number {
  if (!Number.isFinite(n)) return SETTINGS_DEFAULTS.trash_retention_days;
  return Math.min(TRASH_RETENTION_MAX, Math.max(TRASH_RETENTION_MIN, Math.round(n)));
}

/** Coerce a raw key→value map into a fully-populated, valid AppSettings. */
export function normalizeSettings(raw: Record<string, string>): AppSettings {
  return {
    company_name: (raw.company_name ?? "").trim() || SETTINGS_DEFAULTS.company_name,
    logo_url: (raw.logo_url ?? SETTINGS_DEFAULTS.logo_url).trim(),
    timezone: isValidTimeZone(raw.timezone ?? "") ? raw.timezone : SETTINGS_DEFAULTS.timezone,
    date_format: DATE_FORMATS.includes(raw.date_format as DateFormat)
      ? (raw.date_format as DateFormat)
      : SETTINGS_DEFAULTS.date_format,
    time_format: raw.time_format === "12h" ? "12h" : SETTINGS_DEFAULTS.time_format,
    session_timeout_minutes: raw.session_timeout_minutes
      ? clampTimeout(Number(raw.session_timeout_minutes))
      : SETTINGS_DEFAULTS.session_timeout_minutes,
    trash_retention_days:
      raw.trash_retention_days !== undefined
        ? clampRetention(Number(raw.trash_retention_days))
        : SETTINGS_DEFAULTS.trash_retention_days,
    backup_frequency: BACKUP_FREQUENCIES.includes(raw.backup_frequency as BackupFrequency)
      ? (raw.backup_frequency as BackupFrequency)
      : SETTINGS_DEFAULTS.backup_frequency,
    backup_keep: raw.backup_keep
      ? clampBackupKeep(Number(raw.backup_keep))
      : SETTINGS_DEFAULTS.backup_keep,
  };
}

export function clampBackupKeep(n: number): number {
  if (!Number.isFinite(n)) return SETTINGS_DEFAULTS.backup_keep;
  return Math.min(BACKUP_KEEP_MAX, Math.max(BACKUP_KEEP_MIN, Math.round(n)));
}
