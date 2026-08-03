import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getUserByUsername,
  getSessionUser,
  createSession,
  deleteSession,
  touchSession,
  markLogin,
  consumeRecoveryCode,
  recordTotpStep,
} from "./db";
import { verifyTotpStep } from "./totp";
import { openSecret } from "./secretbox";
import { verifyPassword, newToken } from "./password";
import { getSessionTimeoutMinutes, getSecureCookieMode } from "./settings-store";
import { SESSION_TIMEOUT_MAX } from "./settings";
import { roleAtLeast } from "./types";
import type { Role, SessionUser, User } from "./types";

export const SESSION_COOKIE = "compass_session";

// The DB `expires_at` is the real idle-timeout enforcement (slid forward on each
// request). The cookie's max-age is only an outer safety cap so a long-dormant
// cookie can't linger forever in the browser.
export const SESSION_MAX_AGE = SESSION_TIMEOUT_MAX * 60;

// Don't rewrite `expires_at` on literally every request — only once the sliding
// window has advanced by at least this much (keeps it to ~1 write/min/session).
const TOUCH_THROTTLE_MS = 60_000;

export function cookieOptions(maxAgeSeconds: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** True if the incoming request reached us over HTTPS (honoring a proxy). */
function requestIsHttps(req: Request): boolean {
  const xfproto = req.headers.get("x-forwarded-proto");
  if (xfproto) return xfproto.split(",")[0].trim().toLowerCase() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether the session cookie should be marked `Secure` for THIS request. Driven
 * by the `secure_cookies` setting: `always` → true, `never` → false, `auto` →
 * match the request protocol (so plain-HTTP installs work with no config, and
 * HTTPS installs get Secure cookies). `COMPASSDOCS_INSECURE_COOKIES=1` forces
 * insecure in `auto` mode (config-as-code back-compat).
 */
export async function secureCookie(req: Request): Promise<boolean> {
  const mode = await getSecureCookieMode();
  if (mode === "always") return true;
  if (mode === "never") return false;
  if (process.env.COMPASSDOCS_INSECURE_COOKIES === "1") return false;
  return requestIsHttps(req);
}

export function toSessionUser(u: User): SessionUser {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    role: u.role,
    must_change_password: u.must_change_password === 1,
    page_width: u.page_width === "normal" || u.page_width === "full" ? u.page_width : "wide",
    newsletter_role:
      u.newsletter_role === "contributor" || u.newsletter_role === "approver"
        ? u.newsletter_role
        : "none",
    theme: u.theme === "light" || u.theme === "dark" ? u.theme : "system",
    timezone: u.timezone ?? "",
    date_format: (["medium", "long", "iso", "us", "eu"] as const).includes(u.date_format as never)
      ? (u.date_format as "medium" | "long" | "iso" | "us" | "eu")
      : "auto",
    avatar: u.avatar ?? "",
  };
}

/** Read the current user from the session cookie, or null if not signed in. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await getSessionUser(token);
  if (!session) return null;

  // Sliding idle timeout: push the expiry back to now + configured window.
  // Throttled so an active session updates the row at most ~once a minute.
  const target = Date.now() + (await getSessionTimeoutMinutes()) * 60_000;
  const current = new Date(session.expires_at).getTime();
  if (!Number.isNaN(current) && target - current > TOUCH_THROTTLE_MS) {
    await touchSession(token, new Date(target).toISOString());
  }
  const user = toSessionUser(session);
  user.newsletter_role = await newsletterLevel(user);
  return user;
}

/**
 * The newsletter capability, derived from role assignments (0.94).
 *
 * `users.newsletter_role` was a fourth parallel authorization system: a text
 * column with its own three values and its own helper module. The column is
 * still written and read for display, but it is no longer what decides — the
 * seeded Newsletter contributor / approver roles are, so the capability can be
 * granted to a group, explained in the Roles console, and revoked in one place.
 *
 * The value is folded back onto SessionUser so lib/newsletter-access keeps its
 * simple synchronous shape and its ~20 call sites stay unchanged. Grants are
 * request-cached, so this costs nothing beyond the query the guard already ran.
 */
async function newsletterLevel(
  user: SessionUser
): Promise<"none" | "contributor" | "approver"> {
  const { grantsFor, holds, legacyAuthzEnforcement } = await import("./authz");
  // Break-glass: the column is the authority again, exactly as before 0.94.
  if (legacyAuthzEnforcement()) return user.newsletter_role;
  const grants = await grantsFor(user.id);
  if (holds(grants, "newsletter.send")) return "approver";
  if (holds(grants, "newsletter.use")) return "contributor";
  return "none";
}

/** For server components/pages: redirect to /login when not authenticated. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

// requireRole(min) lived here until 1.0. Every page that used it now calls
// requirePermission, which asks the same question the API asks; a page gated on
// a rung would bounce someone the API would admit. Nothing calls it, so rather
// than leave a working ladder gate lying around for the next page to reach for,
// it is gone.

/**
 * The page-level counterpart to `apiGuard(min, permission)`, and the reason it
 * exists: once the API enforces permissions, a page still gated on the ladder
 * would bounce someone the API would have let in — a custom role that holds
 * `workspace.settings_manage` without being an Administrator would find the
 * settings page redirecting home while every request it makes succeeds.
 *
 * Same admission rule as the API guard, including the legacy break-glass.
 */
export async function requirePermission(
  min: Role,
  permission: import("./permissions").PermissionKey,
  spaceId?: number
): Promise<SessionUser> {
  const user = await requireUser();
  const { grantsFor, admits, legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) {
    if (!roleAtLeast(user.role, min)) redirect("/");
    return user;
  }
  if (!admits(await grantsFor(user.id), permission, spaceId)) redirect("/");
  return user;
}

/**
 * Guard for a settings section, keyed on its href.
 *
 * The permission lives in lib/settings-sections next to the section's label and
 * icon, so the page guard and the nav that links to it read the same value.
 * Before 0.93 the /admin layout gated the whole console on being an
 * Administrator, which meant a role holding exactly one settings permission
 * could call the API but not open the page that calls it.
 */
export async function requireSettingsSection(href: string): Promise<SessionUser> {
  const { settingsSection } = await import("./settings-sections");
  const section = settingsSection(href);
  if (!section) redirect("/");
  return requirePermission("admin", section.permission);
}

/** Which settings sections this user may open — the rail renders exactly these. */
export async function reachableSettingsSections(user: SessionUser): Promise<string[]> {
  const { SETTINGS_SECTIONS } = await import("./settings-sections");
  const { grantsFor, admits, legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) {
    return roleAtLeast(user.role, "admin") ? SETTINGS_SECTIONS.map((s) => s.href) : [];
  }
  const grants = await grantsFor(user.id);
  return SETTINGS_SECTIONS.filter((s) => admits(grants, s.permission)).map((s) => s.href);
}

/**
 * Verify credentials and open a session. Returns the token to set as a cookie,
 * null on failure (bad password/code, unknown user, or disabled account), or
 * a totp_required marker when the password checked out but the account has
 * two-factor auth and no (valid) code was supplied yet.
 */
export async function login(
  username: string,
  password: string,
  totpCode?: string,
  device?: { ip?: string | null; userAgent?: string | null }
): Promise<{ token: string; user: User } | { totp_required: true } | null> {
  const record = await getUserByUsername(username.trim());
  if (!record || record.status !== "active") return null;
  if (!record.password_hash || !record.password_salt) return null;
  if (!verifyPassword(password, record.password_hash, record.password_salt)) return null;

  if (record.totp_enabled === 1 && record.totp_secret) {
    const code = (totpCode || "").trim();
    if (!code) return { totp_required: true };
    const secret = openSecret(record.totp_secret);
    const step = verifyTotpStep(secret, code);
    const lastStep = Number((record as { totp_last_step?: number }).totp_last_step) || 0;
    if (step !== null && step > lastStep) {
      // Valid, not-yet-used code — record its step so it can't be replayed.
      await recordTotpStep(record.id, step);
    } else {
      // Wrong code, or a replay of a code already consumed this window — fall
      // back to one-time recovery codes (xxxx-xxxx, consumed on use).
      const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, "");
      const pretty = `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
      const hash = createHash("sha256").update(pretty).digest("hex");
      if (normalized.length !== 8 || !(await consumeRecoveryCode(record.id, hash))) {
        return { totp_required: true };
      }
    }
  }

  const token = newToken();
  const timeoutMs = (await getSessionTimeoutMinutes()) * 60_000;
  const expires = new Date(Date.now() + timeoutMs).toISOString();
  await createSession(token, record.id, expires, device?.ip, device?.userAgent);
  await markLogin(record.id);
  return { token, user: record };
}

export async function logout(token: string | undefined): Promise<void> {
  if (token) await deleteSession(token);
}
