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

export function newToken(): string {
  return randomBytes(32).toString("hex");
}
