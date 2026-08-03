// The directory removal brake, against a real PostgreSQL.
//
// This is the regression test 0.98.1 shipped without. The brake is the guard
// between a broken sync and an emptied directory, and its behaviour is entirely
// a property of one SQL transaction — how many rows a provider owns, how many
// just disappeared, and whether an operator has said to go ahead. None of that
// is observable from the HTTP surface (there is no endpoint that seeds a
// provider's people), so this drives replaceProviderPeople directly against the
// same database the e2e suite uses.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, getSetting } from "../src/lib/db";
import { replaceProviderPeople, type ProviderPersonInput } from "../src/lib/directory";

const SOURCE = "google" as const;
const PREFIX = "brake-test-";

/** Ten people the brake can count. */
const people = (n: number): ProviderPersonInput[] =>
  Array.from({ length: n }, (_, i) => ({
    external_id: `${PREFIX}${i}`,
    name: `Brake Person ${i}`,
  }));

async function ownedCount(): Promise<number> {
  const { rows } = await pool().query<{ c: string }>(
    "SELECT count(*)::text AS c FROM directory_people WHERE source = $1",
    [SOURCE]
  );
  return Number(rows[0].c);
}

async function clean() {
  await pool().query("DELETE FROM directory_people WHERE source = $1 AND external_id LIKE $2", [
    SOURCE,
    `${PREFIX}%`,
  ]);
}

describe("directory removal brake", () => {
  before(async () => {
    // Any query through q() awaits the boot-time initializer, which is what
    // creates the schema. On CI this is a database nobody has touched yet, so
    // without it the first insert would fail on a missing table rather than
    // tell us anything about the brake.
    await getSetting("__schema_bootstrap__");
    await clean();
    // The brake measures a fraction of everything this provider owns, so a
    // stray row from another test would move the denominator and quietly
    // change what these assertions mean. Refuse rather than measure noise.
    assert.equal(
      await ownedCount(),
      0,
      "expected no pre-existing google-sourced people; another test left state behind"
    );
  });

  after(async () => {
    await clean();
    await pool().end();
  });

  test("a sync within the threshold removes who disappeared", async () => {
    await replaceProviderPeople(SOURCE, people(10));
    assert.equal(await ownedCount(), 10);

    // 2 of 10 gone — a fifth, well under the half the brake allows.
    const r = await replaceProviderPeople(SOURCE, people(8));
    assert.equal(r.deleted, 2);
    assert.equal(r.blocked, undefined);
    assert.equal(await ownedCount(), 8);
  });

  test("a sync that would remove more than half is held, and the updates still commit", async () => {
    await replaceProviderPeople(SOURCE, people(10));

    const r = await replaceProviderPeople(SOURCE, people(4));
    assert.equal(r.deleted, 0, "nothing may be deleted once the brake trips");
    assert.equal(r.upserted, 4, "the people that did arrive are still written");
    assert.deepEqual(
      { doomed: r.blocked?.doomed, total: r.blocked?.total },
      { doomed: 6, total: 10 },
      "the report names what was held back"
    );
    assert.match(String(r.blocked?.message), /sync again with removals allowed/);
    assert.equal(await ownedCount(), 10, "the directory is untouched in size");
  });

  test("re-running the same sync does not clear the brake", async () => {
    // The 0.98.1 bug in one assertion. The brake compares each sync against
    // what is currently stored, so a genuinely smaller directory trips it again
    // and again — no amount of retrying converges. If this ever starts
    // passing with `blocked === undefined`, the escape hatch below is dead
    // weight and the panel should stop offering it.
    await replaceProviderPeople(SOURCE, people(10));
    await replaceProviderPeople(SOURCE, people(4));

    const again = await replaceProviderPeople(SOURCE, people(4));
    assert.deepEqual(
      { doomed: again.blocked?.doomed, total: again.blocked?.total },
      { doomed: 6, total: 10 },
      "an identical retry trips the brake identically"
    );
    assert.equal(await ownedCount(), 10);
  });

  test("an operator can allow the removals once", async () => {
    await replaceProviderPeople(SOURCE, people(10));
    await replaceProviderPeople(SOURCE, people(4));
    assert.equal(await ownedCount(), 10, "precondition: the brake is holding");

    const r = await replaceProviderPeople(SOURCE, people(4), { allowRemovals: true });
    assert.equal(r.deleted, 6);
    assert.equal(r.blocked, undefined);
    assert.equal(await ownedCount(), 4);
  });

  test("allowing removals applies to that run only", async () => {
    await replaceProviderPeople(SOURCE, people(10), { allowRemovals: true });
    assert.equal(await ownedCount(), 10);

    const r = await replaceProviderPeople(SOURCE, people(4));
    assert.equal(r.deleted, 0, "the next sync is braked again");
    assert.equal(r.blocked?.doomed, 6);
  });

  test("an empty result is the case the brake exists for", async () => {
    // A credential that stopped working, or a group filter pointing at a
    // renamed group, arrives here as zero people. Without the brake that reads
    // as "everyone left the company".
    await replaceProviderPeople(SOURCE, people(10));

    const r = await replaceProviderPeople(SOURCE, []);
    assert.equal(r.deleted, 0);
    assert.equal(r.blocked?.doomed, 10);
    assert.equal(await ownedCount(), 10, "nobody is deleted on an empty sync");
  });

  test("the brake is scoped to one provider", async () => {
    // Microsoft and Google can both be connected; a Google sync collapsing to
    // nothing must not count, or delete, the people Microsoft owns.
    await replaceProviderPeople(SOURCE, people(10));
    const graphBefore = await pool().query<{ c: string }>(
      "SELECT count(*)::text AS c FROM directory_people WHERE source = 'graph'"
    );

    await replaceProviderPeople(SOURCE, []);
    const graphAfter = await pool().query<{ c: string }>(
      "SELECT count(*)::text AS c FROM directory_people WHERE source = 'graph'"
    );
    assert.equal(graphAfter.rows[0].c, graphBefore.rows[0].c);
  });
});
