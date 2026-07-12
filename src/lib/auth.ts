import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getUserByUsername,
  getSessionUser,
  createSession,
  deleteSession,
  touchSession,
  markLogin,
} from "./db";
import { verifyPassword, newToken } from "./password";
import { getSessionTimeoutMinutes } from "./settings-store";
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

export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
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
 * or null on failure (bad password, unknown user, or disabled account).
 */
export async function login(
  username: string,
  password: string
): Promise<{ token: string; user: User } | null> {
  const record = await getUserByUsername(username.trim());
  if (!record || record.status !== "active") return null;
  if (!record.password_hash || !record.password_salt) return null;
  if (!verifyPassword(password, record.password_hash, record.password_salt)) return null;

  const token = newToken();
  const timeoutMs = (await getSessionTimeoutMinutes()) * 60_000;
  const expires = new Date(Date.now() + timeoutMs).toISOString();
  await createSession(token, record.id, expires);
  await markLogin(record.id);
  return { token, user: record };
}

export async function logout(token: string | undefined): Promise<void> {
  if (token) await deleteSession(token);
}
