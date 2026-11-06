// Helpdesk 1.19.0: the SLA tables and the sweep (the pure arithmetic is
// lib/helpdesk/sla). Policies are one row per priority; the sweep claims
// each breach and each nearing warning exactly once (a single UPDATE …
// RETURNING per kind, under a transaction-scoped advisory try-lock so two
// instances never sweep at once) and hands the claimed events to the
// notifications and rules after the transaction, with no client held.
// Server-only.

import "server-only";
import { hq, hqOne, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import { getBusinessHours } from "./settings";
import { starterPolicies } from "./sla";
import { HD_PRIORITIES } from "./types";
import type { HdPriority, HdSlaPolicy } from "./types";

export const SLA_LIMITS = { name: 60, maxMinutes: 60 * 24 * 90 } as const;

export async function listSlaPolicies(client?: HdQueryable): Promise<HdSlaPolicy[]> {
  const rows = await hq<HdSlaPolicy>(
    "SELECT id, name, priority, first_reply_minutes, resolve_minutes, business_hours FROM hd_sla_policies",
    [],
    client
  );
  return rows.sort((a, b) => HD_PRIORITIES.indexOf(b.priority) - HD_PRIORITIES.indexOf(a.priority));
}

export async function slaPolicyFor(priority: HdPriority, client?: HdQueryable): Promise<HdSlaPolicy | undefined> {
  return hqOne<HdSlaPolicy>(
    "SELECT id, name, priority, first_reply_minutes, resolve_minutes, business_hours FROM hd_sla_policies WHERE priority = $1",
    [priority],
    client
  );
}

export async function getSlaPolicy(id: number, client?: HdQueryable): Promise<HdSlaPolicy | undefined> {
  return hqOne<HdSlaPolicy>(
    "SELECT id, name, priority, first_reply_minutes, resolve_minutes, business_hours FROM hd_sla_policies WHERE id = $1",
    [id],
    client
  );
}

export type SlaPolicyInput = Omit<HdSlaPolicy, "id">;

/** Validate PUT /api/helpdesk/admin/sla's body: an array of up to four rows, one per priority. */
export function validateSlaPolicies(raw: unknown): { ok: true; value: SlaPolicyInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "Send the policies as a list." };
  if (raw.length > HD_PRIORITIES.length) return { ok: false, error: "One policy per priority." };
  const seen = new Set<string>();
  const out: SlaPolicyInput[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") return { ok: false, error: "Each policy is an object." };
    const priority = r.priority as HdPriority;
    if (!HD_PRIORITIES.includes(priority)) return { ok: false, error: "Unknown priority." };
    if (seen.has(priority)) return { ok: false, error: "One policy per priority." };
    seen.add(priority);
    const fr = Number(r.first_reply_minutes);
    const rs = Number(r.resolve_minutes);
    for (const [label, v] of [["first reply", fr], ["resolution", rs]] as const) {
      if (!Number.isInteger(v) || v < 1 || v > SLA_LIMITS.maxMinutes) {
        return { ok: false, error: `The ${label} target must be between 1 minute and 90 days.` };
      }
    }
    const name = typeof r.name === "string" ? r.name.trim().slice(0, SLA_LIMITS.name) : "";
    out.push({
      name: name || priority[0].toUpperCase() + priority.slice(1),
      priority,
      first_reply_minutes: fr,
      resolve_minutes: rs,
      business_hours: r.business_hours === 0 || r.business_hours === false ? 0 : 1,
    });
  }
  return { ok: true, value: out };
}

/**
 * Replace the policy set: the given priorities are upserted, the others
 * removed (their tickets keep the dues they have; sla_policy_id SET NULL).
 * Existing tickets are not re-timed.
 */
export async function saveSlaPolicies(rows: SlaPolicyInput[]): Promise<HdSlaPolicy[]> {
  await withTx(async (client) => {
    await client.query("DELETE FROM hd_sla_policies WHERE priority <> ALL($1::text[])", [rows.map((r) => r.priority)]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO hd_sla_policies (name, priority, first_reply_minutes, resolve_minutes, business_hours)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (priority) DO UPDATE SET name = EXCLUDED.name, first_reply_minutes = EXCLUDED.first_reply_minutes,
           resolve_minutes = EXCLUDED.resolve_minutes, business_hours = EXCLUDED.business_hours`,
        [r.name, r.priority, r.first_reply_minutes, r.resolve_minutes, r.business_hours]
      );
    }
  });
  return listSlaPolicies();
}

/** The starter rows, inserted only for priorities that have none (setup's "Use starter set"). */
export async function ensureStarterPolicies(client?: HdQueryable): Promise<number> {
  const hours = await getBusinessHours();
  let added = 0;
  for (const p of starterPolicies(hours)) {
    const rows = await hq(
      `INSERT INTO hd_sla_policies (name, priority, first_reply_minutes, resolve_minutes, business_hours)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (priority) DO NOTHING RETURNING id`,
      [p.name, p.priority, p.first_reply_minutes, p.resolve_minutes, p.business_hours],
      client
    );
    added += rows.length;
  }
  return added;
}

// --- The sweep -----------------------------------------------------------------

/** pg_try_advisory_xact_lock key for the SLA sweep. */
export const SLA_SWEEP_LOCK = 7_281_901;

export type SlaTarget = "first_reply" | "resolve";
export interface SlaSweepEvent {
  ticket_id: number;
  kind: "warning" | "breach";
  target: SlaTarget;
}
export interface SlaSweepResult {
  /** False when another instance held the lock (nothing claimed). */
  ran: boolean;
  events: SlaSweepEvent[];
}

const OPEN = "('new', 'open', 'pending', 'on_hold')";

/**
 * Claim this minute's SLA events. Breaches: a running clock past its due,
 * claimed once per target (first_reply_breached_at / resolve_breached_at).
 * Warnings: a running clock inside its warn window (a quarter of the target
 * span, 15 to 60 minutes), claimed once per ticket (sla_warned_at, cleared
 * when the due moves). Paused tickets are skipped: their clock is stopped.
 * `ticketIds` limits the claim to those tickets (tests sharing a database).
 */
export async function claimSlaEvents(now = new Date(), ticketIds?: number[]): Promise<SlaSweepResult> {
  return withTx(async (client) => {
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [SLA_SWEEP_LOCK]);
    if (!lock.rows[0]?.ok) return { ran: false, events: [] };
    const only = ticketIds ? "AND id = ANY($2::int[])" : "";
    const params: unknown[] = ticketIds ? [now, ticketIds] : [now];
    const events: SlaSweepEvent[] = [];
    const fr = await client.query<{ id: number }>(
      `UPDATE hd_tickets SET first_reply_breached_at = $1
        WHERE status IN ${OPEN} AND sla_paused_at IS NULL AND first_replied_at IS NULL
          AND first_reply_due IS NOT NULL AND first_reply_due < $1 AND first_reply_breached_at IS NULL ${only}
        RETURNING id`,
      params
    );
    for (const r of fr.rows) events.push({ ticket_id: r.id, kind: "breach", target: "first_reply" });
    const rs = await client.query<{ id: number }>(
      `UPDATE hd_tickets SET resolve_breached_at = $1
        WHERE status IN ${OPEN} AND sla_paused_at IS NULL
          AND resolve_due IS NOT NULL AND resolve_due < $1 AND resolve_breached_at IS NULL ${only}
        RETURNING id`,
      params
    );
    for (const r of rs.rows) events.push({ ticket_id: r.id, kind: "breach", target: "resolve" });
    // The warn window: span/4 clamped to [15, 60] minutes, span = due − created.
    const warn = await client.query<{ id: number; target: SlaTarget }>(
      `UPDATE hd_tickets t SET sla_warned_at = $1
         FROM (SELECT id,
                      CASE WHEN first_replied_at IS NULL AND first_reply_due IS NOT NULL THEN 'first_reply' ELSE 'resolve' END AS target,
                      CASE WHEN first_replied_at IS NULL AND first_reply_due IS NOT NULL THEN first_reply_due ELSE resolve_due END AS due,
                      created_at
                 FROM hd_tickets
                WHERE status IN ${OPEN} AND sla_paused_at IS NULL AND sla_warned_at IS NULL ${only}) c
        WHERE t.id = c.id AND c.due IS NOT NULL AND c.due >= $1
          AND c.due - $1 <= LEAST(interval '60 minutes', GREATEST(interval '15 minutes', (c.due - c.created_at) / 4))
        RETURNING t.id, c.target`,
      params
    );
    for (const r of warn.rows) events.push({ ticket_id: r.id, kind: "warning", target: r.target });
    return { ran: true, events };
  });
}

/** The sweep: claim, then hand each event to the notices and rules (C's onSlaEvent), no client held. */
export async function slaSweep(now = new Date(), opts: { ticketIds?: number[]; deliver?: boolean } = {}): Promise<SlaSweepResult> {
  const result = await claimSlaEvents(now, opts.ticketIds);
  if (opts.deliver === false) return result;
  for (const e of result.events) {
    try {
      const { onSlaEvent } = await import("./notify");
      await onSlaEvent(e.ticket_id, e.kind, e.target);
    } catch (err) {
      console.error("[helpdesk] sla event:", err);
    }
  }
  return result;
}
