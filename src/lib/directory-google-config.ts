// Configuration for the enterprise Google Workspace directory sync. Lives in
// core so the settings survive edition switches and the admin UI can manage
// them; the sync itself is implemented in the enterprise overlay.
//
// A sibling of directory-config.ts rather than a generalisation of it. The two
// vendors want genuinely different fields — a tenant GUID and a client secret
// against a service-account key and an impersonated admin — and one union-typed
// config module serving both would be a shape that fits neither, plus a
// breaking change to the DirectorySettings API contract for no gain.
//
// The service-account key is write-only: stored sealed, surfaced only as
// "set / not set". Server-only.

import "server-only";
import { getSetting, setSetting } from "./db";

const KEYS = {
  serviceAccount: "directory_google_service_account",
  adminEmail: "directory_google_admin_email",
  customerId: "directory_google_customer_id",
  group: "directory_google_group",
  includeSuspended: "directory_google_include_suspended",
  photos: "directory_google_photos",
  lastSync: "directory_google_last_sync",
} as const;

export interface DirectoryGoogleConfig {
  /** The service-account JSON key. Never sent to the client. */
  serviceAccount: string;
  /**
   * The Workspace admin to impersonate.
   *
   * Google's Directory API has no application-level access: a service account
   * reads the directory by acting as a real administrator through domain-wide
   * delegation. So this is required, not optional, and it is the field people
   * get wrong — hence its own setting rather than a line in a JSON blob.
   */
  adminEmail: string;
  /** Usually "my_customer", which resolves to the impersonated admin's account. */
  customerId: string;
  /** Optional group email — when set, only its members sync. */
  group: string;
  /** Include suspended accounts (default false). */
  includeSuspended: boolean;
  /** Fetch profile photos (default true). */
  photos: boolean;
}

export async function getDirectoryGoogleConfig(): Promise<DirectoryGoogleConfig> {
  const [serviceAccount, adminEmail, customerId, group, suspended, photos] = await Promise.all([
    getSetting(KEYS.serviceAccount),
    getSetting(KEYS.adminEmail),
    getSetting(KEYS.customerId),
    getSetting(KEYS.group),
    getSetting(KEYS.includeSuspended),
    getSetting(KEYS.photos),
  ]);
  return {
    serviceAccount: serviceAccount || "",
    adminEmail: adminEmail?.trim() || "",
    customerId: customerId?.trim() || "my_customer",
    group: group?.trim() || "",
    includeSuspended: suspended === "1",
    photos: photos !== "0",
  };
}

/**
 * Enough to attempt a sync. Deliberately checks the admin email as well as the
 * key: with a valid key and no impersonation target, every Directory API call
 * returns a 403 that reads like a permissions problem, and the actual cause is
 * a blank field two panels away.
 */
export function googleDirectoryConfigured(cfg: DirectoryGoogleConfig): boolean {
  return Boolean(cfg.serviceAccount && cfg.adminEmail);
}

/** Shape-check a pasted service-account key before storing it. */
export function serviceAccountProblem(raw: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "That isn't valid JSON. Paste the whole key file Google downloaded.";
  }
  if (parsed.type !== "service_account") {
    return 'This looks like the wrong file — a service-account key has "type": "service_account".';
  }
  for (const field of ["client_email", "private_key"] as const) {
    if (typeof parsed[field] !== "string" || !parsed[field]) {
      return `The key is missing ${field}. Download it again from the Google Cloud console.`;
    }
  }
  return null;
}

/** The client id a Workspace admin pastes when granting domain-wide delegation. */
export function serviceAccountClientId(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.client_id === "string" ? parsed.client_id : "";
  } catch {
    return "";
  }
}

export async function updateDirectoryGoogleConfig(
  patch: Partial<DirectoryGoogleConfig>
): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (patch.serviceAccount !== undefined)
    jobs.push(setSetting(KEYS.serviceAccount, patch.serviceAccount));
  if (patch.adminEmail !== undefined)
    jobs.push(setSetting(KEYS.adminEmail, patch.adminEmail.trim()));
  if (patch.customerId !== undefined)
    jobs.push(setSetting(KEYS.customerId, patch.customerId.trim() || "my_customer"));
  if (patch.group !== undefined) jobs.push(setSetting(KEYS.group, patch.group.trim()));
  if (patch.includeSuspended !== undefined)
    jobs.push(setSetting(KEYS.includeSuspended, patch.includeSuspended ? "1" : "0"));
  if (patch.photos !== undefined) jobs.push(setSetting(KEYS.photos, patch.photos ? "1" : "0"));
  await Promise.all(jobs);
}

export async function getGoogleSyncStatus(): Promise<{
  at: string;
  ok: boolean;
  count?: number;
  error?: string;
} | null> {
  const raw = await getSetting(KEYS.lastSync);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setGoogleSyncStatus(status: {
  at: string;
  ok: boolean;
  count?: number;
  error?: string;
}): Promise<void> {
  await setSetting(KEYS.lastSync, JSON.stringify(status));
}

/**
 * The OAuth scopes a Workspace admin must authorise for the service account,
 * all read-only. Surfaced by the admin panel as copyable text because the
 * delegation screen wants them comma-separated and getting one character wrong
 * produces an unauthorized_client error with no indication of which scope.
 */
export const GOOGLE_DIRECTORY_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
] as const;
