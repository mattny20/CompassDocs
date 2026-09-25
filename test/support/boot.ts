// Boots the schema and migration chain once against DATABASE_URL and exits:
// 0 when initialize() resolved, 1 with the error on stderr otherwise.
//
// Spawned by directory-migration.test.ts. The init promise is cached per
// process, so a second boot needs a second process — and that test wants to
// boot against a database it shaped by hand, not the one the other test files
// share.
import { getSetting, pool } from "../../src/lib/db";

(async () => {
  try {
    await getSetting("__schema_bootstrap__");
    await pool().end();
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();
