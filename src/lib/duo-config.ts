// The Duo sign-in check (1.20.5): reading and saving its settings, and the
// three facts the decision needs that are not settings (the server's escape
// hatch, the licence, the test seam). The decision itself is in
// lib/duo-policy; the Duo calls are in lib/duo. Server-only.

import "server-only";
import { randomBytes } from "node:crypto";
import { getAllSettings, setSetting } from "./db";
import { featureEnabledFrom } from "./ee";
import {
  DUO_BYPASS_MAX,
  DUO_KEYS,
  clampDeskHours,
  duoPolicy,
  duoSettingsFrom,
  duoSwitchedOn,
  type DuoPolicy,
  type DuoSettings,
  type DuoUsernameSource,
} from "./duo-policy";

/**
 * The emergency switch. COMPASSDOCS_DUO_DISABLED=1 in the server's
 * environment (and a restart) turns every Duo rule off: nobody is asked for
 * Duo, the settings stay as they are, and administrators see a banner saying
 * so. Deliberately an environment variable and not a setting, like
 * COMPASSDOCS_AUTHZ_LEGACY (lib/authz): the failure it exists for is "nobody
 * can sign in to change the setting" (Duo credentials revoked on Duo's side,
 * the bypass account's password lost).
 */
export function duoDisabledByEnv(): boolean {
  return process.env.COMPASSDOCS_DUO_DISABLED === "1";
}

/**
 * TEST ONLY. COMPASSDOCS_DUO_TEST_API_BASE points every Duo call (and the
 * browser redirect to Duo's prompt) at a fake Duo on this machine, so the
 * suites and the e2e rig never contact Duo. It works only when explicitly
 * set, and only for a loopback address (http://127.0.0.1:PORT or
 * http://localhost:PORT): it cannot send the client secret's signatures or a
 * user to any other host. Never set it on a real install; with it set, a
 * "Duo approval" proves nothing.
 */
export function duoTestApiBase(): string | null {
  const raw = process.env.COMPASSDOCS_DUO_TEST_API_BASE;
  if (!raw) return null;
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(raw) ? raw : null;
}

/** Where Duo's API for `host` is: https://<host>, or the test seam above. */
export function duoApiBase(host: string): string {
  return duoTestApiBase() ?? `https://${host}`;
}

/**
 * Does this build and licence include the Duo check? It rides the `sso`
 * entitlement, exactly like "SSO only": an Enterprise build, and a licence
 * that is active or in its 14-day grace. Answered from the settings map the
 * caller already has (lib/ee featureEnabledFrom), so it costs no query.
 */
export function duoLicensedFrom(map: Record<string, string>): boolean {
  return featureEnabledFrom("sso", map);
}

/**
 * The policy in force for this settings map, or null when nothing is
 * enforced. The first test is the cheap one, so a workspace with no Duo rule
 * on (every install before 1.20.5, the community build, CI) returns here
 * without parsing anything.
 */
export function duoPolicyFromSettings(map: Record<string, string>): DuoPolicy | null {
  if (!duoSwitchedOn(map)) return null;
  if (duoDisabledByEnv()) return null;
  return duoPolicy(duoSettingsFrom(map), { disabled: false, licensed: duoLicensedFrom(map) });
}

export async function getDuoSettings(): Promise<DuoSettings> {
  return duoSettingsFrom(await getAllSettings());
}

export interface DuoSettingsPatch {
  clientId?: string;
  /** A new secret; an empty or absent value keeps the stored one. */
  clientSecret?: string;
  apiHost?: string;
  usernameSource?: DuoUsernameSource;
  enforceSignIn?: boolean;
  enforceDesk?: boolean;
  deskHours?: number;
  bypassUserIds?: number[];
  failOpen?: boolean;
}

/** Save the given fields. Validation and the lockout rules are the route's (api/admin/duo); this only writes. */
export async function saveDuoSettings(patch: DuoSettingsPatch, opts: { credentialsChanged: boolean }): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (patch.clientId !== undefined) jobs.push(setSetting(DUO_KEYS.clientId, patch.clientId));
  if (patch.clientSecret) jobs.push(setSetting(DUO_KEYS.clientSecret, patch.clientSecret));
  if (patch.apiHost !== undefined) jobs.push(setSetting(DUO_KEYS.apiHost, patch.apiHost));
  if (patch.usernameSource !== undefined) jobs.push(setSetting(DUO_KEYS.usernameSource, patch.usernameSource));
  if (patch.enforceSignIn !== undefined) jobs.push(setSetting(DUO_KEYS.enforceSignIn, patch.enforceSignIn ? "1" : "0"));
  if (patch.enforceDesk !== undefined) jobs.push(setSetting(DUO_KEYS.enforceDesk, patch.enforceDesk ? "1" : "0"));
  if (patch.deskHours !== undefined) jobs.push(setSetting(DUO_KEYS.deskHours, String(clampDeskHours(patch.deskHours))));
  if (patch.bypassUserIds !== undefined) {
    jobs.push(setSetting(DUO_KEYS.bypass, JSON.stringify([...new Set(patch.bypassUserIds)].slice(0, DUO_BYPASS_MAX))));
  }
  if (patch.failOpen !== undefined) jobs.push(setSetting(DUO_KEYS.failOpen, patch.failOpen ? "1" : "0"));
  if (opts.credentialsChanged) {
    // A new revision: the earlier test approval was for other credentials.
    jobs.push(setSetting(DUO_KEYS.rev, randomBytes(12).toString("hex")));
    jobs.push(setSetting(DUO_KEYS.verified, ""));
  }
  await Promise.all(jobs);
}

/** Record a successful "Test with my account" for the credentials at `rev`, by this session. */
export async function recordDuoVerified(input: { rev: string; sid: string; userId: number }): Promise<void> {
  await setSetting(
    DUO_KEYS.verified,
    JSON.stringify({ rev: input.rev, sid: input.sid, user_id: input.userId, at: new Date().toISOString() })
  );
}

/** Remove everything Duo: the credentials, both rules, the bypass list. */
export async function clearDuoSettings(): Promise<void> {
  await Promise.all(
    Object.values(DUO_KEYS).map((k) => setSetting(k, k === DUO_KEYS.enforceSignIn || k === DUO_KEYS.enforceDesk || k === DUO_KEYS.failOpen ? "0" : ""))
  );
}

/**
 * Has `sid` (a session's sid) completed a test approval against the
 * credentials now saved? Turning a rule on asks this, so the person turning
 * it on has just proved, in this very session, that Duo works for them with
 * what is saved.
 */
export function duoVerifiedBy(s: DuoSettings, sid: string, userId: number): boolean {
  return Boolean(s.rev && s.verified && s.verified.rev === s.rev && s.verified.sid === sid && s.verified.user_id === userId);
}
