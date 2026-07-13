// Configuration for the enterprise Microsoft Graph directory sync. Lives in the
// core so the settings survive edition switches and the admin UI can manage
// them; the sync itself is implemented in the enterprise overlay.
//
// The client secret is write-only: stored here, surfaced only as "set / not set".
// Server-only.

import { getSetting, setSetting } from "./db";

const KEYS = {
  tenant: "directory_graph_tenant",
  clientId: "directory_graph_client_id",
  clientSecret: "directory_graph_client_secret",
  group: "directory_graph_group",
  includeGuests: "directory_include_guests",
  requireTitle: "directory_require_title",
  requirePhone: "directory_require_phone",
  photos: "directory_photos",
  lastSync: "directory_last_sync",
} as const;

export interface DirectoryGraphConfig {
  tenant: string;
  clientId: string;
  clientSecret: string; // never send to the client
  group: string; // optional Entra group id — when set, only its members sync
  includeGuests: boolean; // default false (members only)
  requireTitle: boolean; // default false
  requirePhone: boolean; // default false
  photos: boolean; // default true
}

export interface DirectorySyncStatus {
  at: string;
  ok: boolean;
  count?: number;
  error?: string;
}

export async function getDirectoryGraphConfig(): Promise<DirectoryGraphConfig> {
  const [tenant, clientId, clientSecret, group, guests, title, phone, photos] =
    await Promise.all([
      getSetting(KEYS.tenant),
      getSetting(KEYS.clientId),
      getSetting(KEYS.clientSecret),
      getSetting(KEYS.group),
      getSetting(KEYS.includeGuests),
      getSetting(KEYS.requireTitle),
      getSetting(KEYS.requirePhone),
      getSetting(KEYS.photos),
    ]);
  return {
    tenant: tenant?.trim() || "",
    clientId: clientId?.trim() || "",
    clientSecret: clientSecret || "",
    group: group?.trim() || "",
    includeGuests: guests === "1",
    requireTitle: title === "1",
    requirePhone: phone === "1",
    photos: photos !== "0",
  };
}

export async function updateDirectoryGraphConfig(
  patch: Partial<DirectoryGraphConfig>
): Promise<void> {
  const bool = (v: boolean) => (v ? "1" : "0");
  if (patch.tenant !== undefined) await setSetting(KEYS.tenant, patch.tenant.trim());
  if (patch.clientId !== undefined) await setSetting(KEYS.clientId, patch.clientId.trim());
  // Empty string clears the secret; undefined leaves it untouched.
  if (patch.clientSecret !== undefined) await setSetting(KEYS.clientSecret, patch.clientSecret);
  if (patch.group !== undefined) await setSetting(KEYS.group, patch.group.trim());
  if (patch.includeGuests !== undefined) await setSetting(KEYS.includeGuests, bool(patch.includeGuests));
  if (patch.requireTitle !== undefined) await setSetting(KEYS.requireTitle, bool(patch.requireTitle));
  if (patch.requirePhone !== undefined) await setSetting(KEYS.requirePhone, bool(patch.requirePhone));
  if (patch.photos !== undefined) await setSetting(KEYS.photos, bool(patch.photos));
}

export async function getDirectorySyncStatus(): Promise<DirectorySyncStatus | null> {
  const raw = await getSetting(KEYS.lastSync);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DirectorySyncStatus;
  } catch {
    return null;
  }
}

export async function setDirectorySyncStatus(s: DirectorySyncStatus): Promise<void> {
  await setSetting(KEYS.lastSync, JSON.stringify(s));
}
