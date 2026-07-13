// Accessor for the enterprise overlay. `@ee` is a build alias that resolves to
// the community stub (open-source build) or the private enterprise package
// (enterprise build) — see next.config.js. Core code only ever touches this
// module, never enterprise source directly.

import edition from "@ee";
import type { EnterpriseEdition } from "@/ee-contract";
import { licenseGrants } from "./license";
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
