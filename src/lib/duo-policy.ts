// The Duo sign-in check (1.20.5): its settings and the decision.
//
// An extra step on top of whatever signed the person in (password, OIDC,
// SAML): the SESSION records that it passed Duo, and the session checks
// (lib/auth, lib/api-auth, the desk gates) ask this file whether a session
// still owes that step. Nothing about how the session was created matters,
// so the enterprise overlay's SSO code needs no change.
//
// Two independent rules:
//   - at sign-in: every session passes Duo once;
//   - when opening the desk: /desk and the agent-side desk API want an
//     approval on this session no older than N hours.
// Named accounts on the bypass list (break-glass) skip both.
//
// Pure: settings map in, decision out. No database, no network, no
// server-only imports, so the whole decision table is unit-tested
// (test/duo-mfa.test.ts) and the settings form can share the limits.

import { safeReturnPath } from "./return-to";

/** settings-table keys. duo_client_secret is sealed at rest (db SENSITIVE_SETTINGS). */
export const DUO_KEYS = {
  clientId: "duo_client_id",
  clientSecret: "duo_client_secret",
  apiHost: "duo_api_host",
  usernameSource: "duo_username_source",
  enforceSignIn: "duo_enforce_signin",
  enforceDesk: "duo_enforce_desk",
  deskHours: "duo_desk_hours",
  bypass: "duo_bypass_user_ids",
  failOpen: "duo_fail_open",
  /** Changes whenever the client ID, secret or host change; a test approval is only good for the revision it ran against. */
  rev: "duo_config_rev",
  /** The last successful "Test with my account": { rev, sid, user_id, at }. */
  verified: "duo_verified",
} as const;

export const DUO_DESK_HOURS_DEFAULT = 12;
export const DUO_DESK_HOURS_MIN = 1;
export const DUO_DESK_HOURS_MAX = 168; // a week

/** How many accounts the bypass list holds at most (it is for break-glass, not for a department). */
export const DUO_BYPASS_MAX = 50;

export type DuoUsernameSource = "email" | "username";

export interface DuoVerified {
  rev: string;
  /** The session (its sid, never its token) that completed the test. */
  sid: string;
  user_id: number;
  at: string;
}

export interface DuoSettings {
  clientId: string;
  /** Server-side only. Never sent to a browser, logged or audited. */
  clientSecret: string;
  apiHost: string;
  usernameSource: DuoUsernameSource;
  enforceSignIn: boolean;
  enforceDesk: boolean;
  deskHours: number;
  bypassUserIds: number[];
  failOpen: boolean;
  rev: string;
  verified: DuoVerified | null;
}

export function clampDeskHours(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DUO_DESK_HOURS_DEFAULT;
  return Math.min(DUO_DESK_HOURS_MAX, Math.max(DUO_DESK_HOURS_MIN, n));
}

/**
 * A Duo API hostname, lower-cased, or null. Only the shape Duo issues is
 * accepted: api-XXXXXXXX.duosecurity.com (or .duofederal.com). A scheme, a
 * port, a path, a userinfo part, another domain or a look-alike suffix are
 * all refused, so the value can only ever name a Duo API host and requests
 * built from it cannot be pointed anywhere else.
 */
export function normalizeDuoHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const host = raw.trim().toLowerCase();
  return /^api-[a-z0-9]{6,16}\.(duosecurity|duofederal)\.com$/.test(host) ? host : null;
}

/** Duo client IDs are 20 letters and digits; client secrets are 40 characters (Duo's own client enforces both). */
export function validDuoClientId(raw: string): boolean {
  return /^[A-Za-z0-9]{20}$/.test(raw);
}
export function validDuoClientSecret(raw: string): boolean {
  return /^[\x21-\x7e]{40}$/.test(raw);
}

function parseIds(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter((n): n is number => Number.isSafeInteger(n) && n > 0))].slice(0, DUO_BYPASS_MAX);
  } catch {
    return [];
  }
}

function parseVerified(raw: string | undefined): DuoVerified | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DuoVerified> | null;
    if (!v || typeof v.rev !== "string" || typeof v.sid !== "string" || !Number.isSafeInteger(v.user_id) || typeof v.at !== "string") return null;
    return { rev: v.rev, sid: v.sid, user_id: v.user_id as number, at: v.at };
  } catch {
    return null;
  }
}

/** The Duo settings out of the settings map (getAllSettings, secrets already opened). */
export function duoSettingsFrom(map: Record<string, string>): DuoSettings {
  return {
    clientId: (map[DUO_KEYS.clientId] || "").trim(),
    clientSecret: map[DUO_KEYS.clientSecret] || "",
    apiHost: normalizeDuoHost(map[DUO_KEYS.apiHost]) ?? "",
    usernameSource: map[DUO_KEYS.usernameSource] === "username" ? "username" : "email",
    enforceSignIn: map[DUO_KEYS.enforceSignIn] === "1",
    enforceDesk: map[DUO_KEYS.enforceDesk] === "1",
    deskHours: map[DUO_KEYS.deskHours] ? clampDeskHours(map[DUO_KEYS.deskHours]) : DUO_DESK_HOURS_DEFAULT,
    bypassUserIds: parseIds(map[DUO_KEYS.bypass]),
    failOpen: map[DUO_KEYS.failOpen] === "1",
    rev: map[DUO_KEYS.rev] || "",
    verified: parseVerified(map[DUO_KEYS.verified]),
  };
}

/** Client ID, secret and host are all saved: the flow can run. */
export function duoConfigured(s: Pick<DuoSettings, "clientId" | "clientSecret" | "apiHost">): boolean {
  return Boolean(s.clientId && s.clientSecret && s.apiHost);
}

/**
 * Is either rule switched on in this settings map? The one question every
 * request asks. Two map lookups on the map the session check already read,
 * so an install that never set Duo up pays nothing for the feature.
 */
export function duoSwitchedOn(map: Record<string, string>): boolean {
  return map[DUO_KEYS.enforceSignIn] === "1" || map[DUO_KEYS.enforceDesk] === "1";
}

/** What is enforced right now. */
export interface DuoPolicy {
  signIn: boolean;
  desk: boolean;
  deskMaxAgeMs: number;
  bypass: ReadonlySet<number>;
  failOpen: boolean;
}

/**
 * The policy in force, or null when nothing is enforced: no rule on, the
 * server's COMPASSDOCS_DUO_DISABLED escape hatch, or no licence for it (not
 * an Enterprise build, or the `sso` entitlement is not granted). Null means
 * the session checks behave exactly as before 1.20.5.
 *
 * A rule that is ON stays in force even when the saved details cannot be
 * used (the client secret no longer opens because the server's master key
 * changed, say). The settings route never lets a rule be on without details
 * it has seen work, so that state is damage, and damage must not quietly
 * switch the check off: people are stopped at the Duo step with a message,
 * and a bypass account or the escape hatch gets an administrator in to mend
 * it.
 */
export function duoPolicy(s: DuoSettings, facts: { disabled: boolean; licensed: boolean }): DuoPolicy | null {
  if (!s.enforceSignIn && !s.enforceDesk) return null;
  if (facts.disabled || !facts.licensed) return null;
  return {
    signIn: s.enforceSignIn,
    desk: s.enforceDesk,
    deskMaxAgeMs: s.deskHours * 3_600_000,
    bypass: new Set(s.bypassUserIds),
    failOpen: s.failOpen,
  };
}

/** sessions.mfa_method values that count as having passed the Duo step. */
export const DUO_PASSED_METHODS = ["duo", "duo_unreachable"] as const;
export type DuoPassedMethod = (typeof DUO_PASSED_METHODS)[number];

export interface DuoSessionFacts {
  userId: number;
  /** sessions.mfa_at: when this session last passed the step. */
  mfaAt: string | Date | null;
  /** sessions.mfa_method: "duo", or "duo_unreachable" when Duo was down and the workspace lets people through. */
  mfaMethod: string | null;
}

/** What a session still owes. `true` means "send this person to the Duo step". */
export interface DuoVerdict {
  /** Owed before anything in CompassDocs may be used. */
  signIn: boolean;
  /** Owed before the desk may be used (true whenever signIn is). */
  desk: boolean;
  /** The account is on the bypass list and a rule would otherwise apply to it. */
  bypassed: boolean;
}

export const DUO_NOTHING_OWED: DuoVerdict = { signIn: false, desk: false, bypassed: false };

/** The decision table. */
export function duoVerdict(policy: DuoPolicy | null, session: DuoSessionFacts, now = Date.now()): DuoVerdict {
  if (!policy) return DUO_NOTHING_OWED;
  if (policy.bypass.has(session.userId)) return { signIn: false, desk: false, bypassed: true };
  const at = session.mfaAt ? new Date(session.mfaAt).getTime() : NaN;
  const passed = (DUO_PASSED_METHODS as readonly string[]).includes(session.mfaMethod ?? "") && Number.isFinite(at);
  const signIn = policy.signIn && !passed;
  // A time in the future (a clock that moved) is not "recent": it fails the age test too.
  const fresh = passed && now - at <= policy.deskMaxAgeMs && at - now <= 60_000;
  const desk = signIn || (policy.desk && !fresh);
  return { signIn, desk, bypassed: false };
}

/** Where the Duo step lives. Under /login, which lib/return-to never returns to, so the step cannot loop on itself. */
export const DUO_STEP_PATH = "/login/duo";

/** Where a step asked for from inside the desk (in a second tab) ends: "approved, close this tab". Built here, never from a URL. */
export const DUO_STEP_DONE = `${DUO_STEP_PATH}?for=desk&done=1`;

/**
 * Is this page path ("/path?query") part of the desk? An empty or
 * undecodable path counts as the desk: when the desk rule is owed and the
 * page cannot be named, the careful answer is to ask.
 */
export function isDeskPath(path: string | null | undefined): boolean {
  if (!path) return true;
  let p: string;
  try {
    p = decodeURIComponent(path.split(/[?#]/)[0]).toLowerCase();
  } catch {
    return true;
  }
  return p === "/desk" || p.startsWith("/desk/");
}

/** The Duo step, coming back to `returnTo` afterwards when that is a page worth coming back to (lib/return-to). */
export function duoStepHref(returnTo: string | null | undefined): string {
  const path = safeReturnPath(returnTo);
  return path === "/" ? DUO_STEP_PATH : `${DUO_STEP_PATH}?next=${encodeURIComponent(path)}`;
}
