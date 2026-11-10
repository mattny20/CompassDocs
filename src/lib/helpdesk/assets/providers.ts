// Helpdesk 1.19.3: what an asset source ("provider") must offer. Callers in
// lib/helpdesk/assets only ever use this interface and the registry below;
// the second source (Microsoft Intune, 1.19.4, ./intune) is one more factory
// in PROVIDER_FACTORIES and one more card in Desk settings → Assets. Maintenance is optional: a read-only source leaves it out
// and the solve flow never offers it. Server-only.

import "server-only";
import type { HdMaintenanceRecord } from "../assets-shared";

/** One asset as a source describes it, already normalised (the cache's columns). */
export interface ProviderAsset {
  external_id: string;
  tag: string;
  serial: string;
  name: string;
  model: string;
  category: string;
  status_label: string;
  status_kind: string;
  /** Lower-cased; "" when the asset is not with a person. */
  assigned_email: string;
  /** A second address the person is known by (Intune's user principal name), lower-cased; matched like assigned_email. */
  assigned_upn?: string;
  assigned_name: string;
  location: string;
  /** YYYY-MM-DD or null. */
  purchase_date: string | null;
  warranty_end: string | null;
  url: string;
  /** A few source fields worth keeping (never custom fields). */
  raw: Record<string, unknown>;
}

export interface MaintenanceInput {
  external_id: string;
  type: string;
  supplier_id: number | null;
  title: string;
  note: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface AssetProvider {
  /** The cache key (hd_assets.provider): "snipeit". */
  key: string;
  label: string;
  /**
   * The source identity it was built for (Intune: the tenant ID), so a write
   * from a provider built before the source changed can be refused
   * (lib/helpdesk/assets sourceStill). Unset: not checked.
   */
  source?: string;
  /** Sign in and say which source these credentials reach (Intune: the tenant ID the token is for). */
  identity?(): Promise<string>;
  /** Prove the address and key work; the number of assets the source holds. */
  test(): Promise<{ total: number }>;
  /**
   * Every asset, page by page (the sweep and Sync now). Resolves with the
   * total the source reported, how many came back, and whether the pass
   * read them all (false when it stopped early: the page cap, an empty page
   * before the total); only a complete pass may remove anything.
   */
  listAll(onPage: (assets: ProviderAsset[]) => Promise<void>): Promise<{ total: number; seen: number; complete: boolean }>;
  search(q: string, limit: number): Promise<ProviderAsset[]>;
  byTag(tag: string): Promise<ProviderAsset | null>;
  bySerial(serial: string): Promise<ProviderAsset[]>;
  /** The assets checked out to the person with this address; null when the source has no such person. */
  forEmail(email: string): Promise<ProviderAsset[] | null>;
  get(externalId: string): Promise<ProviderAsset | null>;
  maintenance?: {
    list(externalId: string): Promise<HdMaintenanceRecord[]>;
    log(input: MaintenanceInput): Promise<{ id: string }>;
    suppliers(): Promise<{ id: number; name: string }[]>;
  };
}

/** What a factory gets: the stored settings of that source, the key opened. */
export interface ProviderConfig {
  url: string;
  token: string;
  /** The cache key to use (tests stamp their own). */
  key: string;
  timeoutMs?: number;
  /** Intune: the Entra tenant and the app registration's client ID (token is its secret). */
  tenant?: string;
  clientId?: string;
  /** Intune: the tenant ID this provider is for (lib/helpdesk/assets/intune refuses another's token). */
  expectTid?: string;
  /** Intune: still signing in as the directory sync's app registration (an install connected before 1.20.2): errors name that app. */
  legacyApp?: boolean;
}

/**
 * The sources this build knows, by settings key. lib/helpdesk/assets builds
 * the configured ones (activeProviders) and asks nothing else of them.
 */
export const PROVIDER_FACTORIES: Record<string, (cfg: ProviderConfig) => Promise<AssetProvider>> = {
  snipeit: async (cfg) => (await import("./snipeit")).snipeItProvider(cfg),
  intune: async (cfg) => (await import("./intune")).intuneProvider({ ...cfg, tenant: cfg.tenant ?? "", clientId: cfg.clientId ?? "" }),
};
