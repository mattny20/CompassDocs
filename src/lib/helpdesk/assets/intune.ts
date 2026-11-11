// Helpdesk 1.19.4: the Microsoft Intune client (an AssetProvider). It signs
// in as the Microsoft 365 directory sync's own app registration (tenant,
// client ID and secret from lib/directory-config, kept there; nothing is
// stored twice) with the client-credentials grant, then reads managed
// devices from Microsoft Graph. Everything goes through
// lib/helpdesk/assets/http (https only, same-host redirects, 10 s, size cap,
// readable errors, the secret never logged or echoed).
//
// Endpoints:
//   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
//        client_credentials, scope https://graph.microsoft.com/.default
//   GET  https://graph.microsoft.com/v1.0/deviceManagement/managedDevices
//        ?$select=…&$top=500, then each @odata.nextLink (graph.microsoft.com only)
//   GET  …/managedDevices?$filter=serialNumber eq '…'           by serial
//   GET  …/managedDevices?$filter=userPrincipalName eq '…'      a person's
//   GET  …/managedDevices?$filter=emailAddress eq '…'           (both, merged)
//   GET  …/managedDevices/{id}                                  one device
//
// Graph needs the application permission DeviceManagementManagedDevices.
// Read.All on the app registration (with admin consent); a 403 says so in
// those words, and Desk settings → Assets shows it on the Intune card.
//
// A device is cached as: serial, name (deviceName), model, a category
// worked out from the OS, the person (emailAddress, else the UPN, as
// assigned_email; the UPN as assigned_upn, so either matches a confirmed
// account), a link to the device in the Intune admin centre, and raw
// { compliance, last_seen, os, os_version, manufacturer }. Intune has no
// asset tags. Intune is read-only: no maintenance.
//
// Tokens are cached in memory per (tenant, client ID, secret) until five
// minutes before they expire; a 401 from Graph drops the token and retries
// once, and a 403 drops it for the next call (1.20.4: a token keeps the
// permissions it was issued with). Paging backs off on 429 like Snipe-IT's.
//
// The source's identity is the tenant the token signs in to (its `tid`
// claim, else GET /organization), never the tenant text an admin typed: the
// GUID and a domain of one tenant are the same source (identity()). A
// provider built for one tenant (`source`) refuses a token for another, so
// nothing it reads can land in another tenant's cache. Server-only.

import "server-only";
import { createHash } from "node:crypto";
import { AssetHttpError, assetRequest } from "./http";
import type { AssetProvider, ProviderAsset, ProviderConfig } from "./providers";
import { INTUNE_PERMISSION } from "../assets-shared";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const LOGIN_HOST = "https://login.microsoftonline.com";
const LABEL = "Microsoft Intune";
const SELECT = "id,deviceName,serialNumber,model,manufacturer,operatingSystem,osVersion,complianceState,lastSyncDateTime,userPrincipalName,emailAddress,userDisplayName";
export const INTUNE_PAGE = 500;
const MAX_PAGES = 400;

let testPaging: { page: number; maxPages: number } | null = null;
/** Tests: a smaller page and page cap (null restores 500 and 400). */
export function setIntunePagingForTests(p: { page: number; maxPages: number } | null): void {
  testPaging = p;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Placeholder serials that would match unrelated devices. */
const JUNK_SERIAL = /^(0+|unknown|n\/?a|none|null|not available|default string|to be filled by o\.?e\.?m\.?|system serial number|serial number|123456789|chassis serial number)$/i;

/** A serial as the cache keeps it: "" when it's a placeholder or too short to match on. */
export function cleanSerial(v: unknown): string {
  const s = str(v);
  return s.length < 4 || JUNK_SERIAL.test(s) ? "" : s;
}

function category(os: string, model: string): string {
  const o = os.toLowerCase();
  if (/ipad/i.test(model) || o === "ipados") return "Tablet";
  if (o === "ios" || o === "android" || o.startsWith("android")) return "Phone";
  if (o === "windows" || o === "macos" || o === "linux" || o === "chromeos") return "Computer";
  return "";
}

/** The Intune admin centre's page of a device. */
export function intuneDeviceUrl(id: string): string {
  return `https://intune.microsoft.com/#view/Microsoft_Intune_Devices/DeviceSettingsMenuBlade/~/overview/mdmDeviceId/${encodeURIComponent(id)}`;
}

/** A managedDevice as the cache keeps it. */
export function normaliseDevice(row: unknown): ProviderAsset | null {
  const r = obj(row);
  const id = str(r?.id);
  if (!r || !id) return null;
  const model = str(r.model);
  const os = str(r.operatingSystem);
  const upn = str(r.userPrincipalName).toLowerCase();
  const mail = str(r.emailAddress).toLowerCase();
  const last = str(r.lastSyncDateTime);
  // Graph answers 0001-01-01 for "never".
  const lastSeen = last && !last.startsWith("0001-") && Number.isFinite(Date.parse(last)) ? new Date(last).toISOString() : null;
  return {
    external_id: id,
    tag: "",
    serial: cleanSerial(r.serialNumber),
    name: str(r.deviceName) || model || id,
    model,
    category: category(os, model),
    status_label: "",
    status_kind: "",
    assigned_email: mail || upn,
    assigned_upn: upn,
    assigned_name: upn || mail ? str(r.userDisplayName) : "",
    location: "",
    purchase_date: null,
    warranty_end: null,
    url: intuneDeviceUrl(id),
    raw: {
      compliance: str(r.complianceState) || "unknown",
      last_seen: lastSeen,
      os,
      os_version: str(r.osVersion),
      manufacturer: str(r.manufacturer) || undefined,
    },
  };
}

/** OData string literal ('' doubles a quote). */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface Token {
  value: string;
  expires: number;
  /** The token's tenant ID ("" until read; /organization fills it when the token says nothing). */
  tid: string;
}
const tokens = new Map<string, Token>();

/** Tests: forget cached tokens. */
export function clearIntuneTokensForTests(): void {
  tokens.clear();
}

export interface IntuneConfig extends ProviderConfig {
  tenant: string;
  clientId: string;
  /** The tenant ID (tid) this provider is for; a token for another tenant is refused. Unset: any (identity()). */
  expectTid?: string;
  legacyApp?: boolean;
}

/** The `tid` claim of an Entra access token (lower-cased), or "" when it can't be read. */
export function tokenTenantId(token: string): string {
  const part = token.split(".")[1];
  if (!part) return "";
  try {
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
    const tid = typeof claims.tid === "string" ? claims.tid.trim().toLowerCase() : "";
    return /^[0-9a-f-]{8,64}$/.test(tid) ? tid : "";
  } catch {
    return "";
  }
}

export function intuneProvider(cfg: IntuneConfig): AssetProvider {
  // 1.20.2: Intune signs in with its own app registration; an install that
  // still uses the directory sync's (cfg.legacyApp) is told about that one.
  const app = cfg.legacyApp ? "the directory sync app" : "the Intune app registration";
  const where = cfg.legacyApp ? "Settings, Directory, Microsoft 365 sync" : "Desk settings, Integrations, Microsoft Intune";
  const cacheKey = createHash("sha256").update(`${cfg.tenant}\n${cfg.clientId}\n${cfg.token}`).digest("hex");

  async function token(): Promise<string> {
    const t = tokens.get(cacheKey);
    if (t && t.expires > Date.now()) return t.value;
    let json: unknown;
    try {
      ({ json } = await assetRequest({
        url: `${LOGIN_HOST}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`,
        method: "POST",
        token: "",
        form: { grant_type: "client_credentials", client_id: cfg.clientId, client_secret: cfg.token, scope: "https://graph.microsoft.com/.default" },
        label: "Microsoft 365",
        timeoutMs: cfg.timeoutMs,
      }));
    } catch (e) {
      if (e instanceof AssetHttpError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        const code = e.detail ? ` (${e.detail})` : "";
        throw new AssetHttpError(
          `Microsoft 365 refused ${app}'s sign-in${code}. Check the tenant, client ID and secret in ${where}, and that the secret hasn't expired.`,
          e.status,
          "http",
          null,
          e.detail
        );
      }
      throw e;
    }
    const o = obj(json);
    const value = str(o?.access_token);
    if (!value) throw new AssetHttpError(`Microsoft 365 didn't hand out a token. Check ${app}.`, 200, "not_json");
    const secs = Number(o?.expires_in) || 3600;
    tokens.set(cacheKey, { value, expires: Date.now() + Math.max(60, secs - 300) * 1000, tid: tokenTenantId(value) });
    if (tokens.size > 20) tokens.delete(tokens.keys().next().value as string);
    return value;
  }

  /** The tenant the credentials sign in to: the token's tid, else GET /organization. */
  async function signedInTenant(): Promise<string> {
    const value = await token();
    const t = tokens.get(cacheKey);
    if (t?.tid) return t.tid;
    const { json } = await assetRequest({ url: `${GRAPH_BASE}/organization?$select=id`, token: value, label: LABEL, timeoutMs: cfg.timeoutMs });
    const v = obj(json)?.value;
    const id = Array.isArray(v) ? str(obj(v[0])?.id).toLowerCase() : "";
    if (!id) throw new AssetHttpError(`Microsoft Graph didn't say which tenant ${app} signed in to.`, 200, "not_json");
    if (t) t.tid = id;
    return id;
  }

  /** A token for the tenant this provider was built for; another tenant's is refused before any device is read. */
  async function bearerFor(): Promise<string> {
    const value = await token();
    if (cfg.expectTid && (await signedInTenant()) !== cfg.expectTid) {
      throw new AssetHttpError(`${app.charAt(0).toUpperCase()}${app.slice(1)} now signs in to a different Microsoft 365 tenant. Its devices are checked before they're shown.`, 0, "blocked");
    }
    return value;
  }

  /** One Graph GET with the token; a 401 drops the token and tries once more; a 403 names the permission. */
  async function graph(url: string): Promise<unknown> {
    if (!url.startsWith(`${GRAPH_BASE}/`)) throw new AssetHttpError("Microsoft Graph pointed the device list somewhere else, so it was not followed.", 0, "redirect");
    for (let attempt = 0; ; attempt++) {
      // The sign-in's own failures (a wrong secret) are said as such, never retried as Graph's 401.
      const bearer = await bearerFor();
      try {
        return (await assetRequest({ url, token: bearer, label: LABEL, timeoutMs: cfg.timeoutMs })).json;
      } catch (e) {
        if (e instanceof AssetHttpError && e.status === 401 && attempt === 0) {
          tokens.delete(cacheKey);
          continue;
        }
        if (e instanceof AssetHttpError && e.status === 401) {
          throw new AssetHttpError(`Microsoft Graph refused ${app}'s sign-in (401). Check the app registration in ${where}.`, 401, "http", null, e.detail);
        }
        if (e instanceof AssetHttpError && e.status === 403) {
          // 1.20.4: an app-only token carries the permissions the app had when it was issued. Drop it,
          // so the next call signs in again and sees a permission granted (or a consent that reached
          // Graph) since: a new app registration's first tokens can come before its consent has.
          tokens.delete(cacheKey);
          throw new AssetHttpError(
            `Microsoft Graph won't list managed devices (403). In Entra, give ${app} the ${INTUNE_PERMISSION} application permission and grant admin consent.`,
            403,
            "http",
            null,
            e.detail
          );
        }
        throw e;
      }
    }
  }

  /** A GET that backs off on 429 (background paging only). */
  async function patient(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await graph(url);
      } catch (e) {
        if (e instanceof AssetHttpError && e.status === 429 && attempt < 3) {
          await sleep(Math.min(30_000, e.retryAfterMs ?? 5_000 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  const devices = (json: unknown) => {
    const v = obj(json)?.value;
    return (Array.isArray(v) ? v : []).map(normaliseDevice).filter((a): a is ProviderAsset => a !== null);
  };
  const list = (query: string) => `${GRAPH_BASE}/deviceManagement/managedDevices?${query}&$select=${SELECT}`;
  const filter = async (expr: string, top = 50) => devices(await graph(list(`$filter=${encodeURIComponent(expr)}&$top=${top}`)));

  return {
    key: cfg.key,
    label: "Intune",
    source: cfg.expectTid,

    identity: signedInTenant,

    async test() {
      const json = await graph(`${GRAPH_BASE}/deviceManagement/managedDevices?$top=1&$select=id&$count=true`);
      const o = obj(json);
      if (!o || !Array.isArray(o.value)) throw new AssetHttpError("Microsoft Graph didn't answer with a device list.", 200, "not_json");
      return { total: Number(o["@odata.count"]) || (o.value as unknown[]).length };
    },

    async listAll(onPage) {
      const size = testPaging?.page ?? INTUNE_PAGE;
      const maxPages = testPaging?.maxPages ?? MAX_PAGES;
      let next = list(`$top=${size}`);
      let seen = 0;
      let complete = false;
      for (let page = 0; page < maxPages; page++) {
        const json = await patient(next);
        const o = obj(json);
        if (!o || !Array.isArray(o.value)) throw new AssetHttpError("Microsoft Graph didn't answer with a device list.", 200, "not_json");
        const rows = devices(json);
        seen += rows.length;
        if (rows.length) await onPage(rows);
        const link = str(o["@odata.nextLink"]);
        if (!link) {
          complete = true;
          break;
        }
        next = link;
      }
      // Graph reports no total unless asked; a pass is complete when it reached the last page.
      return { total: seen, seen, complete };
    },

    async search(q, limit) {
      const s = q.trim();
      if (!s) return [];
      return filter(`startswith(deviceName,${lit(s)})`, Math.min(50, Math.max(1, limit)));
    },

    async byTag() {
      return null; // Intune has no asset tags.
    },

    async bySerial(serial) {
      const s = cleanSerial(serial);
      return s ? filter(`serialNumber eq ${lit(s)}`) : [];
    },

    async forEmail(email) {
      const want = email.trim().toLowerCase();
      if (!want) return null;
      const [byUpn, byMail] = await Promise.all([filter(`userPrincipalName eq ${lit(want)}`), filter(`emailAddress eq ${lit(want)}`)]);
      const all = [...new Map([...byUpn, ...byMail].map((d) => [d.external_id, d])).values()];
      return all.length ? all : null;
    },

    async get(externalId) {
      try {
        return normaliseDevice(await graph(`${GRAPH_BASE}/deviceManagement/managedDevices/${encodeURIComponent(externalId)}?$select=${SELECT}`));
      } catch (e) {
        if (e instanceof AssetHttpError && e.status === 404) return null;
        throw e;
      }
    },
  };
}
