// node:test runs test files in parallel processes, and every process boots
// the schema (SCHEMA_SQL's idempotent ALTERs) on its first query. A fixture
// that inserts users while another process is mid-boot can be chosen as the
// deadlock victim (Postgres 40P01: the users ladder trigger writes
// role_assignments, which the boot is altering). The statement is safe to
// repeat, so repeat it.
//
// The files also tear their fixtures down while the others run. A statement
// over every account that can see an internal space (a switch-on, a
// space-mode save, a reconcile, the audience hook of a new or re-enabled
// account) can then meet an account or a document another file deleted
// after the statement's snapshot (23503: the row's foreign key), or deadlock
// with that deletion's cascade (40P01). Each such statement is safe to
// repeat too.

import { pool } from "../../src/lib/db";

/** The error another file's teardown can cause mid-statement: a deleted account's or document's foreign key, or the deadlock with its cascade. */
export function isTeardownRace(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "23503" || code === "40P01";
}

async function retryWhen<T>(again: (e: unknown) => boolean, fn: () => Promise<T>, attempts: number): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!again(e) || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 350 * (i + 1)));
    }
  }
}

export function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  return retryWhen((e) => (e as { code?: string } | null)?.code === "40P01", fn, attempts);
}

/** The deadlock retry and the teardown race (isTeardownRace), for a statement over every account of an internal space. */
export function retryOnTeardownRace<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  return retryWhen(isTeardownRace, fn, attempts);
}

/** pool().query with the deadlock retry, for fixture inserts. */
export function fixtureQuery(sql: string, params: unknown[] = []) {
  return retryOnDeadlock(() => pool().query(sql, params));
}
