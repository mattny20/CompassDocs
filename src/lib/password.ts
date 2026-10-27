import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// Local password hashing using Node's built-in scrypt — no external dependency.
// Stored as a hex hash + hex salt pair on the users table.

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  if (!hash || !salt) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// A hash nobody's password matches, made once, so a sign-in for an unknown,
// disabled or password-less account costs the same scrypt as a real one
// (1.16.0): the response time no longer says whether the account exists.
let dummy: { hash: string; salt: string } | null = null;

/** Spend one password check's worth of work and fail. */
export function verifyNothing(password: string): false {
  dummy ??= hashPassword(randomBytes(32).toString("hex"));
  verifyPassword(password, dummy.hash, dummy.salt);
  return false;
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}
