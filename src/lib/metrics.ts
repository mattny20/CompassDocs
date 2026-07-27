// In-process Prometheus metrics. Counters live on globalThis so they survive
// dev HMR and are shared across route modules; gauges are computed at scrape
// time (process stats, pg pool state, and a handful of cheap business counts).
// Exposed at /metrics — see src/app/metrics/route.ts for access control.

import "server-only";
import { pool } from "./db";
import pkg from "../../package.json";

type CounterKey =
  | "login_success"
  | "login_failure"
  | "search_requests"
  | "ai_requests"
  | "audit_exports";

interface MetricsState {
  counters: Record<CounterKey, number>;
  startedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __compassMetrics: MetricsState | undefined;
}

function state(): MetricsState {
  if (!global.__compassMetrics) {
    global.__compassMetrics = {
      counters: {
        login_success: 0,
        login_failure: 0,
        search_requests: 0,
        ai_requests: 0,
        audit_exports: 0,
      },
      startedAt: Date.now(),
    };
  }
  return global.__compassMetrics;
}

/** Increment a named counter. Never throws. */
export function metric(name: CounterKey): void {
  try {
    state().counters[name] += 1;
  } catch {
    /* metrics must never break the request */
  }
}

function line(name: string, value: number | string, help?: string, type = "gauge"): string {
  let out = "";
  if (help) out += `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`;
  return out + `${name} ${value}\n`;
}

/** Render the full exposition-format payload. */
export async function renderMetrics(): Promise<string> {
  const s = state();
  const mem = process.memoryUsage();
  const p = pool() as unknown as { totalCount: number; idleCount: number; waitingCount: number };

  let out = "";
  out += line(
    "compassdocs_info",
    `1`,
    `Build info as labels.`
  ).replace("compassdocs_info 1", `compassdocs_info{version="${(pkg as { version?: string }).version || "0.0.0"}",node="${process.version}"} 1`);
  out += line("compassdocs_process_uptime_seconds", Math.round(process.uptime()), "Process uptime.");
  out += line("compassdocs_process_rss_bytes", mem.rss, "Resident set size.");
  out += line("compassdocs_process_heap_used_bytes", mem.heapUsed, "V8 heap in use.");

  out += line("compassdocs_db_pool_total", p.totalCount ?? 0, "Open connections in the pg pool.");
  out += line("compassdocs_db_pool_idle", p.idleCount ?? 0, "Idle connections in the pg pool.");
  out += line("compassdocs_db_pool_waiting", p.waitingCount ?? 0, "Requests waiting for a connection.");

  for (const [k, v] of Object.entries(s.counters)) {
    out += line(
      `compassdocs_${k}_total`,
      v,
      `Count of ${k.replace(/_/g, " ")} since process start.`,
      "counter"
    );
  }

  // Cheap business gauges in one round-trip.
  try {
    const res = await pool().query<{
      users: string;
      active_users: string;
      documents: string;
      spaces: string;
      sessions: string;
      audit_events: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM users WHERE status = 'active') AS active_users,
         (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL) AS documents,
         (SELECT COUNT(*) FROM spaces) AS spaces,
         (SELECT COUNT(*) FROM sessions WHERE expires_at > now()) AS sessions,
         (SELECT COUNT(*) FROM audit_log) AS audit_events`
    );
    const r = res.rows[0];
    out += line("compassdocs_users_total", Number(r.users), "User accounts.");
    out += line("compassdocs_users_active", Number(r.active_users), "Active (enabled) user accounts.");
    out += line("compassdocs_documents_total", Number(r.documents), "Documents (excluding trashed).");
    out += line("compassdocs_spaces_total", Number(r.spaces), "Spaces.");
    out += line("compassdocs_sessions_active", Number(r.sessions), "Unexpired sessions.");
    out += line("compassdocs_audit_events_total", Number(r.audit_events), "Rows in the audit log.");
    out += line("compassdocs_db_up", 1, "1 when the database answered the scrape query.");
  } catch {
    out += line("compassdocs_db_up", 0, "1 when the database answered the scrape query.");
  }

  return out;
}
