// The Duo sign-in check (1.20.5): talking to Duo.
//
// Duo's Universal Prompt for a "Web SDK" application is an OIDC-style flow,
// every message signed HS512 with the application's client secret:
//
//   1. POST /oauth/v1/health_check   client_id + client_assertion
//                                     → { stat: "OK" }
//   2. browser → GET /oauth/v1/authorize?response_type=code&client_id=…
//                  &request=<signed JWT>&redirect_uri=…&scope=openid
//      the request JWT carries duo_uname, state, nonce, redirect_uri.
//   3. Duo → browser → our callback with ?duo_code=…&state=…
//   4. POST /oauth/v1/token          grant_type=authorization_code, code,
//                                     redirect_uri, client_id,
//                                     client_assertion(_type)
//                                     → { id_token, … }
//   5. The ID token is verified in lib/duo-jwt (signature, iss, aud, exp,
//      nonce, preferred_username, auth_result.result === "allow").
//
// Endpoints, parameter names and claims follow Duo's own Node client
// (@duosecurity/duo_universal 3.1.0). Which factors the prompt offers (Duo
// Push only, passcodes, ...) is Duo policy, set in the Duo Admin Panel; this
// code only learns "allow" or not.
//
// Requests go to https://<the validated Duo API host> and nowhere else:
// redirects are never followed, every call has a timeout, and the secret is
// used only as a signing key. Server-only.

import "server-only";
import { randomBytes } from "node:crypto";
import { duoApiBase } from "./duo-config";
import { signDuoJwt, verifyDuoIdToken } from "./duo-jwt";
import type { DuoSettings } from "./duo-policy";

const HEALTH_PATH = "/oauth/v1/health_check";
const AUTHORIZE_PATH = "/oauth/v1/authorize";
const TOKEN_PATH = "/oauth/v1/token";
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** Seconds a signed request, a client assertion and an in-flight step stay valid. */
export const DUO_STEP_TTL = 300;
const TIMEOUT_MS = 10_000;

/** Duo could not be reached at all: a network error, a timeout, a 5xx, or an answer that is not Duo's. */
export class DuoUnreachableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "DuoUnreachableError";
  }
}

/** Duo answered and refused the request (wrong client ID or secret, a code it does not know). */
export class DuoRefusedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "DuoRefusedError";
  }
}

type Creds = Pick<DuoSettings, "clientId" | "clientSecret" | "apiHost">;

/** The client assertion Duo's health check and token endpoints expect: issuer and subject are the client ID, audience the endpoint itself. */
function clientAssertion(c: Creds, audience: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signDuoJwt(
    { iss: c.clientId, sub: c.clientId, aud: audience, jti: randomBytes(18).toString("hex"), iat: now, exp: now + DUO_STEP_TTL },
    c.clientSecret
  );
}

/** Duo's own words for a refusal, trimmed. Duo never echoes the secret; this is still kept short and to the log. */
function refusalText(data: unknown, status: number): string {
  const d = (data ?? {}) as Record<string, unknown>;
  const text = [d.message, d.message_detail, d.error, d.error_description].filter((v) => typeof v === "string").join(": ");
  return (text || `HTTP ${status}`).slice(0, 200);
}

async function post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form),
      // Never follow a redirect: the signed assertion goes to the Duo host and nowhere else.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new DuoUnreachableError(e instanceof Error ? e.name : "network error");
  }
  if (res.status >= 500 || (res.status >= 300 && res.status < 400) || res.status === 0) {
    throw new DuoUnreachableError(`HTTP ${res.status}`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new DuoUnreachableError(`HTTP ${res.status}, not JSON`);
  }
  if (!res.ok) throw new DuoRefusedError(refusalText(data, res.status));
  if (!data || typeof data !== "object") throw new DuoUnreachableError("unexpected answer");
  return data as Record<string, unknown>;
}

/** Is Duo up and does it accept these credentials? Throws DuoUnreachableError or DuoRefusedError. */
export async function duoHealthCheck(c: Creds): Promise<void> {
  const url = `${duoApiBase(c.apiHost)}${HEALTH_PATH}`;
  const data = await post(url, { client_id: c.clientId, client_assertion: clientAssertion(c, url) });
  if (data.stat !== "OK") throw new DuoRefusedError(refusalText(data, 200));
}

export interface DuoStep {
  state: string;
  nonce: string;
}

/** A fresh state and nonce for one step. The state is long enough for Duo (22 to 1024 characters). */
export function newDuoStep(): DuoStep {
  return { state: randomBytes(32).toString("hex"), nonce: randomBytes(24).toString("base64url") };
}

/** The address of Duo's prompt for this step. */
export function duoAuthorizeUrl(c: Creds, input: DuoStep & { username: string; redirectUri: string }): string {
  const base = duoApiBase(c.apiHost);
  const request = signDuoJwt(
    {
      response_type: "code",
      scope: "openid",
      exp: Math.floor(Date.now() / 1000) + DUO_STEP_TTL,
      client_id: c.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      nonce: input.nonce,
      duo_uname: input.username,
      iss: c.clientId,
      aud: base,
      use_duo_code_attribute: true,
    },
    c.clientSecret
  );
  const query = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    request,
    redirect_uri: input.redirectUri,
    scope: "openid",
  });
  return `${base}${AUTHORIZE_PATH}?${query.toString()}`;
}

/**
 * Exchange the code Duo sent back for its verdict. Returns the verified ID
 * token claims (the result is "allow"); throws DuoUnreachableError,
 * DuoRefusedError, or lib/duo-jwt's DuoTokenError (a token that does not
 * verify, or one that says anything but "allow").
 */
export async function duoExchangeCode(
  c: Creds,
  input: { code: string; redirectUri: string; username: string; nonce: string }
): Promise<Record<string, unknown>> {
  const url = `${duoApiBase(c.apiHost)}${TOKEN_PATH}`;
  const data = await post(url, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: c.clientId,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion(c, url),
  });
  if (typeof data.id_token !== "string") throw new DuoRefusedError("no id_token in the answer");
  return verifyDuoIdToken(data.id_token, {
    secret: c.clientSecret,
    issuer: url,
    clientId: c.clientId,
    nonce: input.nonce,
    username: input.username,
  });
}

/**
 * The name Duo knows this person by: their email, or their username when the
 * workspace says so. An account with no email falls back to its username
 * rather than sending nothing.
 */
export function duoUsernameFor(user: { email?: string | null; username: string }, source: DuoSettings["usernameSource"]): string {
  const email = (user.email || "").trim();
  return source === "email" && email ? email : user.username;
}
