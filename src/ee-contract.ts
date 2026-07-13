// The contract between the open-source core and the (private) enterprise
// overlay. Core depends ONLY on this interface — never on enterprise source.
// The community stub (src/ee-stub) and the real enterprise package both provide
// a default export satisfying `EnterpriseEdition`. Which one is bundled is
// decided by the `@ee` build alias (see next.config.js).

import type { EntitlementFeature } from "@/lib/license";

export interface EnterpriseEdition {
  /** True only in an enterprise build; false in the community stub. */
  readonly present: boolean;

  /** Entitlements the bundled enterprise features cover. */
  readonly features: EntitlementFeature[];

  /**
   * Handle an `/api/ee/*` request (SSO callbacks, SCIM, etc.). Core mounts a
   * catch-all route that forwards here; the stub simply 404s.
   */
  dispatch?(method: string, slug: string[], req: Request): Promise<Response>;

  /** Enterprise audit-log export (CSV/JSON), gated by the `audit_export` entitlement. */
  exportAuditLog?(format: "csv" | "json"): Promise<{ filename: string; body: string }>;
}
