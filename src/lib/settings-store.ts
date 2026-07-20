import { getAllSettings, setSetting } from "./db";
import {
  AppSettings,
  SETTINGS_DEFAULTS,
  DATE_FORMATS,
  BACKUP_FREQUENCIES,
  LOGO_MAX_LEN,
  clampTimeout,
  clampRetention,
  clampBackupKeep,
  clampAttachmentMb,
  isValidTimeZone,
  normalizeDomain,
  normalizeSettings,
  TLS_MODES,
  SECURE_COOKIE_MODES,
} from "./settings";
import type { SecureCookieMode } from "./settings";

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
  if (patch.accent_color !== undefined && /^#[0-9a-fA-F]{6}$/.test(patch.accent_color)) {
    await setSetting("accent_color", patch.accent_color.toLowerCase());
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
  if (patch.trash_retention_days !== undefined) {
    await setSetting(
      "trash_retention_days",
      String(clampRetention(Number(patch.trash_retention_days)))
    );
  }
  if (patch.backup_frequency !== undefined && BACKUP_FREQUENCIES.includes(patch.backup_frequency)) {
    await setSetting("backup_frequency", patch.backup_frequency);
  }
  if (patch.backup_keep !== undefined) {
    await setSetting("backup_keep", String(clampBackupKeep(Number(patch.backup_keep))));
  }
  if (patch.max_attachment_mb !== undefined) {
    await setSetting("max_attachment_mb", String(clampAttachmentMb(Number(patch.max_attachment_mb))));
  }
  if (patch.custom_domain !== undefined) {
    await setSetting("custom_domain", normalizeDomain(patch.custom_domain));
  }
  if (patch.tls_mode !== undefined && TLS_MODES.includes(patch.tls_mode)) {
    await setSetting("tls_mode", patch.tls_mode);
  }
  if (patch.tls_email !== undefined) {
    await setSetting("tls_email", patch.tls_email.trim().slice(0, 254));
  }
  if (patch.secure_cookies !== undefined && SECURE_COOKIE_MODES.includes(patch.secure_cookies)) {
    await setSetting("secure_cookies", patch.secure_cookies);
  }
  if (patch.comments_enabled !== undefined) {
    await setSetting("comments_enabled", patch.comments_enabled ? "1" : "0");
  }
  if (patch.comments_blocked_words !== undefined) {
    await setSetting("comments_blocked_words", String(patch.comments_blocked_words).slice(0, 5000));
  }
  if (patch.nested_pages_enabled !== undefined) {
    await setSetting("nested_pages_enabled", patch.nested_pages_enabled ? "1" : "0");
  }
  if (patch.backlinks_enabled !== undefined) {
    await setSetting("backlinks_enabled", patch.backlinks_enabled ? "1" : "0");
  }
  return getAppSettings();
}

/** The Secure-cookie mode (auto/always/never), used by the auth layer. */
export async function getSecureCookieMode(): Promise<SecureCookieMode> {
  const raw = await getAllSettings();
  return SECURE_COOKIE_MODES.includes(raw.secure_cookies as SecureCookieMode)
    ? (raw.secure_cookies as SecureCookieMode)
    : "auto";
}

/** Just the idle session timeout in minutes (used by the auth layer). */
export async function getSessionTimeoutMinutes(): Promise<number> {
  const raw = await getAllSettings();
  return raw.session_timeout_minutes
    ? clampTimeout(Number(raw.session_timeout_minutes))
    : SETTINGS_DEFAULTS.session_timeout_minutes;
}
