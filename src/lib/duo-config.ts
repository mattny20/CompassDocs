// The Duo sign-in check (1.20.5): reading and saving its settings, and the
// three facts the decision needs that are not settings (the server's escape
// hatch, the licence, the test seam). The decision itself is in
// lib/duo-policy; the Duo calls are in lib/duo. Server-only.

import "server-only";
import { randomBytes } from "node:crypto";
import { getAllSettings, withAdvisoryLock } from "./db";
import { openSecret, sealSecret } from "./secretbox";
import { normalizeDomain } from "./settings";
import { featureEnabledFrom } from "./ee";
import {
  DUO_BYPASS_MAX,
  DUO_KEYS,
  clampDeskHours,
  cleanOrigin,
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

/**
 * One writer at a time (1.20.5). Everything that changes the Duo settings
 * (the settings route, a passed test recording itself) reads what is saved
 * and writes inside one transaction holding one advisory lock, so two
 * requests cannot interleave and leave a rule on beside credentials nobody
 * tested: the second one reads what the first one wrote, and decides again.
 * Every query goes through the lock's own connection (db withAdvisoryLock).
 */
export interface DuoSettingsTx {
  /** What is saved right now. */
  read(): Promise<DuoSettings>;
  /** Save the given fields. Validation and the lockout rules are the caller's; this only writes. */
  write(patch: DuoSettingsPatch, opts: { configChanged: boolean }): Promise<void>;
  /** Record a passed "Test with my account". */
  recordVerified(input: { rev: string; sid: string; userId: number; origin: string }): Promise<void>;
}

export async function withDuoSettings<T>(fn: (tx: DuoSettingsTx) => Promise<T>): Promise<T> {
  return withAdvisoryLock("duo-settings", async (client) => {
    const set = (key: string, value: string) =>
      client.query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
        key,
        key === DUO_KEYS.clientSecret ? sealSecret(value) : value,
      ]);
    return fn({
      async read() {
        const { rows } = await client.query("SELECT key, value FROM settings WHERE key = ANY($1)", [Object.values(DUO_KEYS)]);
        const map: Record<string, string> = {};
        for (const r of rows as { key: string; value: string }[]) map[r.key] = openSecret(r.value);
        return duoSettingsFrom(map);
      },
      async write(patch, opts) {
        if (patch.clientId !== undefined) await set(DUO_KEYS.clientId, patch.clientId);
        if (patch.clientSecret) await set(DUO_KEYS.clientSecret, patch.clientSecret);
        if (patch.apiHost !== undefined) await set(DUO_KEYS.apiHost, patch.apiHost);
        if (patch.usernameSource !== undefined) await set(DUO_KEYS.usernameSource, patch.usernameSource);
        if (patch.enforceSignIn !== undefined) await set(DUO_KEYS.enforceSignIn, patch.enforceSignIn ? "1" : "0");
        if (patch.enforceDesk !== undefined) await set(DUO_KEYS.enforceDesk, patch.enforceDesk ? "1" : "0");
        if (patch.deskHours !== undefined) await set(DUO_KEYS.deskHours, String(clampDeskHours(patch.deskHours)));
        if (patch.bypassUserIds !== undefined) {
          await set(DUO_KEYS.bypass, JSON.stringify([...new Set(patch.bypassUserIds)].slice(0, DUO_BYPASS_MAX)));
        }
        if (patch.failOpen !== undefined) await set(DUO_KEYS.failOpen, patch.failOpen ? "1" : "0");
        if (opts.configChanged) {
          // A new revision: the earlier test approval was for another configuration.
          await set(DUO_KEYS.rev, randomBytes(12).toString("hex"));
          await set(DUO_KEYS.verified, "");
        }
      },
      async recordVerified(input) {
        await set(
          DUO_KEYS.verified,
          JSON.stringify({ rev: input.rev, sid: input.sid, user_id: input.userId, at: new Date().toISOString(), origin: input.origin })
        );
      },
    });
  });
}

/**
 * The address Duo sends the browser back to (1.20.5). NEVER the request's
 * own Host or X-Forwarded-Host: whoever sends the request writes those, and
 * a signed Duo link that returns to a host of their choosing would hand them
 * someone else's approval. Two sources only:
 *
 *   1. the workspace's custom domain (Settings → Domain & HTTPS), when set;
 *   2. otherwise the address the passed "Test with my account" was run on,
 *      which the test recorded (duo_verified.origin). A sign-in step from
 *      any other address is refused with a sentence naming the right one.
 *
 * The test itself may use the address it was asked on (there is nothing
 * else to go by yet), and that is what gets recorded. While a rule is in
 * force the test must come from the recorded address too, so a second test
 * cannot move it under everyone's feet.
 */
export type DuoReturnOrigin = { ok: true; origin: string } | { ok: false; reason: "not_tested" | "other_address"; pinned: string };

export function duoReturnOrigin(map: Record<string, string>, requestOrigin: string, purpose: "signin" | "test"): DuoReturnOrigin {
  const domain = normalizeDomain(map.custom_domain || "");
  if (domain) return { ok: true, origin: `https://${domain}` };
  const cfg = duoSettingsFrom(map);
  const pinned = cfg.rev && cfg.verified && cfg.verified.rev === cfg.rev ? cfg.verified.origin : "";
  if (purpose === "test") {
    const asked = cleanOrigin(requestOrigin);
    if (!asked) return { ok: false, reason: "other_address", pinned };
    if (pinned && asked !== pinned && duoPolicyFromSettings(map)) return { ok: false, reason: "other_address", pinned };
    return { ok: true, origin: asked };
  }
  if (!pinned) return { ok: false, reason: "not_tested", pinned: "" };
  if (requestOrigin !== pinned) return { ok: false, reason: "other_address", pinned };
  return { ok: true, origin: pinned };
}

/**
 * Has `sid` (a session's sid) completed a test approval against the
 * credentials now saved? Turning a rule on asks this, so the person turning
 * it on has just proved, in this very session, that Duo works for them with
 * what is saved.
 */
export function duoVerifiedBy(s: DuoSettings, sid: string, userId: number): boolean {
  return Boolean(s.rev && s.verified && s.verified.rev === s.rev && s.verified.sid === sid && s.verified.user_id === userId && s.verified.origin);
}
