// Append-only audit log of security- and content-significant actions. Writes
// are best-effort: recording an audit entry must never break the action it
// describes, so failures are swallowed (and logged to the server console).
//
// Server-only: uses the Postgres pool.

import { pool } from "./db";
import type { SessionUser } from "./types";

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
    console.error("[audit] failed to record", entry.action, e);
  }
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  actorId?: number;
  action?: string; // exact match, or a "prefix." wildcard like "user."
  category?: string; // the part before the first dot (e.g. "document")
}

/** List audit entries, newest first, with optional filters + total count. */
export async function listAuditLog(
  opts: AuditQuery = {}
): Promise<{ rows: AuditRow[]; total: number }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
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
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await pool().query<{ n: string }>(
    `SELECT COUNT(*)::bigint AS n FROM audit_log ${clause}`,
    params
  );
  const total = Number(totalRes.rows[0]?.n ?? 0);

  params.push(limit, offset);
  const rowsRes = await pool().query<AuditRow>(
    `SELECT id::text, at, actor_id, actor_name, actor_role, action, target_type, target_id, target_label, details, ip
     FROM audit_log ${clause}
     ORDER BY at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: rowsRes.rows, total };
}

/** Distinct action categories present in the log (for the filter dropdown). */
export async function auditCategories(): Promise<string[]> {
  const res = await pool().query<{ c: string }>(
    `SELECT DISTINCT split_part(action, '.', 1) AS c FROM audit_log ORDER BY c`
  );
  return res.rows.map((r) => r.c).filter(Boolean);
}
