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
} from "./db";
import { verifyTotp } from "./totp";
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
  return toSessionUser(session);
}

/** For server components/pages: redirect to /login when not authenticated. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For server components/pages: 404-style redirect home when under-privileged. */
export async function requireRole(min: Role): Promise<SessionUser> {
  const user = await requireUser();
  if (!roleAtLeast(user.role, min)) redirect("/");
  return user;
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
    if (!verifyTotp(record.totp_secret, code)) {
      // Fall back to one-time recovery codes (xxxx-xxxx, consumed on use).
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
