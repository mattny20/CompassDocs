// Accessor for the enterprise overlay. `@ee` is a build alias that resolves to
// the community stub (open-source build) or the private enterprise package
// (enterprise build) — see next.config.js. Core code only ever touches this
// module, never enterprise source directly.

import edition from "@ee";
import type { EnterpriseEdition } from "@/ee-contract";
import { effectiveFeatures, evaluate, licenseGrants } from "./license";
import type { EntitlementFeature } from "./license";

export function ee(): EnterpriseEdition {
  return edition as EnterpriseEdition;
}

/** True when this build actually contains enterprise code. */
export function eePresent(): boolean {
  return !!ee().present;
}

/**
 * A feature is usable only when BOTH the code is in this build AND a valid
 * license grants it. Use this to gate enterprise API routes and UI.
 */
export async function featureEnabled(feature: EntitlementFeature): Promise<boolean> {
  if (!ee().features.includes(feature)) return false;
  return licenseGrants(feature);
}

// The licence answer for a key, remembered for a minute: featureEnabledFrom
// runs on every request of a workspace that enforces Duo, and verifying the
// key's signature each time would be wasted work.
let fromMemo: { key: string; until: number; features: EntitlementFeature[] } | null = null;

/**
 * featureEnabled for a caller that already holds the settings map (1.20.5:
 * the Duo sign-in check, which runs inside the session check and must not
 * add a query to it). Same answer as featureEnabled: the code is in this
 * build AND a licence that is active or in its grace grants the feature. The
 * key is the map's `license_key`, else the environment's, as in lib/license.
 */
export function featureEnabledFrom(feature: EntitlementFeature, settings: Record<string, string>): boolean {
  if (!ee().features.includes(feature)) return false;
  const key = (settings.license_key || "").trim() || process.env.COMPASSDOCS_LICENSE_KEY?.trim() || "";
  const now = Date.now();
  if (!fromMemo || fromMemo.key !== key || now >= fromMemo.until) {
    const state = evaluate(key);
    const features = state.status === "active" || state.status === "grace" ? effectiveFeatures(state.license) : [];
    fromMemo = { key, until: now + 60_000, features };
  }
  return fromMemo.features.includes(feature);
}
