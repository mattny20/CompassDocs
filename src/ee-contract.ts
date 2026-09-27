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

  /**
   * Enterprise audit-log export (CSV/JSON), gated by the `audit_export`
   * entitlement. Returns a complete streaming Response (download headers set)
   * so exports of any size stay memory-bounded.
   */
  exportAuditLog?(opts: AuditExportOptions): Promise<Response>;

  /**
   * Run (or preview) a directory sync for one provider, gated by the
   * `directory_sync` entitlement. Core's scheduler calls this on the hour;
   * the admin buttons go through dispatch(). Absent in the community stub.
   */
  runDirectorySync?(provider: DirectorySyncProvider, opts?: DirectorySyncOptions): Promise<DirectorySyncSummary>;
}

export type DirectorySyncProvider = "microsoft" | "google";

export interface DirectorySyncOptions {
  /** One run with the removal brake off. */
  allowRemovals?: boolean;
  /** Compute what would change and write nothing. */
  dryRun?: boolean;
}

export interface DirectorySyncSummary {
  count: number;
  deleted: number;
  warning?: string;
  blocked?: { doomed: number; total: number };
  /** Present on a dry run, and on a real run when the core reports it. */
  preview?: {
    adds: { name: string; email: string }[];
    changes: { name: string; email: string; changed?: string[] }[];
    removals: { name: string; email: string }[];
    adoptions: { name: string; email: string }[];
    unchanged: number;
  };
}

export interface AuditExportOptions {
  format: "csv" | "json";
  /** Action-category filter — the part before the first dot (e.g. "auth"). */
  category?: string;
  /** Restrict to a single actor's entries. */
  actorId?: number;
  /** ISO timestamps: entries at/after `from` and strictly before `to`. */
  from?: string;
  to?: string;
}
