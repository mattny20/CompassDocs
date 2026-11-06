// Helpdesk 1.19.3: assets on tickets (schema in lib/helpdesk/assets-schema,
// shapes in assets-shared, sources in lib/helpdesk/assets/*).
//
//   settings    Desk settings → Assets (settings.manage): the Snipe-IT
//               address (https only) and API key (sealed with secretbox in
//               the settings value; never returned, never logged), what
//               solving offers (nothing / a maintenance record), and whether
//               agents may search every asset (default on). Changing the
//               address asks for the key again, so a stored key is never
//               sent to a new host; Test connection follows the same rule.
//               A new address is a new source: the old cache is retired
//               (retireSource), so a link never moves to another device.
//   the cache   hd_assets, one row per source asset. A full sync pages
//               through the source by id (the sweep every 30 minutes, Sync
//               now) and upserts every row. Only a complete pass
//               reconciles: a row missed by two complete passes is
//               deleted, or marked gone when a ticket links it and the
//               source no longer has it by id. Times in the sync record are
//               the database's; a heartbeat after each page keeps a long
//               run from being taken for dead.
//               Live lookups fill it between syncs: a tag or serial search
//               that finds nothing, a requester with no cached assets, and
//               opening an asset's page.
//   people      an asset is someone's when its assigned address equals
//               their address (lower-cased): an account's only when it is
//               confirmed (not self-set, held by no other account;
//               confirmedEmailOf), else the sender's for a ticket with no
//               account.
//   who sees    agents: the assets of people whose tickets they can work,
//               and assets linked to those tickets; every asset by search
//               when "Agents can search all assets" is on. Requesters: only
//               their own, in Get help's Device picker. Nobody else.
//   links       hd_ticket_assets: an agent who works the ticket links and
//               unlinks (internal timeline line; the routes audit). Up to
//               ten linked by hand a ticket. Merge moves every link to the
//               kept ticket (so they share its retention, legal hold and
//               anonymising), which may leave it with more than ten;
//               anonymising removes them; deleting a ticket cascades.
//               Without a connected source nothing links (NOT_CONNECTED):
//               the cache is history only. Unlinking touches no source, so
//               it works connected or not (a wrong device stays removable).
//   solving     with "Offer to log a maintenance record" on and a linked
//               asset from a source that takes maintenance, the desk's
//               solve flow offers the record (solveOffer); the desk posts
//               it after the solve committed (logMaintenance), within 15
//               minutes of that agent's solve, claimed once per (ticket,
//               asset, solve) in hd_asset_maintenance_log. The title is
//               "CompassDocs #N: <type>", never the subject; the asset
//               page shows a record only when every ticket it names is one
//               the viewer may open. A failure leaves an internal note and
//               never reopens the ticket.
//   export      a person's export lists the assets linked to their own
//               requests, tag and name only (assetsForExport).
//
// Server-only.

import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getSetting, setSetting } from "../db";
import { openSecret, sealSecret } from "../secretbox";
import { hq, hqOne, withTx, type HdQueryable } from "./db-core";
import { agentTeamIds, canSeeTicket, isAgent } from "./access";
import type { HdTicket } from "./types";
import {
  ASSET_LIMITS,
  HD_ASSET_ON_SOLVE,
  SNIPEIT_MAINTENANCE_TYPES,
  checkApiKey,
  checkSnipeItUrl,
  maintenanceNotePrefill,
  maintenanceTitle,
  maintenanceTypeLabel,
  noteWithTicket,
  providerLabel,
  ticketRefs,
  type HdMaintenanceRecord,
  type HdAsset,
  type HdAssetOnSolve,
  type HdAssetOption,
  type HdAssetOptions,
  type HdAssetPage,
  type HdAssetSettingsView,
  type HdAssetSyncState,
  type HdLinkedAsset,
  type HdSolveOffer,
  type HdTicketAssetsView,
} from "./assets-shared";
import { AssetHttpError } from "./assets/http";
import { PROVIDER_FACTORIES, type AssetProvider, type ProviderAsset } from "./assets/providers";

export * from "./assets-shared";

type U = Parameters<typeof isAgent>[0];

export class AssetError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface AssetActor {
  id: number | null;
  name: string;
}

/**
 * The sync's advisory lock (claiming a run; the run itself holds no
 * connection while it calls the source). Listed with the other helpdesk
 * keys next to RECURRING_SWEEP_LOCK (lib/helpdesk/recurring).
 */
export const ASSETS_SYNC_LOCK = 7_281_991;

/** How often the sweep syncs a source in full. */
export const ASSET_SYNC_EVERY_MS = 30 * 60_000;
/** A run whose heartbeat (refreshed after every page) is older than this is taken to have died. */
const SYNC_STALE_MS = 5 * 60_000;
/** Live lookups for one ticket view are short: the cached list shows if the source is slow. */
const LIVE_TIMEOUT_MS = 6_000;

// --- Settings -----------------------------------------------------------------------------

export const ASSETS_SETTINGS_KEY = "helpdesk_assets";
const SYNC_KEY_PREFIX = "helpdesk_assets_sync:";

export interface AssetSettings {
  snipeit: { url: string; token: string; on_solve: HdAssetOnSolve };
  agents_search_all: boolean;
  /** The address the cached Snipe-IT rows came from ("" before the first save). */
  cache_source?: string;
}

const DEFAULTS: AssetSettings = { snipeit: { url: "", token: "", on_solve: "nothing" }, agents_search_all: true };

let testSettings: AssetSettings | null = null;
let testSnipeKey: string | null = null;
let testTimeout: number | null = null;

/** Tests: read these settings instead of the stored ones (null restores). Never written. */
export function setAssetSettingsForTests(s: AssetSettings | null): void {
  testSettings = s;
}

/** Tests: cache Snipe-IT's assets under this provider key (their own rows), not "snipeit". */
export function setSnipeItCacheKeyForTests(key: string | null): void {
  testSnipeKey = key;
}

/** Tests: the per-request timeout of every source call (ms). */
export function setAssetTimeoutForTests(ms: number | null): void {
  testTimeout = ms;
}

function snipeKey(): string {
  return testSnipeKey ?? "snipeit";
}

function parseStored(raw: string | undefined): AssetSettings {
  let v: Record<string, unknown> = {};
  try {
    v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    v = {};
  }
  const sn = (v.snipeit && typeof v.snipeit === "object" ? v.snipeit : {}) as Record<string, unknown>;
  const url = checkSnipeItUrl(sn.url);
  return {
    snipeit: {
      url: url.ok ? url.value : "",
      token: typeof sn.key === "string" ? openSecret(sn.key) : "",
      on_solve: HD_ASSET_ON_SOLVE.includes(sn.on_solve as HdAssetOnSolve) ? (sn.on_solve as HdAssetOnSolve) : "nothing",
    },
    agents_search_all: v.agents_search_all !== false,
    cache_source: typeof v.cache_source === "string" ? v.cache_source : "",
  };
}

/** The settings with the key opened (server use only; never send this to a browser). */
export async function getAssetSettings(): Promise<AssetSettings> {
  if (testSettings) return testSettings;
  return parseStored(await getSetting(ASSETS_SETTINGS_KEY));
}

async function storeSettings(s: AssetSettings): Promise<void> {
  await setSetting(
    ASSETS_SETTINGS_KEY,
    JSON.stringify({
      snipeit: { url: s.snipeit.url, key: s.snipeit.token ? sealSecret(s.snipeit.token) : "", on_solve: s.snipeit.on_solve },
      agents_search_all: s.agents_search_all,
      cache_source: s.cache_source ?? "",
    })
  );
}

export interface AssetSettingsPatch {
  url?: unknown;
  api_key?: unknown;
  on_solve?: unknown;
  agents_search_all?: unknown;
  /** Forget the address and key. */
  disconnect?: unknown;
}

/**
 * Validate and save. Returns what changed (names only, for the audit; the
 * key is "api_key" and never its value). A new address needs the key again.
 */
export async function saveAssetSettings(patch: AssetSettingsPatch): Promise<{ changed: string[]; retired: number }> {
  const cur = await getAssetSettings();
  const next: AssetSettings = { snipeit: { ...cur.snipeit }, agents_search_all: cur.agents_search_all, cache_source: cur.cache_source ?? "" };
  const changed: string[] = [];
  if (patch.disconnect === true) {
    if (cur.snipeit.url || cur.snipeit.token) changed.push("disconnected");
    next.snipeit = { url: "", token: "", on_solve: cur.snipeit.on_solve };
  } else {
    if (patch.url !== undefined) {
      const u = checkSnipeItUrl(patch.url);
      if (!u.ok) throw new AssetError(u.error);
      if (u.value !== cur.snipeit.url) {
        changed.push("url");
        next.snipeit.url = u.value;
        // A stored key is never sent to a different address.
        if (cur.snipeit.token && (patch.api_key === undefined || patch.api_key === "")) {
          if (!u.value) next.snipeit.token = "";
          else throw new AssetError("Paste the API key again: a saved key is only ever sent to the address it was saved for.");
        }
      }
    }
    if (patch.api_key !== undefined && patch.api_key !== "") {
      const k = checkApiKey(patch.api_key);
      if (!k.ok) throw new AssetError(k.error);
      if (k.value !== cur.snipeit.token) changed.push("api_key");
      next.snipeit.token = k.value;
    }
    if (next.snipeit.token && !next.snipeit.url) throw new AssetError("Enter the Snipe-IT address the key is for.");
  }
  if (patch.on_solve !== undefined) {
    if (!HD_ASSET_ON_SOLVE.includes(patch.on_solve as HdAssetOnSolve)) throw new AssetError("Choose what happens when a ticket is solved.");
    if (patch.on_solve !== cur.snipeit.on_solve) changed.push("on_solve");
    next.snipeit.on_solve = patch.on_solve as HdAssetOnSolve;
  }
  if (patch.agents_search_all !== undefined) {
    if (typeof patch.agents_search_all !== "boolean") throw new AssetError("Agents can search all assets is on or off.");
    if (patch.agents_search_all !== cur.agents_search_all) changed.push("agents_search_all");
    next.agents_search_all = patch.agents_search_all;
  }
  // A different address is a different Snipe-IT: its asset 5 is not this
  // one's asset 5. The old rows are retired (linked ones kept as gone, for
  // the tickets' history; the rest deleted) before anything syncs again.
  let retired = 0;
  const oldSource = cur.cache_source || cur.snipeit.url;
  if (next.snipeit.url && oldSource && next.snipeit.url !== oldSource) {
    retired = await retireSource(snipeKey());
    changed.push("source_changed");
  }
  if (next.snipeit.url) next.cache_source = next.snipeit.url;
  if (changed.length) {
    if (testSettings) testSettings = next;
    else await storeSettings(next);
    supplierCache.clear();
    liveLookups.clear();
  }
  return { changed, retired };
}

/**
 * Retire a source's cached rows: linked rows move to "<key>:retired:<ms>"
 * and are marked gone (no sync can match their ids again); unlinked rows
 * and the sync record go. Returns how many linked rows were kept.
 */
export async function retireSource(key: string): Promise<number> {
  return withTx(async (client) => {
    const kept = await client.query(
      `UPDATE hd_assets a SET provider = $2, gone_at = coalesce(a.gone_at, now())
        WHERE a.provider = $1 AND EXISTS (SELECT 1 FROM hd_ticket_assets l WHERE l.asset_id = a.id)`,
      [key, `${key}:retired:${Date.now()}`]
    );
    await client.query("DELETE FROM hd_assets a WHERE a.provider = $1", [key]);
    await client.query("DELETE FROM settings WHERE key = $1", [SYNC_KEY_PREFIX + key]);
    return kept.rowCount ?? 0;
  });
}

// --- Providers ----------------------------------------------------------------------------

async function build(key: string, s: AssetSettings): Promise<AssetProvider | null> {
  if (key === snipeKey() || key === "snipeit") {
    if (!s.snipeit.url || !s.snipeit.token) return null;
    return PROVIDER_FACTORIES.snipeit({ url: s.snipeit.url, token: s.snipeit.token, key: snipeKey(), timeoutMs: testTimeout ?? undefined });
  }
  return null;
}

/** The sources that are set up, in order. */
export async function activeProviders(s?: AssetSettings): Promise<AssetProvider[]> {
  const settings = s ?? (await getAssetSettings());
  const out: AssetProvider[] = [];
  const sn = await build(snipeKey(), settings);
  if (sn) out.push(sn);
  return out;
}

/**
 * Without a connected source the cache is history only: links on tickets,
 * the pages of linked assets and search over them stay readable, while
 * linking, the picker, Get help's Device picker and maintenance on solve
 * refuse or come back empty (as the ticket card does). Unlinking still works.
 */
export const NOT_CONNECTED = "Snipe-IT isn't connected. An admin can connect it in Desk settings, Assets.";

/** Is any asset source set up (an address and a key)? */
export async function assetsConnected(s?: AssetSettings): Promise<boolean> {
  return (await activeProviders(s)).length > 0;
}

/** The source that caches under `key`, when it is set up. */
export async function providerFor(key: string, s?: AssetSettings): Promise<AssetProvider | null> {
  return build(key, s ?? (await getAssetSettings()));
}

/** A source call with a shorter deadline (a ticket view should not wait 10 seconds). */
async function quick<T>(p: Promise<T>, ms = LIVE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new AssetHttpError("The asset source didn't answer in time.", 0, "timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const errText = (e: unknown) => (e instanceof AssetHttpError || e instanceof AssetError ? e.message : "The asset source couldn't be reached.");

/** The pool as a queryable, for a line written outside a transaction. */
const POOL: HdQueryable = { query: ((sql: string, p: unknown[]) => hq(sql, p).then((rows) => ({ rows }))) as unknown as HdQueryable["query"] };

// --- The cache ----------------------------------------------------------------------------

const COLS = `a.id, a.provider, a.tag, a.serial, a.name, a.model, a.category, a.status_label, a.status_kind,
  a.assigned_name, a.assigned_email, a.location, to_char(a.purchase_date, 'YYYY-MM-DD') AS purchase_date,
  to_char(a.warranty_end, 'YYYY-MM-DD') AS warranty_end, a.url, a.synced_at, (a.gone_at IS NOT NULL) AS gone`;

type Row = Omit<HdAsset, "provider_label">;
const view = (r: Row): HdAsset => ({ ...r, provider_label: providerLabel(r.provider) });

/** Upsert source assets; returns their cache ids by external id. */
export async function upsertAssets(providerKey: string, list: ProviderAsset[], syncedAt?: string | Date, client?: HdQueryable): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!list.length) return out;
  const clean = (s: string, n = 300) => (s ?? "").slice(0, n);
  // One row per source id (an upsert may not touch a row twice).
  const unique = [...new Map(list.map((a) => [a.external_id, a])).values()];
  const rows = unique.map((a) => ({
    external_id: clean(a.external_id, 100),
    tag: clean(a.tag, 120),
    serial: clean(a.serial, 120),
    name: clean(a.name),
    model: clean(a.model),
    category: clean(a.category, 120),
    status_label: clean(a.status_label, 120),
    status_kind: clean(a.status_kind, 20),
    assigned_email: clean(a.assigned_email, 320).toLowerCase(),
    assigned_name: clean(a.assigned_name, 200),
    location: clean(a.location, 200),
    purchase_date: a.purchase_date,
    warranty_end: a.warranty_end,
    url: clean(a.url, 500),
    raw: a.raw ?? {},
  }));
  const res = await hq<{ id: number; external_id: string }>(
    `INSERT INTO hd_assets (provider, external_id, tag, serial, name, model, category, status_label, status_kind,
            assigned_email, assigned_name, location, purchase_date, warranty_end, url, raw, synced_at, missing_since, gone_at)
     SELECT $1, r.external_id, r.tag, r.serial, r.name, r.model, r.category, r.status_label, r.status_kind,
            r.assigned_email, r.assigned_name, r.location, r.purchase_date, r.warranty_end, r.url, coalesce(r.raw, '{}'::jsonb),
            coalesce($3::timestamptz, now()), NULL, NULL
       FROM jsonb_to_recordset($2::jsonb) AS r(external_id text, tag text, serial text, name text, model text, category text,
            status_label text, status_kind text, assigned_email text, assigned_name text, location text,
            purchase_date date, warranty_end date, url text, raw jsonb)
     ON CONFLICT (provider, external_id) DO UPDATE SET
       tag = EXCLUDED.tag, serial = EXCLUDED.serial, name = EXCLUDED.name, model = EXCLUDED.model, category = EXCLUDED.category,
       status_label = EXCLUDED.status_label, status_kind = EXCLUDED.status_kind, assigned_email = EXCLUDED.assigned_email,
       assigned_name = EXCLUDED.assigned_name, location = EXCLUDED.location, purchase_date = EXCLUDED.purchase_date,
       warranty_end = EXCLUDED.warranty_end, url = EXCLUDED.url, raw = EXCLUDED.raw,
       synced_at = GREATEST(hd_assets.synced_at, EXCLUDED.synced_at), missing_since = NULL, gone_at = NULL
     RETURNING id, external_id`,
    [providerKey, JSON.stringify(rows), syncedAt ?? null],
    client
  );
  for (const r of res) out.set(r.external_id, r.id);
  return out;
}

/** One cached asset. */
export async function getAsset(id: number, client?: HdQueryable): Promise<HdAsset | undefined> {
  const r = await hqOne<Row>(`SELECT ${COLS} FROM hd_assets a WHERE a.id = $1`, [id], client);
  return r ? view(r) : undefined;
}

// --- Sync -----------------------------------------------------------------------------------
//
// One record per source (settings key helpdesk_assets_sync:<provider>):
// run_id, started_at, heartbeat_at, at (finished), ok, error, total. Every
// time in it is the database's clock (ISO_NOW), never the app's, so two
// hosts that disagree by a second can't make a finished run look live. A
// run refreshes heartbeat_at after each page; one whose heartbeat is older
// than SYNC_STALE_MS is taken to have died. A run writes its heartbeat and
// its result only while the record still carries its run_id, so a run
// taken over never overwrites the one that took over (and stops).

/** The database's now() as the ISO string the record keeps. */
const ISO_NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

interface SyncRecord {
  run_id: string;
  started_at: string | null;
  heartbeat_at: string | null;
  at: string | null;
  ok: boolean | null;
  error: string;
  total: number;
}

function parseSync(raw: string | undefined): SyncRecord {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<SyncRecord>) : {};
    return {
      run_id: typeof v.run_id === "string" ? v.run_id : "",
      started_at: v.started_at ?? null,
      heartbeat_at: v.heartbeat_at ?? null,
      at: v.at ?? null,
      ok: typeof v.ok === "boolean" ? v.ok : null,
      error: v.error ?? "",
      total: Number(v.total) || 0,
    };
  } catch {
    return { run_id: "", started_at: null, heartbeat_at: null, at: null, ok: null, error: "", total: 0 };
  }
}

/** The record and the database's clock, read together. */
async function readSync(key: string, client?: HdQueryable): Promise<{ r: SyncRecord; now: number }> {
  const row = (
    await (client ?? POOL).query<{ value: string | null; now: string }>(
      `SELECT (SELECT value FROM settings WHERE key = $1) AS value, ${ISO_NOW} AS now`,
      [SYNC_KEY_PREFIX + key]
    )
  ).rows[0];
  return { r: parseSync(row?.value ?? undefined), now: Date.parse(row.now) };
}

/** A run in progress: started, not finished since, and its heartbeat fresh. */
function isLive(r: SyncRecord, now: number): boolean {
  if (!r.started_at || (r.at && r.at >= r.started_at)) return false;
  return now - Date.parse(r.heartbeat_at ?? r.started_at) < SYNC_STALE_MS;
}

/** Merge fields into this run's record; false when another run has taken it over. */
async function updateRun(key: string, runId: string, fields: Record<string, unknown>, stamp: ("heartbeat_at" | "at")[] = []): Promise<boolean> {
  const stamps = stamp.map((k) => `'${k}', ${ISO_NOW}`).join(", ");
  const res = await hq<{ ok: number }>(
    `UPDATE settings SET value = (value::jsonb || $3::jsonb ${stamps ? `|| jsonb_build_object(${stamps})` : ""})::text
      WHERE key = $1 AND value::jsonb->>'run_id' = $2 RETURNING 1 AS ok`,
    [SYNC_KEY_PREFIX + key, runId, JSON.stringify(fields)]
  );
  return res.length > 0;
}

export async function syncState(key: string): Promise<HdAssetSyncState> {
  const [{ r, now }, n] = await Promise.all([
    readSync(key),
    hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_assets WHERE provider = $1 AND gone_at IS NULL", [key]),
  ]);
  return { at: r.at, ok: r.ok, error: r.error, count: n?.n ?? 0, running: isLive(r, now) };
}

export interface SyncResult {
  ran: boolean;
  /** Why it did not run: "running" (another run holds it) or "not_due". */
  skipped?: "running" | "not_due";
  ok?: boolean;
  error?: string;
  /** Assets the source listed. */
  seen?: number;
  /** Rows deleted (missed by two complete syncs, unlinked). */
  removed?: number;
  /** Rows marked gone (missed twice, linked, and not found by id). */
  gone?: number;
  /** The pass read every asset (only then is anything reconciled). */
  complete?: boolean;
}

class TakenOver extends Error {}

/** Linked rows confirmed one by one at most per sync before being marked gone. */
const CONFIRM_MAX = 50;

/**
 * Sync one source in full. The claim (under ASSETS_SYNC_LOCK) is a short
 * transaction; the run calls the source with no connection held. Without
 * `force` it runs only when the last run finished 30 minutes ago.
 *
 * Only a complete pass (every page read, as many assets as the source
 * reported) reconciles: a row it didn't see is marked missing; a row
 * missed by two complete passes in a row is deleted, or, when a ticket
 * links it and the source no longer has it by id, marked gone. A pass cut
 * short (the page cap, an empty page before the reported total, an error)
 * removes nothing.
 */
export async function syncProvider(key: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
  const provider = await providerFor(key);
  if (!provider) return { ran: false, ok: false, error: "Snipe-IT isn't set up." };
  const runId = randomUUID();
  const claim = await withTx(async (client) => {
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [ASSETS_SYNC_LOCK]);
    if (!lock.rows[0]?.ok) return { skip: "running" as const };
    const { r, now } = await readSync(key, client);
    if (isLive(r, now)) return { skip: "running" as const };
    if (!opts.force && r.at && now - Date.parse(r.at) < ASSET_SYNC_EVERY_MS) return { skip: "not_due" as const };
    const started = new Date(now).toISOString();
    await client.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
      SYNC_KEY_PREFIX + key,
      JSON.stringify({ ...r, run_id: runId, started_at: started, heartbeat_at: started }),
    ]);
    return { started, prior: r };
  });
  if ("skip" in claim) return { ran: false, skipped: claim.skip };
  const started = claim.started;
  try {
    const { seen, total, complete } = await provider.listAll(async (page) => {
      await upsertAssets(key, page, started);
      if (!(await updateRun(key, runId, {}, ["heartbeat_at"]))) throw new TakenOver();
    });
    let removed = 0;
    let gone = 0;
    if (complete) ({ removed, gone } = await reconcile(provider, key, started));
    const error = complete ? "" : `The sync stopped after ${seen.toLocaleString("en")} of ${total.toLocaleString("en")} assets, so nothing was removed. It tries again in 30 minutes.`;
    await updateRun(key, runId, { ok: complete, error, total: seen }, ["at"]);
    return { ran: true, ok: complete, error: error || undefined, seen, removed, gone, complete };
  } catch (e) {
    if (e instanceof TakenOver) return { ran: true, ok: false, error: "Another sync took over." };
    const error = errText(e);
    await updateRun(key, runId, { ok: false, error, total: claim.prior.total }, ["at"]);
    return { ran: true, ok: false, error };
  }
}

/** After a complete pass: what it didn't see (see syncProvider). */
async function reconcile(provider: AssetProvider, key: string, started: string): Promise<{ removed: number; gone: number }> {
  // Missed twice and linked: ask the source by id before calling it gone.
  const twiceLinked = await hq<{ id: number; external_id: string }>(
    `SELECT a.id, a.external_id FROM hd_assets a
      WHERE a.provider = $1 AND a.synced_at < $2 AND a.missing_since IS NOT NULL AND a.gone_at IS NULL
        AND EXISTS (SELECT 1 FROM hd_ticket_assets l WHERE l.asset_id = a.id)
      ORDER BY a.id LIMIT ${CONFIRM_MAX}`,
    [key, started]
  );
  let gone = 0;
  for (const a of twiceLinked) {
    let still: ProviderAsset | null | undefined;
    try {
      still = await provider.get(a.external_id);
    } catch {
      still = undefined; // unknown: leave it as it is
    }
    if (still) await upsertAssets(key, [still], started);
    else if (still === null) {
      await hq("UPDATE hd_assets SET gone_at = now() WHERE id = $1 AND gone_at IS NULL", [a.id]);
      gone++;
    }
  }
  return withTx(async (client) => {
    const del = await client.query(
      `DELETE FROM hd_assets a WHERE a.provider = $1 AND a.synced_at < $2 AND a.missing_since IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM hd_ticket_assets l WHERE l.asset_id = a.id)`,
      [key, started]
    );
    await client.query("UPDATE hd_assets SET missing_since = now() WHERE provider = $1 AND synced_at < $2 AND missing_since IS NULL", [key, started]);
    return { removed: del.rowCount ?? 0, gone };
  });
}

/** The minute tick (lib/periodic HELPDESK_SWEEPS): each set-up source, when 30 minutes are up (by the database's clock). */
export async function assetsSweep(): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  for (const p of await activeProviders()) out.push(await syncProvider(p.key));
  return out;
}

/** Test connection: the typed address and key, or the saved ones. A saved key only goes to its own address. */
export async function testConnection(input: { url?: unknown; api_key?: unknown } = {}): Promise<{ ok: true; total: number } | { ok: false; error: string }> {
  const cur = await getAssetSettings();
  const u = checkSnipeItUrl(input.url === undefined ? cur.snipeit.url : input.url);
  if (!u.ok) return { ok: false, error: u.error };
  if (!u.value) return { ok: false, error: "Enter the Snipe-IT address first." };
  let token = cur.snipeit.token;
  if (input.api_key !== undefined && input.api_key !== "") {
    const k = checkApiKey(input.api_key);
    if (!k.ok) return { ok: false, error: k.error };
    token = k.value;
  } else if (u.value !== cur.snipeit.url) {
    return { ok: false, error: "Paste the API key to test a new address: a saved key is only ever sent to the address it was saved for." };
  }
  if (!token) return { ok: false, error: "Paste the API key first." };
  try {
    const p = await PROVIDER_FACTORIES.snipeit({ url: u.value, token, key: snipeKey(), timeoutMs: testTimeout ?? undefined });
    const r = await p.test();
    return { ok: true, total: r.total };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** Desk settings → Assets, as the browser sees it (the key is never in it). */
export async function assetSettingsView(): Promise<HdAssetSettingsView> {
  const s = await getAssetSettings();
  return {
    snipeit: { url: s.snipeit.url, key_set: !!s.snipeit.token, on_solve: s.snipeit.on_solve, sync: await syncState(snipeKey()) },
    agents_search_all: s.agents_search_all,
  };
}

// --- Who sees what --------------------------------------------------------------------------

/** The scope predicate on hd_tickets `t` for an agent (the desk's own: their teams' tickets and theirs). */
function scopeSql(teams: number[] | "all", userId: number, params: unknown[]): string {
  if (teams === "all") return "TRUE";
  params.push(teams, userId);
  return `(t.team_id = ANY($${params.length - 1}::int[]) OR t.assignee_id = $${params.length})`;
}

/** Assets `a` an agent sees without searching all: their people's, and those linked to their tickets. */
function visibleSql(teams: number[] | "all", userId: number, params: unknown[]): string {
  if (teams === "all") return "TRUE";
  const scope = scopeSql(teams, userId, params);
  // A ticket's person is matched on their account's confirmed address
  // (CONFIRMED_SQL), or on the sender's address when it has no account.
  return `((a.assigned_email <> '' AND EXISTS (SELECT 1 FROM hd_tickets t LEFT JOIN users ru ON ru.id = t.requester_id
       WHERE ${scope} AND ((t.requester_id IS NULL AND lower(t.requester_email) = a.assigned_email)
         OR (lower(ru.email) = a.assigned_email AND ${CONFIRMED_SQL("ru")}))))
    OR EXISTS (SELECT 1 FROM hd_ticket_assets l JOIN hd_tickets t ON t.id = l.ticket_id WHERE l.asset_id = a.id AND ${scope}))`;
}

/**
 * An account's address may stand for its owner only when it is confirmed:
 * not typed by the person themself (email_self_set = 0) and held by no
 * other account (the autoLinkUsersToDirectory rule). Anyone can type a
 * colleague's address into their profile; that must never show them the
 * colleague's devices.
 */
const CONFIRMED_SQL = (u: string) =>
  `(${u}.email <> '' AND ${u}.email_self_set = 0 AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id <> ${u}.id AND lower(o.email) = lower(${u}.email)))`;

/** The account's confirmed address, lower-cased, or "" (see CONFIRMED_SQL). */
export async function confirmedEmailOf(userId: number | null | undefined): Promise<string> {
  if (!userId) return "";
  const r = await hqOne<{ email: string }>(`SELECT lower(u.email) AS email FROM users u WHERE u.id = $1 AND ${CONFIRMED_SQL("u")}`, [userId]);
  return r?.email ?? "";
}

/** The address a ticket's person's assets are matched on: the account's confirmed one, or the sender's when there is no account. */
export async function requesterMatchEmail(ticket: Pick<HdTicket, "requester_id" | "requester_email">): Promise<string> {
  if (ticket.requester_id) return confirmedEmailOf(ticket.requester_id);
  return (ticket.requester_email ?? "").trim().toLowerCase();
}

/** May this agent open the asset (its page, or link it)? */
export async function agentMaySeeAsset(user: U & { id: number }, assetId: number, s?: AssetSettings): Promise<boolean> {
  if (!(await isAgent(user))) return false;
  const settings = s ?? (await getAssetSettings());
  if (settings.agents_search_all) return !!(await hqOne("SELECT 1 FROM hd_assets WHERE id = $1", [assetId]));
  const teams = await agentTeamIds(user);
  const params: unknown[] = [assetId];
  const where = visibleSql(teams, user.id, params);
  return !!(await hqOne(`SELECT 1 FROM hd_assets a WHERE a.id = $1 AND ${where}`, params));
}

// --- A ticket's assets ---------------------------------------------------------------------

/** The assets linked to a ticket, oldest link first, each with how many earlier tickets it is on. */
export async function linkedAssets(ticketId: number, client?: HdQueryable): Promise<HdLinkedAsset[]> {
  const rows = await hq<Row & { linked_by_name: string; linked_at: string; earlier_tickets: number }>(
    `SELECT ${COLS}, l.linked_by_name, l.linked_at,
            (SELECT count(*)::int FROM hd_ticket_assets o JOIN hd_tickets ot ON ot.id = o.ticket_id
              WHERE o.asset_id = a.id AND o.ticket_id <> $1 AND ot.created_at < me.created_at) AS earlier_tickets
       FROM hd_ticket_assets l
       JOIN hd_assets a ON a.id = l.asset_id
       JOIN hd_tickets me ON me.id = l.ticket_id
      WHERE l.ticket_id = $1
      ORDER BY l.linked_at, a.id`,
    [ticketId],
    client
  );
  return rows.map((r) => ({ ...view(r), linked_by_name: r.linked_by_name, linked_at: r.linked_at, earlier_tickets: r.earlier_tickets }));
}

/** May the ticket's asset links change? Not on a merged ticket, nor a closed one. */
export function assetsEditable(t: Pick<HdTicket, "status" | "merged_into">): boolean {
  return !t.merged_into && t.status !== "closed";
}

/** GET /api/helpdesk/tickets/[number]/assets (the agent works the ticket). */
export async function ticketAssetsView(ticket: HdTicket): Promise<HdTicketAssetsView> {
  const [s, assets] = await Promise.all([getAssetSettings(), linkedAssets(ticket.id)]);
  const providers = await activeProviders(s);
  const email = await requesterMatchEmail(ticket);
  return {
    configured: providers.length > 0 || assets.length > 0,
    assets,
    can_edit: providers.length > 0 && assetsEditable(ticket),
    can_unlink: assetsEditable(ticket),
    requester: email ? { name: ticket.requester_name || email, email } : null,
    search_all: s.agents_search_all,
  };
}

const option = (a: Row, linked: Set<number>): HdAssetOption => ({
  id: a.id,
  name: a.name,
  tag: a.tag,
  serial: a.serial,
  category: a.category,
  model: a.model,
  provider_label: providerLabel(a.provider),
  assigned_name: a.assigned_name,
  linked: linked.has(a.id),
});

/** When each address was last looked up live (so a picker opened twice doesn't ask twice). */
const liveLookups = new Map<string, number>();
const LIVE_AGAIN_MS = 10 * 60_000;

/** Someone's assets, from the cache; looked up live when the cache has none (at most every ten minutes). */
async function assetsOfEmail(email: string, providers: AssetProvider[]): Promise<{ rows: Row[]; notice: string | null }> {
  const read = () => hq<Row>(`SELECT ${COLS} FROM hd_assets a WHERE a.assigned_email = $1 AND a.gone_at IS NULL ORDER BY a.name, a.id LIMIT 50`, [email]);
  let rows = await read();
  let notice: string | null = null;
  const last = liveLookups.get(email) ?? 0;
  if (!rows.length && providers.length && Date.now() - last > LIVE_AGAIN_MS) {
    liveLookups.set(email, Date.now());
    if (liveLookups.size > 5000) liveLookups.clear();
    for (const p of providers) {
      try {
        const found = await quick(p.forEmail(email));
        if (found?.length) await upsertAssets(p.key, found);
      } catch (e) {
        notice = `${p.label}: ${errText(e)}`;
      }
    }
    rows = await read();
  }
  return { rows, notice };
}

/** Looks like a tag or serial (one token, 3+ characters): worth a live lookup when the cache has no exact match. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{2,80}$/;

/**
 * Search the cache by tag, serial, name, model or person. Every asset with
 * search-all on; otherwise only those the agent sees. An exact tag or
 * serial the cache doesn't have is looked up live first.
 */
export async function searchAssets(user: U & { id: number }, q: string, opts: { limit?: number; settings?: AssetSettings } = {}): Promise<{ rows: Row[]; notice: string | null }> {
  const s = opts.settings ?? (await getAssetSettings());
  const term = q.trim().slice(0, ASSET_LIMITS.q);
  if (!term) return { rows: [], notice: null };
  const limit = Math.min(50, Math.max(1, opts.limit ?? ASSET_LIMITS.results));
  const teams = s.agents_search_all ? ("all" as const) : await agentTeamIds(user);
  // Disconnected: only assets a ticket links (history), never the rest of a stale cache.
  const connected = await assetsConnected(s);
  const linkedOnly = connected ? "" : "AND EXISTS (SELECT 1 FROM hd_ticket_assets l WHERE l.asset_id = a.id)";
  const run = () => {
    const params: unknown[] = [term.toLowerCase(), `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit];
    const scope = visibleSql(teams, user.id, params);
    return hq<Row>(
      `SELECT ${COLS} FROM hd_assets a
        WHERE a.gone_at IS NULL AND ${scope} ${linkedOnly}
          AND (lower(a.tag) = $1 OR lower(a.serial) = $1 OR a.tag ILIKE $2 OR a.serial ILIKE $2 OR a.name ILIKE $2
               OR a.model ILIKE $2 OR a.assigned_name ILIKE $2 OR a.assigned_email = $1)
        ORDER BY (lower(a.tag) = $1 OR lower(a.serial) = $1) DESC, a.name, a.id
        LIMIT $3`,
      params
    );
  };
  let rows = await run();
  if (!connected) return { rows, notice: "Snipe-IT isn't connected, so only assets linked to tickets are listed." };
  let notice: string | null = null;
  const exact = rows.some((r) => r.tag.toLowerCase() === term.toLowerCase() || r.serial.toLowerCase() === term.toLowerCase());
  if (!exact && TOKEN.test(term)) {
    const providers = await activeProviders(s);
    for (const p of providers) {
      try {
        const [byTag, bySerial] = await quick(Promise.all([p.byTag(term), p.bySerial(term)]));
        const found = [...(byTag ? [byTag] : []), ...bySerial];
        if (found.length) await upsertAssets(p.key, found);
      } catch (e) {
        notice = `${p.label}: ${errText(e)}`;
      }
    }
    if (providers.length) rows = await run();
  }
  return { rows, notice };
}

/** GET /api/helpdesk/tickets/[number]/assets/options: the requester's assets first, then the search's. */
export async function assetOptions(user: U & { id: number }, ticket: HdTicket, q: string): Promise<HdAssetOptions> {
  const s = await getAssetSettings();
  const providers = await activeProviders(s);
  // Nothing to offer for linking without a source (the card hides Link then).
  if (!providers.length) return { assigned: [], results: [], search_all: s.agents_search_all, connected: false, notice: NOT_CONNECTED };
  const linked = new Set((await hq<{ asset_id: number }>("SELECT asset_id FROM hd_ticket_assets WHERE ticket_id = $1", [ticket.id])).map((r) => r.asset_id));
  const email = await requesterMatchEmail(ticket);
  const mine = email ? await assetsOfEmail(email, providers) : { rows: [], notice: null };
  const found = q.trim() ? await searchAssets(user, q, { settings: s }) : { rows: [], notice: null };
  const theirs = new Set(mine.rows.map((r) => r.id));
  return {
    assigned: mine.rows.map((r) => option(r, linked)),
    results: found.rows.filter((r) => !theirs.has(r.id)).map((r) => option(r, linked)),
    search_all: s.agents_search_all,
    connected: true,
    notice: found.notice ?? mine.notice,
  };
}

async function timeline(client: HdQueryable, ticketId: number, actor: AssetActor | null, body: string): Promise<void> {
  await client.query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via) VALUES ($1, $2, $3, 'internal', $4, 'system')`,
    [ticketId, actor?.id ?? null, actor?.name ?? "", body.slice(0, 2000)]
  );
}

const assetLine = (a: Pick<HdAsset, "name" | "tag">) => (a.tag && a.name && a.tag !== a.name ? `${a.name} (${a.tag})` : a.tag || a.name);

/**
 * Link a cached asset to a ticket. The agent must see the asset (its
 * person's ticket, search-all, or the ticket's requester's own asset).
 */
export async function linkAsset(user: U & { id: number }, ticket: HdTicket, assetId: number, actor: AssetActor): Promise<HdAsset> {
  if (!assetsEditable(ticket)) throw new AssetError(ticket.merged_into ? "This ticket was merged. Link the asset on the ticket it joined." : "This ticket is closed.", 409);
  // The cache outlives a disconnect (for the tickets' history); it is never linked from then.
  if (!(await assetsConnected())) throw new AssetError(NOT_CONNECTED, 409);
  const asset = await getAsset(assetId);
  if (!asset) throw new AssetError("That asset isn't in the list any more. Search again.", 404);
  const requesterEmail = await requesterMatchEmail(ticket);
  const theirs = requesterEmail !== "" && asset.assigned_email === requesterEmail;
  if (!theirs && !(await agentMaySeeAsset(user, assetId))) throw new AssetError("That asset isn't in the list any more. Search again.", 404);
  return withTx(async (client) => {
    await client.query("SELECT id FROM hd_tickets WHERE id = $1 FOR UPDATE", [ticket.id]);
    const n = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM hd_ticket_assets WHERE ticket_id = $1", [ticket.id])).rows[0].n;
    const ins = await client.query(
      `INSERT INTO hd_ticket_assets (ticket_id, asset_id, linked_by, linked_by_name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [ticket.id, assetId, actor.id, actor.name.slice(0, 200)]
    );
    if (!ins.rowCount) throw new AssetError("That asset is already linked to this ticket.", 409);
    if (n >= ASSET_LIMITS.perTicket) throw new AssetError(`A ticket can have up to ${ASSET_LIMITS.perTicket} assets.`, 409);
    await timeline(client, ticket.id, actor, `Linked asset ${assetLine(asset)} from ${asset.provider_label}.`);
    await client.query("UPDATE hd_tickets SET updated_at = now() WHERE id = $1", [ticket.id]);
    return asset;
  });
}

/** Unlink; null when it was not linked. Touches no source, so it works while disconnected too (a wrong or personal device link stays removable). */
export async function unlinkAsset(ticket: HdTicket, assetId: number, actor: AssetActor): Promise<HdAsset | null> {
  if (!assetsEditable(ticket)) throw new AssetError(ticket.merged_into ? "This ticket was merged." : "This ticket is closed.", 409);
  return withTx(async (client) => {
    const del = await client.query("DELETE FROM hd_ticket_assets WHERE ticket_id = $1 AND asset_id = $2", [ticket.id, assetId]);
    if (!del.rowCount) return null;
    const asset = await getAsset(assetId, client);
    if (asset) await timeline(client, ticket.id, actor, `Unlinked asset ${assetLine(asset)}.`);
    await client.query("UPDATE hd_tickets SET updated_at = now() WHERE id = $1", [ticket.id]);
    return asset ?? null;
  });
}

// --- The asset page --------------------------------------------------------------------------

/**
 * GET /api/helpdesk/assets/[id]: details (refreshed live when the source
 * answers), the tickets on it the viewer may open (the rest counted), and
 * its maintenance records from the source. Undefined when the viewer may
 * not see the asset.
 */
export async function assetPage(user: U & { id: number }, assetId: number): Promise<HdAssetPage | undefined> {
  const s = await getAssetSettings();
  if (!(await agentMaySeeAsset(user, assetId, s))) return undefined;
  let asset = (await getAsset(assetId))!;
  const ext = await hqOne<{ external_id: string }>("SELECT external_id FROM hd_assets WHERE id = $1", [assetId]);
  const provider = await providerFor(asset.provider, s);
  // Its source not connected: the page is a linked asset's history; an unlinked row is only a stale copy.
  if (!provider && !(await hqOne("SELECT 1 FROM hd_ticket_assets WHERE asset_id = $1 LIMIT 1", [assetId]))) return undefined;
  let notice: string | null = null;
  let maintenance: HdAssetPage["maintenance"] = null;
  if (provider && ext) {
    const [fresh, records] = await Promise.allSettled([
      quick(provider.get(ext.external_id)),
      provider.maintenance ? quick(provider.maintenance.list(ext.external_id)) : Promise.resolve(null),
    ]);
    if (fresh.status === "fulfilled") {
      if (fresh.value) {
        await upsertAssets(provider.key, [fresh.value]);
      } else {
        await hq("UPDATE hd_assets SET gone_at = coalesce(gone_at, now()) WHERE id = $1", [assetId]);
      }
      asset = (await getAsset(assetId))!;
    } else notice = `Showing what was synced last: ${errText(fresh.reason)}`;
    if (records.status === "fulfilled") maintenance = records.value;
    else notice = notice ?? `Couldn't load maintenance: ${errText(records.reason)}`;
  } else if (!provider) {
    notice = `${asset.provider_label} isn't connected now, so this is what was synced last.`;
  }
  const linked = await hq<{ id: number; number: number; subject: string; requester_name: string; status: string; created_at: string; team_id: number | null; assignee_id: number | null; requester_id: number | null; minutes: number }>(
    `SELECT t.id, t.number, t.subject, t.requester_name, t.status, t.created_at, t.team_id, t.assignee_id, t.requester_id,
            coalesce((SELECT sum(minutes)::int FROM hd_time_entries e WHERE e.ticket_id = t.id), 0) AS minutes
       FROM hd_ticket_assets l JOIN hd_tickets t ON t.id = l.ticket_id
      WHERE l.asset_id = $1
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 500`,
    [assetId]
  );
  const total = (await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_ticket_assets WHERE asset_id = $1", [assetId]))?.n ?? 0;
  const tickets: HdAssetPage["tickets"] = [];
  const teams = await agentTeamIds(user);
  // The desk's scope first (one lookup for the lot); an approver's or a CC's ticket is asked one by one.
  const inScope = (t: Pick<HdTicket, "assignee_id" | "requester_id" | "team_id">) =>
    teams === "all" || t.assignee_id === user.id || t.requester_id === user.id || (t.team_id !== null && teams.includes(t.team_id));
  // Up to 200 listed (newest first); hidden counts only the ones the viewer may not open.
  let hidden = Math.max(0, total - linked.length);
  for (const t of linked) {
    if (inScope(t) || (await canSeeTicket(user, t))) {
      if (tickets.length < 200) tickets.push({ number: t.number, subject: t.subject, requester_name: t.requester_name, status: t.status, created_at: t.created_at, minutes: t.minutes });
    } else hidden++;
  }
  const shown = maintenance ? await readableMaintenance(user, maintenance, inScope) : null;
  return { asset, tickets, hidden_tickets: hidden, maintenance: shown?.records ?? null, hidden_maintenance: shown?.hidden ?? 0, notice };
}

/**
 * The maintenance records this viewer may read. A record names tickets
 * ("#1047" in its title or notes, as CompassDocs writes them, and as an
 * agent may type); it is shown only when every ticket it names exists, is
 * not anonymised, and is one the viewer may open. The rest are counted,
 * never shown. A record naming no ticket is Snipe-IT's own and is shown.
 */
async function readableMaintenance(
  user: U & { id: number },
  records: HdMaintenanceRecord[],
  inScope: (t: Pick<HdTicket, "assignee_id" | "requester_id" | "team_id">) => boolean
): Promise<{ records: HdMaintenanceRecord[]; hidden: number }> {
  const refs = new Map(records.map((m) => [m, ticketRefs(`${m.title}\n${m.notes}`)]));
  const numbers = [...new Set([...refs.values()].flat())];
  const found = numbers.length
    ? await hq<{ id: number; number: number; team_id: number | null; assignee_id: number | null; requester_id: number | null; anonymised: boolean }>(
        "SELECT id, number, team_id, assignee_id, requester_id, (anonymised_at IS NOT NULL) AS anonymised FROM hd_tickets WHERE number = ANY($1::int[])",
        [numbers]
      )
    : [];
  const readable = new Map<number, boolean>();
  for (const n of numbers) {
    const t = found.find((x) => x.number === n);
    readable.set(n, !!t && !t.anonymised && (inScope(t) || (await canSeeTicket(user, t))));
  }
  const out: HdMaintenanceRecord[] = [];
  let hidden = 0;
  for (const m of records) {
    if (refs.get(m)!.every((n) => readable.get(n))) out.push(m);
    else hidden++;
  }
  return { records: out, hidden };
}

// --- Solving with a maintenance record -------------------------------------------------------

const supplierCache = new Map<string, { at: number; list: { id: number; name: string }[] }>();

/** The linked assets a solve may log maintenance for: present when the setting is on and a source takes it. */
export async function solveOffer(ticket: HdTicket): Promise<HdSolveOffer | null> {
  const s = await getAssetSettings();
  if (s.snipeit.on_solve !== "offer_maintenance") return null;
  const provider = await providerFor(snipeKey(), s);
  if (!provider?.maintenance) return null;
  const assets = (await linkedAssets(ticket.id)).filter((a) => a.provider === provider.key && !a.gone);
  if (!assets.length) return null;
  let suppliers = supplierCache.get(provider.key);
  if (!suppliers || Date.now() - suppliers.at > 10 * 60_000) {
    try {
      suppliers = { at: Date.now(), list: await quick(provider.maintenance.suppliers(), 5_000) };
      supplierCache.set(provider.key, suppliers);
    } catch {
      suppliers = { at: 0, list: [] };
    }
  }
  return {
    provider_label: provider.label,
    assets: assets.map((a) => ({ id: a.id, name: a.name, tag: a.tag })),
    types: SNIPEIT_MAINTENANCE_TYPES,
    suppliers: suppliers.list,
    note: maintenanceNotePrefill(ticket.number),
  };
}

/** What the desk sends after the solve: which assets, the type, the supplier (null: in house) and the note. */
export interface MaintenanceRequest {
  asset_ids: number[];
  type: string;
  supplier_id: number | null;
  note: string;
}

export function checkMaintenanceRequest(b: Record<string, unknown> | null): { ok: true; value: MaintenanceRequest } | { ok: false; error: string } {
  if (!b) return { ok: false, error: "Send the maintenance record as JSON." };
  const ids = Array.isArray(b.asset_ids) ? [...new Set(b.asset_ids)] : [];
  if (!ids.length || !ids.every((i) => Number.isInteger(i) && (i as number) > 0)) return { ok: false, error: "Choose the assets to log it for." };
  if (ids.length > ASSET_LIMITS.perTicket) return { ok: false, error: `Choose up to ${ASSET_LIMITS.perTicket} assets.` };
  const type = SNIPEIT_MAINTENANCE_TYPES.find((t) => t.value === b.type)?.value;
  if (!type) return { ok: false, error: "Choose the type of maintenance." };
  const sup = b.supplier_id === null || b.supplier_id === undefined || b.supplier_id === 0 ? null : Number(b.supplier_id);
  if (sup !== null && (!Number.isInteger(sup) || sup <= 0)) return { ok: false, error: "Choose a supplier, or In house." };
  if (b.note !== undefined && typeof b.note !== "string") return { ok: false, error: "The note is text." };
  const note = String(b.note ?? "");
  if (note.length > ASSET_LIMITS.note) return { ok: false, error: `Keep the note under ${ASSET_LIMITS.note} characters.` };
  return { ok: true, value: { asset_ids: ids as number[], type, supplier_id: sup, note } };
}

export interface MaintenanceOutcome {
  logged: { asset_id: number; tag: string; name: string; record_id: string }[];
  failed: { asset_id: number; tag: string; name: string; error: string }[];
  /** Already logged for this solve (by this request's twin, another tab or another instance). */
  skipped: { asset_id: number; tag: string }[];
}

/** How long after their solve the agent may send its maintenance record. */
export const MAINTENANCE_WINDOW_MS = 15 * 60_000;

/**
 * Log the maintenance record(s) in the source for the solve that was just
 * made. Tied to that solve: the ticket is solved, solved in the last 15
 * minutes (the database's clock), and by this agent (the solve's own
 * timeline line). Each (ticket, asset, solve) is claimed in
 * hd_asset_maintenance_log before the post (released if the post fails),
 * so no request, tab or instance posts it twice and a later call can't
 * add records to an old ticket. Each success leaves an internal timeline
 * line; each failure an internal note saying why; the solve stands.
 */
export async function logMaintenance(ticket: HdTicket, req: MaintenanceRequest, actor: AssetActor & { id: number }, today: string = new Date().toISOString().slice(0, 10)): Promise<MaintenanceOutcome> {
  if (ticket.status !== "solved" && ticket.status !== "closed") throw new AssetError("Solve the ticket first: the record is logged once it's solved.", 409);
  const fresh = await hqOne<{ ok: boolean }>(
    `SELECT (t.solved_at IS NOT NULL AND t.status IN ('solved', 'closed') AND t.solved_at > now() - make_interval(secs => $3)
             AND EXISTS (SELECT 1 FROM hd_messages m WHERE m.ticket_id = t.id AND m.kind = 'system' AND m.author_id = $2
                           AND m.body LIKE '% to Solved%' AND m.created_at >= t.solved_at)) AS ok
       FROM hd_tickets t WHERE t.id = $1`,
    [ticket.id, actor.id, MAINTENANCE_WINDOW_MS / 1000]
  );
  if (!fresh?.ok) throw new AssetError("A maintenance record is logged from the solve dialog, right after you solve the ticket. Log this one in Snipe-IT itself.", 409);
  const s = await getAssetSettings();
  if (s.snipeit.on_solve !== "offer_maintenance") throw new AssetError("Logging maintenance on solve is switched off in Desk settings, Assets.", 409);
  const provider = await providerFor(snipeKey(), s);
  if (!provider?.maintenance) throw new AssetError(NOT_CONNECTED, 409);
  const linked = (await linkedAssets(ticket.id)).filter((a) => a.provider === provider.key);
  const out: MaintenanceOutcome = { logged: [], failed: [], skipped: [] };
  for (const id of req.asset_ids) {
    const a = linked.find((x) => x.id === id);
    if (!a) throw new AssetError("That asset isn't linked to this ticket.", 409);
  }
  const typeLabel = maintenanceTypeLabel(req.type);
  for (const id of req.asset_ids) {
    const a = linked.find((x) => x.id === id)!;
    // The claim, before anything is sent: one per (ticket, asset, this solve), shared by every process.
    const claimed = await hq(
      `INSERT INTO hd_asset_maintenance_log (ticket_id, asset_id, solved_at, claimed_by)
       SELECT id, $2, solved_at, $3 FROM hd_tickets WHERE id = $1 AND solved_at IS NOT NULL
       ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
      [ticket.id, a.id, actor.id]
    );
    if (!claimed.length) {
      out.skipped.push({ asset_id: a.id, tag: a.tag });
      continue;
    }
    const release = () => hq("DELETE FROM hd_asset_maintenance_log WHERE ticket_id = $1 AND asset_id = $2 AND record_id = '' AND solved_at = (SELECT solved_at FROM hd_tickets WHERE id = $1)", [ticket.id, a.id]);
    const ext = await hqOne<{ external_id: string }>("SELECT external_id FROM hd_assets WHERE id = $1", [a.id]);
    try {
      if (a.gone || !ext) throw new AssetError(`${a.tag || a.name} is no longer in ${provider.label}.`);
      const r = await provider.maintenance.log({
        external_id: ext.external_id,
        type: req.type,
        supplier_id: req.supplier_id,
        // Never the subject: Snipe-IT shows this to everyone who opens the asset, here and there.
        title: maintenanceTitle(ticket.number, typeLabel),
        note: noteWithTicket(req.note, ticket.number),
        date: today,
      });
      await hq(
        "UPDATE hd_asset_maintenance_log SET record_id = $3 WHERE ticket_id = $1 AND asset_id = $2 AND solved_at = (SELECT solved_at FROM hd_tickets WHERE id = $1)",
        [ticket.id, a.id, r.id || "logged"]
      );
      out.logged.push({ asset_id: a.id, tag: a.tag, name: a.name, record_id: r.id });
      await timeline(POOL, ticket.id, actor, `Logged a ${typeLabel.toLowerCase()} maintenance record in ${provider.label} for ${assetLine(a)}.`);
    } catch (e) {
      await release();
      const error = errText(e);
      out.failed.push({ asset_id: a.id, tag: a.tag, name: a.name, error });
      await timeline(
        POOL,
        ticket.id,
        actor,
        `Couldn't log the maintenance record in ${provider.label} for ${assetLine(a)}: ${error} The ticket is solved all the same; log it in ${provider.label} by hand if it's needed.`
      );
    }
  }
  return out;
}

// --- Merge, retention, export ------------------------------------------------------------------

/**
 * Merge (on the merge's own client, inside its transaction): every one of the
 * duplicate's links moves to the kept ticket (one link per asset), so links
 * live with the conversation and its retention, legal hold and anonymising.
 * The ten-a-ticket limit is for linking by hand (linkAsset); a merge may
 * leave the kept ticket with more.
 */
export async function moveAssetLinksTx(client: PoolClient, fromTicketId: number, toTicketId: number): Promise<number> {
  const moved = await client.query(
    `INSERT INTO hd_ticket_assets (ticket_id, asset_id, linked_by, linked_by_name, linked_at)
     SELECT $2, asset_id, linked_by, linked_by_name, linked_at FROM hd_ticket_assets WHERE ticket_id = $1
     ON CONFLICT DO NOTHING`,
    [fromTicketId, toTicketId]
  );
  await client.query("DELETE FROM hd_ticket_assets WHERE ticket_id = $1", [fromTicketId]);
  return moved.rowCount ?? 0;
}

/** Anonymising a ticket removes its asset links, its maintenance claims and the device from its asset audit rows (who had which device is personal). */
export async function anonymiseTicketAssetsTx(client: PoolClient, ticketId: number): Promise<void> {
  await client.query("DELETE FROM hd_ticket_assets WHERE ticket_id = $1", [ticketId]);
  await client.query("DELETE FROM hd_asset_maintenance_log WHERE ticket_id = $1", [ticketId]);
  // Its asset audit rows keep the action, actor and time; which device it was goes.
  await client.query(
    `UPDATE audit_log SET details = details - 'asset_id' - 'tag' - 'name' - 'error' - 'record_id'
      WHERE target_type = 'helpdesk_ticket' AND target_id = $1 AND action LIKE 'helpdesk.asset.%' AND details IS NOT NULL`,
    [String(ticketId)]
  );
}

/** A person's export: the assets linked to these (their own) requests, tag and name only. */
export async function assetsForExport(ticketIds: number[]): Promise<Map<number, { tag: string; name: string }[]>> {
  const out = new Map<number, { tag: string; name: string }[]>();
  if (!ticketIds.length) return out;
  const rows = await hq<{ ticket_id: number; tag: string; name: string }>(
    `SELECT l.ticket_id, a.tag, a.name FROM hd_ticket_assets l JOIN hd_assets a ON a.id = l.asset_id
      WHERE l.ticket_id = ANY($1::int[]) ORDER BY l.linked_at, a.id`,
    [ticketIds]
  );
  for (const r of rows) {
    const list = out.get(r.ticket_id) ?? [];
    list.push({ tag: r.tag, name: r.name });
    out.set(r.ticket_id, list);
  }
  return out;
}

// --- Get help: a requester's own devices -------------------------------------------------------

/**
 * The requester's own assets, for Get help's Device picker: matched only on
 * their account's confirmed address (confirmedEmailOf), never on one they
 * typed themselves; nothing (and no live lookup) otherwise.
 */
export async function myAssets(user: { id: number }): Promise<{ id: number; name: string; tag: string; category: string; model: string }[]> {
  const email = await confirmedEmailOf(user.id);
  if (!email) return [];
  const providers = await activeProviders();
  if (!providers.length) return [];
  const { rows } = await assetsOfEmail(email, providers);
  return rows.map((r) => ({ id: r.id, name: r.name, tag: r.tag, category: r.category, model: r.model }));
}

/** Is this asset the requester's own (their confirmed address, still in the source, and the source connected)? */
export async function isRequesterAsset(user: { id: number }, assetId: number): Promise<boolean> {
  if (!Number.isInteger(assetId) || assetId <= 0) return false;
  if (!(await assetsConnected())) return false;
  const email = await confirmedEmailOf(user.id);
  if (!email) return false;
  return !!(await hqOne("SELECT 1 FROM hd_assets WHERE id = $1 AND assigned_email = $2 AND gone_at IS NULL", [assetId, email]));
}

/** Link the device the requester picked when raising the request (already checked as theirs). False when nothing was linked (no source connected). */
export async function linkRequesterAsset(ticketId: number, assetId: number, actor: AssetActor): Promise<boolean> {
  if (!(await assetsConnected())) return false;
  return withTx(async (client) => {
    const ins = await client.query(
      `INSERT INTO hd_ticket_assets (ticket_id, asset_id, linked_by, linked_by_name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [ticketId, assetId, actor.id, actor.name.slice(0, 200)]
    );
    const a = ins.rowCount ? await getAsset(assetId, client) : undefined;
    if (a) await timeline(client, ticketId, null, `The requester picked their device ${assetLine(a)} when raising the request.`);
    return !!ins.rowCount;
  });
}

// --- The Claude connector ----------------------------------------------------------------------

const mcpAsset = (a: HdAsset) => ({
  id: a.id,
  tag: a.tag,
  name: a.name,
  serial: a.serial || null,
  model: a.model || null,
  category: a.category || null,
  status: a.status_kind === "deployed" ? "Deployed" : a.status_label || null,
  assigned_to: a.assigned_name || null,
  location: a.location || null,
  warranty_end: a.warranty_end,
  source: a.provider_label,
  url: a.url || null,
  ...(a.gone ? { gone_from_source: true } : {}),
});

/** hd_read_ticket (agents): the ticket's linked assets. */
export async function assetsForMcp(ticketId: number): Promise<unknown[]> {
  return (await linkedAssets(ticketId)).map((a) => ({ ...mcpAsset(a), earlier_tickets: a.earlier_tickets }));
}

/** hd_asset_lookup (agents): search as the desk's picker does, with each asset's ticket count. */
export async function assetLookupForMcp(user: U & { id: number }, query: string, limit = 10): Promise<{ assets: unknown[]; notice: string | null }> {
  const { rows, notice } = await searchAssets(user, query, { limit });
  const counts = rows.length
    ? new Map(
        (await hq<{ asset_id: number; n: number }>("SELECT asset_id, count(*)::int AS n FROM hd_ticket_assets WHERE asset_id = ANY($1::int[]) GROUP BY asset_id", [rows.map((r) => r.id)])).map(
          (r) => [r.asset_id, r.n]
        )
      )
    : new Map<number, number>();
  return { assets: rows.map((r) => ({ ...mcpAsset(view(r)), tickets: counts.get(r.id) ?? 0 })), notice };
}
