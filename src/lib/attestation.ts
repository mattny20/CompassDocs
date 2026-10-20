import "server-only";
import { getUserByUsername } from "./db";
import { verifyPassword } from "./password";
import { pairRetryAfter, recordPairFailure, recordLoginSuccess } from "./login-guard";

// The typed signature (C2, 1.12.0): one check shared by the read
// confirmation route (a policy with "Require typed signature" on) and the
// training deck's e-signature gate, extracted from the training route so
// the two can never drift. The person types their full name; a local
// account also re-enters its password; an SSO account has no password to
// re-enter and is identified by the session that reached the route.
//
// What comes back is a verdict and how the signer was identified, nothing
// else: the result never carries the typed name or the password, so a
// caller can log it, audit it or return it without leaking either. The
// password branch sits behind the login throttle (lib/login-guard): the
// username+IP pair the sign-in form counts, and only that pair, never the
// per-address spray counter (a session has a fixed username, and an office
// signing a policy must not lock its own sign-in). A signed-in session must
// not become an unthrottled oracle for the account's password; a correct
// password clears the pair as a sign-in does; and a failure says whether
// it engaged the lock, so the caller can audit that moment as the sign-in
// form does.

/**
 * How a signed row's identity was asserted. 'password': a local account
 * re-entered its password; 'sso_session': an SSO account, identified by its
 * sign-in session; 'typed_name_only': a local account that somehow carries
 * no password hash (nothing to re-check). Unsigned rows store ''.
 */
export type IdentityProof = "password" | "sso_session" | "typed_name_only";

export type AttestationResult =
  | { ok: true; identity_proof: IdentityProof }
  | {
      ok: false;
      /** 409 for a name or password that does not match; 429 while the throttle holds. */
      status: 409 | 429;
      /** Which check failed, so a caller that keeps its own sentences can map them. */
      code: "name" | "password" | "locked";
      /** A sentence fit for the reader; names the account's own name, never the input. */
      error: string;
      /** True when this failure locked the username+IP pair (the caller audits auth.lockout). */
      lock_engaged: boolean;
    };

/** The longest signed name a row keeps (the training route's limit). */
export const SIGNED_NAME_MAX = 200;

/** Whitespace-collapsed, case-insensitive name comparison for e-signatures. */
export const nameKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The typed name as the row stores it: trimmed, cut at SIGNED_NAME_MAX, '' when absent. */
export function signedNameFrom(input: unknown): string {
  return typeof input === "string" ? input.trim().slice(0, SIGNED_NAME_MAX) : "";
}

/**
 * Check a typed signature for the signed-in person. The name must match the
 * account's display name (its username when it has none) under nameKey; a
 * local account's password is then re-checked against the stored hash,
 * throttled per username and address. `ip` is the caller's address for the
 * throttle ("unknown" when absent, as the sign-in form does).
 */
export async function verifyAttestation(
  user: { username: string; name: string },
  input: { signed_name?: unknown; password?: unknown },
  opts: { ip?: string | null } = {}
): Promise<AttestationResult> {
  const typed = signedNameFrom(input.signed_name);
  const expected = user.name || user.username;
  if (!typed || nameKey(typed) !== nameKey(expected)) {
    return {
      ok: false,
      status: 409,
      code: "name",
      error: `Type your full name exactly as it appears on your account (${expected}).`,
      lock_engaged: false,
    };
  }

  const record = await getUserByUsername(user.username);
  if (record?.password_hash && record.password_salt) {
    const ip = opts.ip || "unknown";
    const wait = pairRetryAfter(user.username, ip);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60);
      return {
        ok: false,
        status: 429,
        code: "locked",
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        lock_engaged: false,
      };
    }
    const password = typeof input.password === "string" ? input.password : "";
    if (!verifyPassword(password, record.password_hash, record.password_salt)) {
      const lockEngaged = recordPairFailure(user.username, ip);
      return {
        ok: false,
        status: 409,
        code: "password",
        error: "Password check failed. Re-enter your account password to sign.",
        lock_engaged: lockEngaged,
      };
    }
    recordLoginSuccess(user.username, ip);
    return { ok: true, identity_proof: "password" };
  }

  // No hash to re-check: an SSO account is identified by its session; a
  // local account without one (nothing to compare) is the typed name alone.
  const local = !record?.auth_provider || record.auth_provider === "local";
  return { ok: true, identity_proof: local ? "typed_name_only" : "sso_session" };
}
