// HS512 JSON Web Tokens for the Duo sign-in check (1.20.5).
//
// Duo's Universal Prompt (the "Web SDK" application, an OIDC-style flow)
// signs everything with the application's client secret: the request we send
// to its authorize endpoint, the client assertion on its health check and
// token endpoints, and the ID token it returns. This file signs and verifies
// those with Node's crypto and nothing else.
//
// Verification is strict on purpose: the header must say HS512 exactly (so
// "none", HS256 and the RS/ES families are refused before any key is used),
// the signature is compared in constant time, and every claim Duo's own
// client checks is checked here (issuer, audience, expiry, nonce, the
// username we asked about, and the result).
//
// Pure: no database, no settings, no network. The secret is only ever used
// as a key and never appears in an error.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Seconds of clock difference tolerated on token times (Duo's client uses 60). */
export const DUO_CLOCK_SKEW = 60;

/** Why a token was refused. Short codes: the callers log and audit these, never the token. */
export type DuoTokenProblem =
  | "malformed"
  | "alg"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "not_yet_valid"
  | "nonce"
  | "username"
  | "denied";

export class DuoTokenError extends Error {
  constructor(public readonly problem: DuoTokenProblem) {
    super(`Duo token refused: ${problem}`);
    this.name = "DuoTokenError";
  }
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

function hmac(input: string, secret: string): Buffer {
  return createHmac("sha512", secret).update(input).digest();
}

/** A compact JWT signed HS512 with `secret`. */
export function signDuoJwt(payload: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS512", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${b64url(hmac(`${head}.${body}`, secret))}`;
}

function parsePart(part: string): Record<string, unknown> {
  // base64url only: Buffer would otherwise skip characters it does not know.
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new DuoTokenError("malformed");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new DuoTokenError("malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DuoTokenError("malformed");
  return value as Record<string, unknown>;
}

/**
 * The payload of a JWT signed HS512 with `secret`. Throws DuoTokenError for
 * anything else: not three parts, a header naming another algorithm, or a
 * signature that does not match.
 */
export function verifyDuoJwt(token: string, secret: string): Record<string, unknown> {
  if (typeof token !== "string" || !secret) throw new DuoTokenError("malformed");
  const parts = token.split(".");
  if (parts.length !== 3) throw new DuoTokenError("malformed");
  const [head, body, sig] = parts;
  const header = parsePart(head);
  // Exactly HS512. Checked before the signature so a token that picks its own
  // algorithm ("none", HS256, RS256 with our secret as the "public key") is
  // never evaluated under it.
  if (header.alg !== "HS512") throw new DuoTokenError("alg");
  if (!/^[A-Za-z0-9_-]+$/.test(sig)) throw new DuoTokenError("signature");
  const given = Buffer.from(sig, "base64url");
  const expected = hmac(`${head}.${body}`, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new DuoTokenError("signature");
  return parsePart(body);
}

export interface DuoIdTokenExpectation {
  /** The application's client secret (the HS512 key). */
  secret: string;
  /** The token endpoint URL, which is the issuer Duo names. */
  issuer: string;
  /** The application's client ID, which is the audience. */
  clientId: string;
  /** The nonce this sign-in sent. */
  nonce: string;
  /** The username this sign-in sent as duo_uname. */
  username: string;
  /** Seconds since the epoch; the tests pass their own. */
  now?: number;
}

/**
 * Verify the ID token Duo's token endpoint returned and that it says "allow"
 * for the person and the attempt we started. Returns the claims; throws
 * DuoTokenError naming the first thing that is wrong.
 */
export function verifyDuoIdToken(token: string, expect: DuoIdTokenExpectation): Record<string, unknown> {
  const claims = verifyDuoJwt(token, expect.secret);
  const now = expect.now ?? Math.floor(Date.now() / 1000);

  if (typeof claims.iss !== "string" || claims.iss !== expect.issuer) throw new DuoTokenError("issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!expect.clientId || !aud.includes(expect.clientId)) throw new DuoTokenError("audience");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || now > claims.exp + DUO_CLOCK_SKEW) {
    throw new DuoTokenError("expired");
  }
  // Issued (or valid) in the future beyond the skew: a clock we cannot trust.
  for (const key of ["iat", "nbf"] as const) {
    const at = claims[key];
    if (at !== undefined && (typeof at !== "number" || now < at - DUO_CLOCK_SKEW)) throw new DuoTokenError("not_yet_valid");
  }
  // A nonce Duo echoes must be ours. A token with no nonce claim at all is
  // accepted: the attempt is already tied to this session by the single-use
  // state and to this person by preferred_username below, and not every Duo
  // deployment is known to echo the claim.
  if (!expect.nonce) throw new DuoTokenError("nonce");
  if (claims.nonce !== undefined && (typeof claims.nonce !== "string" || !sameText(claims.nonce, expect.nonce))) {
    throw new DuoTokenError("nonce");
  }
  if (!expect.username || typeof claims.preferred_username !== "string" || claims.preferred_username !== expect.username) {
    throw new DuoTokenError("username");
  }
  const result = (claims.auth_result as { result?: unknown } | undefined)?.result;
  if (result !== "allow") throw new DuoTokenError("denied");
  return claims;
}

/** Constant-time string equality (for values an attacker may be guessing). */
export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
