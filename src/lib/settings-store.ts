import { getAllSettings, setSetting } from "./db";
import {
  AppSettings,
  SETTINGS_DEFAULTS,
  DATE_FORMATS,
  LOGO_MAX_LEN,
  clampTimeout,
  isValidTimeZone,
  normalizeSettings,
} from "./settings";

// DB-backed reads/writes for the appearance & workspace settings. Kept separate
// from `settings.ts` (which stays import-safe for client components) because it
// pulls in the Postgres data layer.

/** Load all settings, filling in defaults and coercing to valid values. */
export async function getAppSettings(): Promise<AppSettings> {
  return normalizeSettings(await getAllSettings());
}

/** Persist a partial update; unknown/invalid values are ignored or clamped. */
export async function updateAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  if (patch.company_name !== undefined) {
    await setSetting(
      "company_name",
      patch.company_name.trim().slice(0, 80) || SETTINGS_DEFAULTS.company_name
    );
  }
  if (patch.logo_url !== undefined) {
    await setSetting("logo_url", patch.logo_url.trim().slice(0, LOGO_MAX_LEN));
  }
  if (patch.timezone !== undefined && isValidTimeZone(patch.timezone)) {
    await setSetting("timezone", patch.timezone);
  }
  if (patch.date_format !== undefined && DATE_FORMATS.includes(patch.date_format)) {
    await setSetting("date_format", patch.date_format);
  }
  if (patch.time_format !== undefined) {
    await setSetting("time_format", patch.time_format === "12h" ? "12h" : "24h");
  }
  if (patch.session_timeout_minutes !== undefined) {
    await setSetting(
      "session_timeout_minutes",
      String(clampTimeout(Number(patch.session_timeout_minutes)))
    );
  }
  return getAppSettings();
}

/** Just the idle session timeout in minutes (used by the auth layer). */
export async function getSessionTimeoutMinutes(): Promise<number> {
  const raw = await getAllSettings();
  return raw.session_timeout_minutes
    ? clampTimeout(Number(raw.session_timeout_minutes))
    : SETTINGS_DEFAULTS.session_timeout_minutes;
}
