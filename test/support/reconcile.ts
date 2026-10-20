// Runs the hourly audience safety net (reconcileAllPolicies) once against
// DATABASE_URL and exits: 0 with the result as one JSON line on stdout, 1
// with the error on stderr.
//
// Spawned by ack-boot.test.ts, beside boot.ts: lib/db's pool binds to
// DATABASE_URL once per process, and that test wants the sweep run against
// a database it shaped by hand (a 1.12.0 binary's leftovers between two
// boots), not the one the other test files share.
import { getSetting, pool, reconcileAllPolicies } from "../../src/lib/db";

(async () => {
  try {
    await getSetting("__schema_bootstrap__");
    const r = await reconcileAllPolicies();
    console.log(JSON.stringify(r));
    await pool().end();
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();
