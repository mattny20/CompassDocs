// node:test runs test files in parallel processes, and every process boots
// the schema (SCHEMA_SQL's idempotent ALTERs) on its first query. A fixture
// that inserts users while another process is mid-boot can be chosen as the
// deadlock victim (Postgres 40P01: the users ladder trigger writes
// role_assignments, which the boot is altering). The statement is safe to
// repeat, so repeat it.

import { pool } from "../../src/lib/db";

export async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== "40P01" || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 350 * (i + 1)));
    }
  }
}

/** pool().query with the deadlock retry, for fixture inserts. */
export function fixtureQuery(sql: string, params: unknown[] = []) {
  return retryOnDeadlock(() => pool().query(sql, params));
}
