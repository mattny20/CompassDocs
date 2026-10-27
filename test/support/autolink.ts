// Runs the account ↔ directory auto-link (autoLinkUsersToDirectory) once
// against DATABASE_URL and exits: 0 with the number of links made as one
// JSON line on stdout, 1 with the error on stderr.
//
// Spawned by account-email.test.ts, beside boot.ts: the link is one UPDATE
// over every account, so that test runs it against a database it shaped by
// hand, not the one the other test files and the dev server share.
import { autoLinkUsersToDirectory, getSetting, pool } from "../../src/lib/db";

(async () => {
  try {
    await getSetting("__schema_bootstrap__");
    console.log(JSON.stringify(await autoLinkUsersToDirectory()));
    await pool().end();
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();
