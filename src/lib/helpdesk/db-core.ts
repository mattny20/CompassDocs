// Helpdesk 1.19.0: the shared SQL plumbing for lib/helpdesk/* (schema:
// "Helpdesk 1.19.0" in lib/db.ts SCHEMA_SQL). Every helpdesk module runs its
// queries through hq() / hqOne() / withTx() so the schema is ready first and
// timestamps come back as ISO strings (the shape lib/helpdesk/types
// declares). Server-only.
//
// The pool has five connections: withTx() holds one for the transaction
// only. Never send mail or call out to the network inside it; queue the
// side effects and run them after it returns.

import "server-only";
import type { PoolClient } from "pg";
import { dbReady, pool } from "../db";

export type HdQueryable = Pick<PoolClient, "query">;

/** Dates → ISO strings, bigint strings of known columns → numbers, recursively for one row. */
export function normalizeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (k === "sla_paused_ms" && typeof v === "string") out[k] = Number(v);
    else out[k] = v;
  }
  return out as T;
}

/** A query on the pool (or the given client), rows normalised. */
export async function hq<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  client?: HdQueryable
): Promise<T[]> {
  if (!client) await dbReady();
  const res = await (client ?? pool()).query(sql, params as unknown[]);
  return res.rows.map((r) => normalizeRow<T>(r));
}

export async function hqOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  client?: HdQueryable
): Promise<T | undefined> {
  return (await hq<T>(sql, params, client))[0];
}

/**
 * Run `fn` in one transaction on one pooled client (BEGIN … COMMIT, ROLLBACK
 * on a throw). Returns what `fn` returns. Keep it short: no network calls.
 */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await dbReady();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
