// Append-only audit log of security- and content-significant actions. Writes
// are best-effort: recording an audit entry must never break the action it
// describes, so failures are swallowed (and logged to the server console).
//
// Server-only: uses the Postgres pool.

import { createHash } from "node:crypto";
import { pool, lastAckDecision } from "./db";
import { logEvent } from "./log";
import type { AckOutcomeInfo, SessionUser } from "./types";

export interface AuditActor {
  id?: number | null;
  name?: string;
  role?: string | null;
}

export interface AuditEntry {
  actor?: AuditActor | null;
  action: string; // dot-namespaced, e.g. "document.publish", "user.role_change"
  targetType?: string | null;
  targetId?: string | number | null;
  targetLabel?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
}

export interface AuditRow {
  id: string;
  at: string;
  actor_id: number | null;
  actor_name: string;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

/** Build an actor descriptor from a signed-in session user. */
export function actorFrom(user: Pick<SessionUser, "id" | "name" | "username" | "role"> | null | undefined): AuditActor {
  if (!user) return { name: "system" };
  return { id: user.id, name: user.name || user.username, role: user.role };
}

/**
 * Client IP from proxy headers. X-Forwarded-For is a client-appendable list;
 * the LEFTMOST entry is attacker-controlled, so trusting it lets an attacker
 * rotate a spoofed IP to defeat the login throttle. We instead take the entry
 * added by our own trusted proxy: the Nth-from-the-right, where N is the number
 * of trusted proxies in front of the app (COMPASSDOCS_TRUSTED_PROXY_HOPS,
 * default 1 for the bundled Caddy). Set it higher when another proxy
 * (Cloudflare, a load balancer) sits in front of Caddy.
 */
export function ipFrom(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) {
      const hops = Math.max(1, Number(process.env.COMPASSDOCS_TRUSTED_PROXY_HOPS) || 1);
      // Rightmost is the proxy's own peer; step left by (hops-1) trusted hops.
      const idx = Math.max(0, parts.length - hops);
      return parts[idx];
    }
  }
  return req.headers.get("x-real-ip");
}

/** Record an audit entry. Never throws. */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await pool().query(
      `INSERT INTO audit_log
         (actor_id, actor_name, actor_role, action, target_type, target_id, target_label, details, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.actor?.id ?? null,
        entry.actor?.name ?? "system",
        entry.actor?.role ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId != null ? String(entry.targetId) : null,
        entry.targetLabel ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ip ?? null,
      ]
    );
  } catch (e) {
    logEvent("error", "audit.write_failed", {
      action: entry.action,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// --- Read confirmation audit family (C1) -------------------------------------

/**
 * Every audit key the read-confirmation feature emits, as literals so a grep
 * for a key finds it here and at its call sites. New keys are namespaced
 * under "ack." (auditCategories groups them); the three document.* keys stay
 * for compatibility with logs written before 1.10.0. Each has a label in
 * lib/audit-labels (test/ack-ledger.test.ts checks).
 */
export const ACK_AUDIT_ACTIONS = [
  "document.acknowledge",
  "document.ack_required",
  "document.ack_removed",
  "ack.requested",
  "ack.reminder_sent",
  "ack.reconfirmation_requested",
  "ack.confirmations_kept",
  "ack.confirmations_reset",
  "ack.reset_notified",
  "ack.notice_failed",
  "ack.edit_default_set",
  "ack.settings_changed",
  "ack.export",
  "ack.retired",
  "ack.unretired",
  "ack.exempted",
  "ack.exemption_revoked",
  "ack.due_extended",
  "ack.snoozed",
  "ack.escalated",
  "ack.recert",
  "ack.snapshot",
  "ack.audit_export",
  "ack.retention_purge",
  "ack.anonymised",
] as const;
export type AckAuditAction = (typeof ACK_AUDIT_ACTIONS)[number];

/**
 * The details every ack-family entry carries: {doc_id, version_id, version,
 * content_sha256, source, reason}, plus whatever counts the action has
 * (`details`). Missing contract keys are written as null / "" so an export
 * always has the same columns.
 */
export interface AckAuditExtra {
  actor?: AuditActor | null;
  ip?: string | null;
  version_id?: number | null;
  /** The Version-history number ("v12" is 12). */
  version?: number | null;
  content_sha256?: string | null;
  source?: string | null;
  reason?: string | null;
  /** Counts and action-specific keys (acked, required, pending, user_agent, ...). */
  details?: Record<string, unknown>;
}

/** Record an ack-family audit entry against a document. Never throws (see audit). */
export async function auditAck(
  action: AckAuditAction,
  doc: { id: number; title: string },
  extra: AckAuditExtra = {}
): Promise<void> {
  await audit({
    actor: extra.actor,
    action,
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    details: {
      doc_id: doc.id,
      version_id: extra.version_id ?? null,
      version: extra.version ?? null,
      content_sha256: extra.content_sha256 ?? null,
      source: extra.source ?? null,
      reason: extra.reason ?? "",
      ...(extra.details ?? {}),
    },
    ip: extra.ip,
  });
}

/**
 * Echo the confirmation decision a save just took into the audit log (C1):
 * the ledger row is the record, the audit entry is its echo with the same
 * version, counts and reason. A decision is taken only when the text of a
 * confirmed, published document changed (updateDocument's `decides`), so
 * anything else, including a silent marker advance with the requirement off,
 * writes nothing. Every route that calls updateDocument (PUT, merge, restore,
 * the v1 API, the MCP connector) uses this one helper so the echo cannot
 * drift between them.
 */
export async function auditAckDecision(
  before: { ack_required: number },
  doc:
    | { id: number; title: string; content: string; status: string; ack_outcome?: AckOutcomeInfo }
    | undefined,
  extra: Pick<AckAuditExtra, "actor" | "ip"> = {}
): Promise<void> {
  const outcome = doc?.ack_outcome;
  if (!doc || !outcome?.substantive || before.ack_required !== 1 || doc.status !== "published") return;
  const decision = await lastAckDecision(doc.id);
  if (!decision) return;
  await auditAck(outcome.reset ? "ack.confirmations_reset" : "ack.confirmations_kept", doc, {
    actor: extra.actor,
    ip: extra.ip,
    version_id: decision.version_id,
    version: decision.rev,
    content_sha256: createHash("sha256").update(doc.content).digest("hex"),
    source: decision.source,
    reason: decision.reason,
    details: {
      confirmations_affected: decision.confirmations_affected,
      eligible: decision.eligible,
      suggested: decision.suggested,
      overrode_suggestion: decision.overrode_suggestion,
      change_pct: decision.change_pct,
    },
  });
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  actorId?: number;
  action?: string; // exact match, or a "prefix." wildcard like "user."
  category?: string; // the part before the first dot (e.g. "document")
  from?: string; // ISO timestamp — include entries at/after this instant
  to?: string; // ISO timestamp — include entries before this instant
}

/** Shared WHERE-clause builder for list + export so filters can't drift. */
function auditWhere(opts: AuditQuery): { clause: string; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.actorId != null) {
    params.push(opts.actorId);
    where.push(`actor_id = $${params.length}`);
  }
  if (opts.action) {
    params.push(opts.action);
    where.push(`action = $${params.length}`);
  }
  if (opts.category) {
    params.push(`${opts.category}.%`);
    where.push(`action LIKE $${params.length}`);
  }
  if (opts.from) {
    params.push(opts.from);
    where.push(`at >= $${params.length}::timestamptz`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`at < $${params.length}::timestamptz`);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/** List audit entries, newest first, with optional filters + total count. */
export async function listAuditLog(
  opts: AuditQuery = {}
): Promise<{ rows: AuditRow[]; total: number }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const { clause, params } = auditWhere(opts);

  const totalRes = await pool().query<{ n: string }>(
    `SELECT COUNT(*)::bigint AS n FROM audit_log ${clause}`,
    params
  );
  const total = Number(totalRes.rows[0]?.n ?? 0);

  params.push(limit, offset);
  const rowsRes = await pool().query<AuditRow>(
    `SELECT id::text, at, actor_id, actor_name, actor_role, action, target_type, target_id, target_label, details, ip
     FROM audit_log ${clause}
     ORDER BY at DESC, audit_log.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: rowsRes.rows, total };
}

/**
 * Iterate matching audit entries newest-first in fixed-size batches (keyset
 * pagination on the identity PK, so memory stays bounded no matter how large
 * the log is). Powers the enterprise export streamer.
 */
export async function* iterAuditLog(
  opts: Omit<AuditQuery, "limit" | "offset"> = {},
  batchSize = 1000
): AsyncGenerator<AuditRow[]> {
  const { clause, params } = auditWhere(opts);
  let cursor: string | null = null;
  for (;;) {
    const batchParams = [...params];
    let cursorCond = "";
    if (cursor !== null) {
      batchParams.push(cursor);
      cursorCond = `${clause ? "AND" : "WHERE"} id < $${batchParams.length}`;
    }
    batchParams.push(batchSize);
    const res = await pool().query<AuditRow>(
      // NB: order by the table column, not the `id::text` output alias —
      // ORDER BY prefers the alias, which would sort lexicographically.
      `SELECT id::text, at, actor_id, actor_name, actor_role, action, target_type, target_id, target_label, details, ip
       FROM audit_log ${clause} ${cursorCond}
       ORDER BY audit_log.id DESC
       LIMIT $${batchParams.length}`,
      batchParams
    );
    if (res.rows.length === 0) return;
    yield res.rows;
    if (res.rows.length < batchSize) return;
    cursor = res.rows[res.rows.length - 1].id;
  }
}

/** Distinct action categories present in the log (for the filter dropdown). */
export async function auditCategories(): Promise<string[]> {
  const res = await pool().query<{ c: string }>(
    `SELECT DISTINCT split_part(action, '.', 1) AS c FROM audit_log ORDER BY c`
  );
  return res.rows.map((r) => r.c).filter(Boolean);
}
