// Offline enterprise license verification.
//
// A license is a signed token: base64url(payloadJSON) + "." + base64url(sig),
// signed with the vendor's Ed25519 private key. The matching PUBLIC key is
// embedded below (safe to ship — it can only verify, not mint). Verification is
// fully offline: no phone-home, works air-gapped.
//
// This gate lives in the open-source core so the Community edition honors it
// too. The gate has two independent questions:
//   1. Presence  — is the enterprise CODE in this build at all? (see lib/ee.ts)
//   2. License   — does a valid signed license grant this feature?
// A feature is active only when BOTH are true. Core always fails OPEN: an absent
// or expired license only disables enterprise features, never core.
//
// Server-only.

import { verify } from "node:crypto";
import { getSetting } from "./db";
import { INCLUDED_AGENTS } from "./agent-allowance";

// Vendor Ed25519 public key (SPKI PEM). This is the production CompassDocs
// license-signing public key; the matching private key lives only in the vendor
// signing portal. Safe to ship — it can only verify, never mint.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3zj2D3VLyIij/SovtpZWwY1xFrX8F6n876GPISVnxE0=
-----END PUBLIC KEY-----`;

// Days a license keeps working past its expiry (soft grace) before features
// switch off — avoids a renewal-paperwork lapse breaking, e.g., SSO.
const GRACE_DAYS = 14;

export type EntitlementFeature =
  | "sso"
  | "scim"
  | "audit_export"
  | "priority_support"
  | "directory_sync"
  | "policy_ack"
  | "training"
  | "helpdesk";

export interface License {
  /** Opaque license id (for a future revocation list). */
  id: string;
  /** Customer / organization name. */
  customer: string;
  /** Marketing plan label (e.g. "enterprise"). */
  plan: string;
  /** Granted feature entitlements. */
  features: EntitlementFeature[];
  /** Seat (active-user) allowance; 0 = unlimited. */
  seats: number;
  /**
   * Helpdesk agent allowance. Read it with agentsClaim(), never directly:
   * absent (keys minted before agent allowances) or -1 means unlimited, a
   * positive integer is the allowance (the 3 included plus any bought), and
   * anything else is invalid and reads as the 3 included.
   */
  agents?: number;
  /** ISO date the license was issued. */
  issued: string;
  /** ISO date the license expires. */
  expires: string;
}

export type LicenseState =
  | { status: "none" }
  | { status: "invalid"; reason: string }
  | { status: "active"; license: License; daysLeft: number }
  | { status: "grace"; license: License; daysLeft: number }
  | { status: "expired"; license: License };

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}

/** Parse + cryptographically verify a raw license token. Never throws. */
export function parseLicense(raw: string): { license?: License; error?: string } {
  const token = (raw || "").trim();
  if (!token) return {};
  const [body, sig] = token.split(".");
  if (!body || !sig) return { error: "Malformed license." };
  try {
    const payload = Buffer.from(body, "base64url");
    if (!verify(null, payload, PUBLIC_KEY, Buffer.from(sig, "base64url"))) {
      return { error: "Signature does not match — check the key or reissue." };
    }
    const lic = JSON.parse(payload.toString()) as License;
    if (!lic.customer || !Array.isArray(lic.features) || !lic.expires) {
      return { error: "License is missing required fields." };
    }
    return { license: lic };
  } catch (e: any) {
    return { error: `Could not read license: ${e?.message || e}` };
  }
}

/** Interpret a verified license against the current date. */
export function evaluate(raw: string, now = new Date()): LicenseState {
  const { license, error } = parseLicense(raw);
  if (error) return { status: "invalid", reason: error };
  if (!license) return { status: "none" };

  const expires = new Date(license.expires);
  const graceEnd = new Date(expires.getTime() + GRACE_DAYS * 86_400_000);
  if (now <= expires) return { status: "active", license, daysLeft: daysBetween(now, expires) };
  if (now <= graceEnd) return { status: "grace", license, daysLeft: daysBetween(now, graceEnd) };
  return { status: "expired", license };
}

/** The effective license string: settings value, else the env var. */
export async function licenseKey(): Promise<string> {
  const stored = (await getSetting("license_key"))?.trim();
  return stored || process.env.COMPASSDOCS_LICENSE_KEY?.trim() || "";
}

/** Where the effective license comes from (for the admin UI). */
export async function licenseSource(): Promise<"settings" | "env" | "none"> {
  if ((await getSetting("license_key"))?.trim()) return "settings";
  if (process.env.COMPASSDOCS_LICENSE_KEY?.trim()) return "env";
  return "none";
}

export async function licenseState(): Promise<LicenseState> {
  return evaluate(await licenseKey());
}

// Features every Enterprise licence carries, whether or not the key lists
// them. Keys issued before 1.19 predate the helpdesk, and Enterprise
// includes it, so an upgrade must not find it locked.
const ENTERPRISE_IMPLIES: EntitlementFeature[] = ["helpdesk"];

/** The features a verified licence grants: the key's list, plus what its
 *  plan always includes. */
export function effectiveFeatures(license: Pick<License, "plan" | "features">): EntitlementFeature[] {
  const listed = Array.isArray(license.features) ? license.features : [];
  const plan = String(license.plan || "").trim().toLowerCase();
  if (plan !== "enterprise") return listed;
  return [...listed, ...ENTERPRISE_IMPLIES.filter((f) => !listed.includes(f))];
}

/** True when a valid (active or in-grace) license grants `feature`. */
export async function licenseGrants(feature: EntitlementFeature): Promise<boolean> {
  const s = await licenseState();
  if (s.status !== "active" && s.status !== "grace") return false;
  return effectiveFeatures(s.license).includes(feature);
}

/** Seat check. Returns { ok, limit } — limit 0 means unlimited. */
export async function withinSeatLimit(activeUsers: number): Promise<{ ok: boolean; limit: number }> {
  const s = await licenseState();
  const limit = s.status === "active" || s.status === "grace" ? s.license.seats : 0;
  return { ok: limit === 0 || activeUsers <= limit, limit };
}

// --- Helpdesk agents ----------------------------------------------------------

/** Helpdesk agents every licence with the helpdesk includes (client-safe, in lib/agent-allowance). */
export { INCLUDED_AGENTS };

/** How a customer adds helpdesk agents: the docs explain the Manage subscription link in the licence email (new purchases go through the pricing page). */
export const BUY_AGENTS_URL = "https://docs.compassdocs.io/admin/license/#helpdesk-agents";

/** The `agents` value that means unlimited, if unlimited is ever sold. */
export const UNLIMITED_AGENTS = -1;

/**
 * The agent allowance a licence's `agents` claim grants; null = unlimited.
 *
 *   absent (undefined)      unlimited: keys minted before agent allowances
 *                           (existing customers keep unlimited agents)
 *   -1                      unlimited, explicitly
 *   a positive integer      that many agents
 *   anything else           INVALID: 0, other negatives, fractions, numbers
 *                           past 2^53, strings, null, NaN. Reads as the 3
 *                           included agents.
 *
 * Why invalid reads as 3 and never as unlimited: the claim is signed, so an
 * invalid value can only come from a mint path that went wrong (an add-on
 * line merged badly, a price without `agents` metadata writing 0). Reading
 * it as unlimited would fail open on exactly the keys that were sold with
 * a limit; reading it as 3 grants what every helpdesk licence includes, and
 * nobody loses desk access over it, because the limit only refuses new
 * additions (setDeskAgent) and never removes anyone. JSON `null` is a
 * present-but-invalid claim, not an absent one.
 */
export function agentsClaim(license: Pick<License, "agents">): number | null {
  if (!("agents" in license) || license.agents === undefined) return null;
  const v: unknown = license.agents;
  if (v === UNLIMITED_AGENTS) return null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
  return INCLUDED_AGENTS;
}

/**
 * The agent allowance in force for a licence state; null = unlimited (no
 * limit is enforced). Only an active licence limits agents: in grace the
 * limit is not enforced (core fails open while a renewal is sorted out),
 * and with no, an invalid or an expired licence the helpdesk itself is off
 * (community builds don't have it), so there is nothing to count against.
 */
export function agentAllowanceFor(s: LicenseState): number | null {
  return s.status === "active" ? agentsClaim(s.license) : null;
}

/** The helpdesk agent allowance in force now; null = unlimited. */
export async function agentAllowance(): Promise<number | null> {
  return agentAllowanceFor(await licenseState());
}

export interface AgentLimit {
  /** The allowance in force (agentAllowanceFor); null = nothing is enforced. */
  allowed: number | null;
  /** The key's own allowance (agentsClaim) whatever the state; null = unlimited, or no licence. */
  licensed: number | null;
}

/** Both readings of a licence state: what is enforced, and what the key says (for display, e.g. in grace). */
export function agentLimitFor(s: LicenseState): AgentLimit {
  return { allowed: agentAllowanceFor(s), licensed: "license" in s ? agentsClaim(s.license) : null };
}

/** agentLimitFor the licence now (one licence read). */
export async function agentLimit(): Promise<AgentLimit> {
  return agentLimitFor(await licenseState());
}
