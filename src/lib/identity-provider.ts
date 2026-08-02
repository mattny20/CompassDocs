// The identity-provider seam: what CompassDocs needs from a corporate directory,
// stated once so Microsoft and Google are peers rather than one implementation
// and one special case.
//
// Types only — no network code, no credentials, no vendor SDK. The execution
// lives in the enterprise overlay (`ee/`), which is where the entitlement gate
// and the vendor clients belong; core holds the shapes, the config, and the
// write paths so that a downgrade to the community build leaves a directory
// that still reads correctly.
//
// Deliberately NOT an abstraction over "SSO". Sign-in is already vendor-neutral
// (OIDC/SAML), and the one Microsoft-shaped part of it is a single URL — see
// `ssoAuthority` in lib/sso-config. This interface is about *provisioning*:
// pulling people and groups in, on a schedule, and reconciling them with what
// is already here.
//
// Server-only.

import "server-only";
import type { PersonSource } from "./directory";

export type ProviderKey = "microsoft" | "google";

/**
 * One person as a provider reports them, normalised.
 *
 * Everything is a plain string because the directory renders strings; the
 * provider adapter is where `organizations[primary].costCenter` becomes
 * `custom["cost_center"]`. Fields the provider doesn't supply come through as
 * "" rather than undefined, so a sync can't half-clear a row by accident.
 */
export interface ProviderPerson {
  /** Immutable provider id. Never an email — those get reassigned. */
  external_id: string;
  name: string;
  title: string;
  department: string;
  email: string;
  phone: string;
  mobile: string;
  office: string;
  /** A `data:` URL. Omit to keep whatever is already stored. */
  photo?: string;
  /** Cheap change check, so an unchanged photo isn't refetched every run. */
  photo_etag?: string;
  custom: Record<string, string>;
  /** The provider says this account is inactive (suspended/blocked/archived). */
  suspended: boolean;
}

export interface ProviderGroup {
  external_id: string;
  name: string;
  /** Provider ids of members, already flattened through any nesting. */
  member_external_ids: string[];
}

/**
 * What a directory provider must be able to do.
 *
 * Both methods return everything rather than streaming: a workspace directory
 * is thousands of people, not millions, and a whole-set return is what makes
 * the reconcile in `replaceProviderPeople` a single transaction with a
 * meaningful "these disappeared" set. If that stops being true the interface
 * changes shape, and it should — not the write path.
 */
export interface IdentityProvider {
  readonly key: ProviderKey;
  /** How rows this provider owns are tagged in `directory_people.source`. */
  readonly personSource: Exclude<PersonSource, "manual">;
  /** How groups it owns are tagged in `groups.source`. */
  readonly groupSource: string;
  /**
   * Which column of `directory_fields` holds this provider's attribute path.
   * Microsoft paths (`onPremisesExtensionAttributes.extensionAttribute1`) and
   * Google paths (`customSchemas.HR.employee_id`) are structurally different,
   * so they get a column each and the mapping UI renders one input per
   * configured provider instead of one generic input meaning two things.
   */
  readonly fieldPathColumn: "graph_path" | "google_path";

  /** Is this provider configured enough to attempt a sync? */
  configured(): Promise<boolean>;
  /** Verify credentials and reachability without writing anything. */
  probe(): Promise<{ ok: boolean; detail: string }>;

  listPeople(): Promise<ProviderPerson[]>;
  listGroups(): Promise<ProviderGroup[]>;
}

/**
 * The outcome of one sync run, for the admin console and the audit log.
 *
 * `abortedDelete` is set when the removal brake in `replaceProviderPeople`
 * tripped: the upserts committed, the deletions did not, and a human needs to
 * look. It is a string rather than a boolean because the number that tripped it
 * is the useful part.
 */
export interface SyncOutcome {
  provider: ProviderKey;
  people: { upserted: number; deleted: number; abortedDelete?: string };
  groups?: { matched: number; created: number; membersLinked: number };
  ranAt: string;
}
