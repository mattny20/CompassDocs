// Helpdesk 1.19.0, machine intake (agent P): integrations. Each is one
// monitoring tool, bot or automated mail sender with an API key (shown
// once; only its sha256 and first characters are stored), a default team
// and priority, a severity map and the dedup rules. Also the deliveries log
// and the admin views. Server-only.
//
// The schema (lib/helpdesk/intake-schema) is part of lib/db's SCHEMA, which
// the boot applies (dbReady). Only when that boot schema predates a column
// this build reads (a database another binary created) is the intake DDL
// run here, once per process, under an advisory lock.

import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { dbReady, pool } from "../../db";
import { hq, hqOne } from "../db-core";
import type { HdQueryable } from "../db-core";
import { HD_INTAKE_SCHEMA } from "../intake-schema";
import { HD_PRIORITIES } from "../types";
import type { HdPriority } from "../types";
import { cleanSenderAddresses, validDedupPattern } from "./email-rules";
import {
  HD_ALERT_SEVERITIES,
  HD_DEFAULT_SEVERITY_MAP,
  HD_INTAKE_LIMITS,
  isIntegrationKind,
  isWebhookKind,
  type HdDeliveryView,
  type HdIntakeOutcome,
  type HdIntegrationKind,
  type HdIntegrationView,
  type HdSeverityMap,
} from "./shared";

// --- Schema -----------------------------------------------------------------------

let schemaReady: Promise<void> | null = null;

/** The intake schema is in place: the boot's, or (when it lacks this build's newest column) HD_INTAKE_SCHEMA run once. */
export function ensureIntakeSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await dbReady();
      // The newest intake column: present means the boot schema already covered everything.
      const have = await hqOne(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'hd_integrations' AND column_name = 'allow_unverified_mail'"
      );
      if (have) return;
      const client = await pool().connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('compassdocs:hd_intake_schema'))");
        await client.query(HD_INTAKE_SCHEMA);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// --- Keys -------------------------------------------------------------------------

export const KEY_PREFIX = "cdhk_";

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** A new API key: "cdhk_" + 40 base62 characters. Returned to the admin once. */
export function newIntegrationKey(): { key: string; hash: string; prefix: string } {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (const b of randomBytes(40)) s += alphabet[b % 62];
  const key = `${KEY_PREFIX}${s}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, KEY_PREFIX.length + 6) };
}

/** Constant-time comparison of the given key's hash with the stored hash. */
export function keyMatches(given: string, storedHash: string): boolean {
  if (!given || !storedHash || storedHash.length !== 64) return false;
  const a = Buffer.from(hashKey(given), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Rows -------------------------------------------------------------------------

export interface HdIntegrationRow {
  id: number;
  name: string;
  kind: HdIntegrationKind;
  token_hash: string;
  token_prefix: string;
  sender_addresses: string[];
  subject_dedup_pattern: string;
  default_team_id: number | null;
  default_priority: HdPriority;
  severity_map: HdSeverityMap;
  dedup_window_minutes: number;
  auto_resolve: number;
  reopen_on_repeat: number;
  rate_limit_per_minute: number;
  enabled: number;
  /** Email kind: 1 = mail without any sender verdict is accepted (a failing verdict never is). */
  allow_unverified_mail: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export async function getIntegration(id: number, client?: HdQueryable): Promise<HdIntegrationRow | undefined> {
  if (!client) await ensureIntakeSchema();
  if (!Number.isInteger(id) || id <= 0 || id > 2_000_000_000) return undefined;
  return hqOne<HdIntegrationRow>("SELECT * FROM hd_integrations WHERE id = $1", [id], client);
}

/** Enabled email integrations listing this sender (lower-cased). */
export async function emailIntegrationsFor(address: string): Promise<HdIntegrationRow[]> {
  await ensureIntakeSchema();
  if (!address) return [];
  return hq<HdIntegrationRow>(
    "SELECT * FROM hd_integrations WHERE kind = 'email' AND enabled = 1 AND sender_addresses @> $1::jsonb ORDER BY id",
    [JSON.stringify([address.toLowerCase()])]
  );
}

export function endpointPath(id: number): string {
  return `/api/helpdesk/intake/${id}`;
}

export async function listIntegrations(opts: { ids?: number[] } = {}): Promise<HdIntegrationView[]> {
  await ensureIntakeSchema();
  const rows = await hq<HdIntegrationRow & { team_name: string | null; created_by_name: string | null; alerts_24h: number }>(
    `SELECT i.*, t.name AS team_name, COALESCE(NULLIF(u.name, ''), u.username) AS created_by_name,
            (SELECT count(*)::int FROM hd_alert_keys k WHERE k.integration_id = i.id AND k.last_seen > now() - interval '24 hours') AS alerts_24h
       FROM hd_integrations i
       LEFT JOIN hd_teams t ON t.id = i.default_team_id
       LEFT JOIN users u ON u.id = i.created_by
      ${opts.ids ? "WHERE i.id = ANY($1)" : ""}
      ORDER BY lower(i.name), i.id`,
    opts.ids ? [opts.ids] : []
  );
  return rows.map(toView);
}

export async function getIntegrationView(id: number): Promise<HdIntegrationView | undefined> {
  return (await listIntegrations({ ids: [id] }))[0];
}

function toView(r: HdIntegrationRow & { team_name: string | null; created_by_name: string | null; alerts_24h: number }): HdIntegrationView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    token_prefix: r.token_prefix,
    sender_addresses: r.sender_addresses ?? [],
    subject_dedup_pattern: r.subject_dedup_pattern,
    default_team_id: r.default_team_id,
    team_name: r.team_name,
    default_priority: r.default_priority,
    severity_map: r.severity_map ?? {},
    dedup_window_minutes: r.dedup_window_minutes,
    auto_resolve: r.auto_resolve === 1,
    reopen_on_repeat: r.reopen_on_repeat === 1,
    rate_limit_per_minute: r.rate_limit_per_minute,
    enabled: r.enabled === 1,
    allow_unverified_mail: r.allow_unverified_mail === 1,
    created_by_name: r.created_by_name,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_used_at: r.last_used_at,
    alerts_24h: r.alerts_24h ?? 0,
    endpoint_path: isWebhookKind(r.kind) ? endpointPath(r.id) : "",
  };
}

// --- Validation ---------------------------------------------------------------------

export class IntegrationInputError extends Error {}

export interface IntegrationInput {
  name?: string;
  kind?: HdIntegrationKind;
  sender_addresses?: string[];
  subject_dedup_pattern?: string;
  default_team_id?: number | null;
  default_priority?: HdPriority;
  severity_map?: HdSeverityMap;
  dedup_window_minutes?: number;
  auto_resolve?: boolean;
  reopen_on_repeat?: boolean;
  rate_limit_per_minute?: number;
  enabled?: boolean;
  allow_unverified_mail?: boolean;
}

function intIn(v: unknown, min: number, max: number, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new IntegrationInputError(`${what} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** Validate a create (all of kind and name) or a PATCH (any subset). Throws IntegrationInputError. */
export function validateIntegrationInput(raw: Record<string, unknown>, opts: { create: boolean }): IntegrationInput {
  const out: IntegrationInput = {};
  if (opts.create || raw.kind !== undefined) {
    if (!opts.create) throw new IntegrationInputError("An integration's kind can't be changed; make a new one.");
    if (!isIntegrationKind(raw.kind)) throw new IntegrationInputError("Choose what kind of integration this is.");
    out.kind = raw.kind;
  }
  if (opts.create || raw.name !== undefined) {
    const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
    if (!name || name.length > HD_INTAKE_LIMITS.name) throw new IntegrationInputError(`The name must be 1 to ${HD_INTAKE_LIMITS.name} characters.`);
    out.name = name;
  }
  if (raw.sender_addresses !== undefined) {
    const list = cleanSenderAddresses(raw.sender_addresses);
    if (!list) throw new IntegrationInputError(`Sender addresses must be up to ${HD_INTAKE_LIMITS.senders} valid email addresses.`);
    out.sender_addresses = list;
  }
  if (raw.subject_dedup_pattern !== undefined) {
    const p = typeof raw.subject_dedup_pattern === "string" ? raw.subject_dedup_pattern.trim() : "";
    if (!validDedupPattern(p)) throw new IntegrationInputError("The subject pattern is not a valid regular expression.");
    out.subject_dedup_pattern = p;
  }
  if (raw.default_team_id !== undefined) {
    if (raw.default_team_id === null || raw.default_team_id === "") out.default_team_id = null;
    else out.default_team_id = intIn(raw.default_team_id, 1, 2_000_000_000, "The team");
  }
  if (raw.default_priority !== undefined) {
    if (!(HD_PRIORITIES as readonly string[]).includes(String(raw.default_priority))) throw new IntegrationInputError("Unknown priority.");
    out.default_priority = raw.default_priority as HdPriority;
  }
  if (raw.severity_map !== undefined) {
    if (!raw.severity_map || typeof raw.severity_map !== "object" || Array.isArray(raw.severity_map)) throw new IntegrationInputError("The severity map must be an object.");
    const map: HdSeverityMap = {};
    for (const [k, v] of Object.entries(raw.severity_map as Record<string, unknown>)) {
      if (!(HD_ALERT_SEVERITIES as readonly string[]).includes(k)) throw new IntegrationInputError(`Unknown severity: ${k.slice(0, 30)}.`);
      if (!(HD_PRIORITIES as readonly string[]).includes(String(v))) throw new IntegrationInputError("Each severity maps to a priority.");
      map[k as keyof HdSeverityMap] = v as HdPriority;
    }
    out.severity_map = map;
  }
  if (raw.dedup_window_minutes !== undefined) out.dedup_window_minutes = intIn(raw.dedup_window_minutes, 0, HD_INTAKE_LIMITS.dedupWindowMax, "The dedup window");
  if (raw.rate_limit_per_minute !== undefined) out.rate_limit_per_minute = intIn(raw.rate_limit_per_minute, 1, HD_INTAKE_LIMITS.rateMax, "The rate limit");
  for (const k of ["auto_resolve", "reopen_on_repeat", "enabled", "allow_unverified_mail"] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "boolean") throw new IntegrationInputError(`${k} must be true or false.`);
    out[k] = raw[k] as boolean;
  }
  if (opts.create && out.kind === "email" && !(out.sender_addresses?.length)) {
    throw new IntegrationInputError("Add the address the automated mail comes from.");
  }
  return out;
}

async function teamExists(id: number, client?: HdQueryable): Promise<boolean> {
  return !!(await hqOne("SELECT 1 FROM hd_teams WHERE id = $1", [id], client));
}

/** Create an integration; returns it and its key (the only time the key exists outside the caller). */
export async function createIntegration(input: IntegrationInput, createdBy: number | null): Promise<{ integration: HdIntegrationView; key: string | null }> {
  await ensureIntakeSchema();
  if (!input.kind || !input.name) throw new IntegrationInputError("A kind and a name are required.");
  if (input.default_team_id && !(await teamExists(input.default_team_id))) throw new IntegrationInputError("That team does not exist.");
  // Email integrations authenticate by sender (and SPF/DKIM), not by key.
  const k = input.kind === "email" ? null : newIntegrationKey();
  const row = await hqOne<{ id: number }>(
    `INSERT INTO hd_integrations (name, kind, token_hash, token_prefix, sender_addresses, subject_dedup_pattern, default_team_id,
        default_priority, severity_map, dedup_window_minutes, auto_resolve, reopen_on_repeat, rate_limit_per_minute, enabled, created_by,
        allow_unverified_mail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [
      input.name,
      input.kind,
      k?.hash ?? "",
      k?.prefix ?? "",
      JSON.stringify(input.sender_addresses ?? []),
      input.subject_dedup_pattern ?? "",
      input.default_team_id ?? null,
      input.default_priority ?? "normal",
      JSON.stringify(input.severity_map ?? HD_DEFAULT_SEVERITY_MAP),
      input.dedup_window_minutes ?? 1440,
      input.auto_resolve === false ? 0 : 1,
      input.reopen_on_repeat === false ? 0 : 1,
      input.rate_limit_per_minute ?? 60,
      input.enabled === false ? 0 : 1,
      createdBy,
      input.kind === "email" && input.allow_unverified_mail === true ? 1 : 0,
    ]
  );
  return { integration: (await getIntegrationView(row!.id))!, key: k?.key ?? null };
}

/** Apply a PATCH; returns the changed field names and the view. */
export async function updateIntegration(id: number, input: IntegrationInput): Promise<{ integration: HdIntegrationView; changed: string[] } | undefined> {
  const before = await getIntegration(id);
  if (!before) return undefined;
  if (input.default_team_id && !(await teamExists(input.default_team_id))) throw new IntegrationInputError("That team does not exist.");
  if (before.kind === "email" && input.sender_addresses && !input.sender_addresses.length) {
    throw new IntegrationInputError("An email integration needs at least one sender address.");
  }
  const sets: string[] = [];
  const params: unknown[] = [id];
  const changed: string[] = [];
  const set = (col: string, v: unknown, cur: unknown) => {
    if (JSON.stringify(v) === JSON.stringify(cur)) return;
    params.push(typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    sets.push(`${col} = $${params.length}`);
    changed.push(col);
  };
  if (input.name !== undefined) set("name", input.name, before.name);
  if (input.sender_addresses !== undefined) set("sender_addresses", input.sender_addresses, before.sender_addresses);
  if (input.subject_dedup_pattern !== undefined) set("subject_dedup_pattern", input.subject_dedup_pattern, before.subject_dedup_pattern);
  if (input.default_team_id !== undefined) set("default_team_id", input.default_team_id, before.default_team_id);
  if (input.default_priority !== undefined) set("default_priority", input.default_priority, before.default_priority);
  if (input.severity_map !== undefined) set("severity_map", input.severity_map, before.severity_map);
  if (input.dedup_window_minutes !== undefined) set("dedup_window_minutes", input.dedup_window_minutes, before.dedup_window_minutes);
  if (input.rate_limit_per_minute !== undefined) set("rate_limit_per_minute", input.rate_limit_per_minute, before.rate_limit_per_minute);
  if (input.auto_resolve !== undefined) set("auto_resolve", input.auto_resolve ? 1 : 0, before.auto_resolve);
  if (input.reopen_on_repeat !== undefined) set("reopen_on_repeat", input.reopen_on_repeat ? 1 : 0, before.reopen_on_repeat);
  if (input.enabled !== undefined) set("enabled", input.enabled ? 1 : 0, before.enabled);
  if (input.allow_unverified_mail !== undefined && before.kind === "email") set("allow_unverified_mail", input.allow_unverified_mail ? 1 : 0, before.allow_unverified_mail);
  if (sets.length) await hq(`UPDATE hd_integrations SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
  return { integration: (await getIntegrationView(id))!, changed };
}

/** A new key; the old one stops working at once. Null for an email integration (no key). */
export async function rotateIntegrationKey(id: number): Promise<{ integration: HdIntegrationView; key: string } | null | undefined> {
  const before = await getIntegration(id);
  if (!before) return undefined;
  if (before.kind === "email") return null;
  const k = newIntegrationKey();
  await hq("UPDATE hd_integrations SET token_hash = $2, token_prefix = $3, updated_at = now() WHERE id = $1", [id, k.hash, k.prefix]);
  return { integration: (await getIntegrationView(id))!, key: k.key };
}

/** Delete an integration (its alert keys and deliveries go with it; its tickets stay, unlinked). */
export async function deleteIntegration(id: number): Promise<HdIntegrationRow | undefined> {
  await ensureIntakeSchema();
  return hqOne<HdIntegrationRow>("DELETE FROM hd_integrations WHERE id = $1 RETURNING *", [id]);
}

// --- Deliveries ---------------------------------------------------------------------

export const DELIVERIES_KEPT = 200;
export const DELIVERIES_SHOWN = 50;

export async function recordDelivery(
  d: { integration_id: number; status_code: number; outcome: HdIntakeOutcome; reason?: string; ticket_id?: number | null; dedup_key?: string },
  client?: PoolClient
): Promise<void> {
  try {
    await hq(
      `INSERT INTO hd_intake_deliveries (integration_id, status_code, outcome, reason, ticket_id, dedup_key) VALUES ($1, $2, $3, $4, $5, $6)`,
      [d.integration_id, d.status_code, d.outcome, (d.reason ?? "").slice(0, 300), d.ticket_id ?? null, (d.dedup_key ?? "").slice(0, 255)],
      client
    );
    // Keep the newest few hundred per integration.
    await hq(
      `DELETE FROM hd_intake_deliveries WHERE integration_id = $1 AND id < (
         SELECT id FROM hd_intake_deliveries WHERE integration_id = $1 ORDER BY id DESC OFFSET ${DELIVERIES_KEPT - 1} LIMIT 1)`,
      [d.integration_id],
      client
    );
  } catch {
    // The log is a convenience: never fail a delivery over it.
  }
}

export async function listDeliveries(integrationId: number, limit = DELIVERIES_SHOWN): Promise<HdDeliveryView[]> {
  await ensureIntakeSchema();
  return hq<HdDeliveryView>(
    `SELECT d.id, d.at, d.status_code, d.outcome, d.reason, t.number AS ticket_number, d.dedup_key
       FROM hd_intake_deliveries d LEFT JOIN hd_tickets t ON t.id = d.ticket_id
      WHERE d.integration_id = $1 ORDER BY d.id DESC LIMIT $2`,
    [integrationId, Math.min(Math.max(1, limit), DELIVERIES_SHOWN)]
  );
}
