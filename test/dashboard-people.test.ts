// The people half of the 1.17.0 dashboard (lib/dashboard-people): My team
// from the directory's "Reports to" links (manager, the people who share
// that manager, direct reports; hidden people and an admin-only "Reports
// to" leave nothing), People this week (new starters within a week either
// side, anniversaries and birthdays Monday to Sunday, an admin-only date
// field read for admins only), My training (open assignments, overdue
// first, "N of M"), and Team compliance (a manager's direct reports with
// accounts, a policy in a space the manager cannot read never named, and
// the leads-see-policies setting honoured).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/dashboard-people.test.ts

// lib/ee as a licensed build sees it, installed before the module loads.
import { edition } from "./support/ee-stub";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  pool,
  getSetting,
  setSetting,
  createDocument,
  createGroup,
  addGroupMember,
  setSpaceGroups,
  listVersions,
  recordAcknowledgement,
  reportPolicyStanding,
} from "../src/lib/db";
import { createField, listFields } from "../src/lib/directory";
import { viewerScope } from "../src/lib/directory-viewer";
import { managerField } from "../src/lib/directory-org";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";
import {
  dayIn,
  weekOf,
  ymdText,
  peopleThisWeek,
  PEOPLE_THIS_WEEK_MAX,
  getMyTeam,
  getPeopleThisWeek,
  getMyOpenTraining,
  directReportAccounts,
  getTeamCompliance,
} from "../src/lib/dashboard-people";
import type { FieldLike } from "../src/lib/directory-display";
import type { SessionUser } from "../src/lib/types";

const STAMP = `dashppl-${Date.now()}`;
const KEY = `d${Date.now().toString(36)}`;
const SETTINGS_LOCK = 728342; // shared with the other ack_defaults files

// --- Pure rules ---------------------------------------------------------------

const dateField = (key: string, date_role: string): FieldLike =>
  ({ key, label: key, kind: "date", date_role, multi: 0, builtin: 0, group_by: 0, options: [], value_format: "raw", display: "field", show_with: "", highlight: 0, inverse_label: "", show_in_card: 0 }) as FieldLike;
const P = (id: number, name: string, custom: Record<string, string>) => ({ id, name, custom });

describe("people this week (pure)", () => {
  const fields = [dateField("start", "start"), dateField("bday", "birthday"), dateField("other", "")];
  // Thursday 5 November 2026: the week is Mon 2 – Sun 8 November.
  const today = { y: 2026, m: 11, d: 5 };

  test("weekOf is Monday to Sunday; dayIn reads the calendar day in a zone", () => {
    assert.deepEqual(weekOf(today).map(ymdText), ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    assert.deepEqual(weekOf({ y: 2026, m: 11, d: 2 }).map(ymdText)[0], "2026-11-02", "a Monday starts its own week");
    assert.deepEqual(weekOf({ y: 2026, m: 11, d: 8 }).map(ymdText)[0], "2026-11-02", "a Sunday ends it");
    const late = new Date("2026-11-05T23:30:00Z");
    assert.deepEqual(dayIn(late, "UTC"), { y: 2026, m: 11, d: 5 });
    assert.deepEqual(dayIn(late, "Asia/Tokyo"), { y: 2026, m: 11, d: 6 });
    assert.deepEqual(dayIn(late, "Not/AZone"), { y: 2026, m: 11, d: 5 }, "an unusable zone reads as UTC");
  });

  test("starters within a week either side, anniversaries and birthdays this week, ordered by day", () => {
    const people = [
      P(1, "Lena Fischer", { start: "2026-11-02" }), // started Monday
      P(2, "Tom Becker", { start: "11/4/2021" }), // 5 years on Wednesday
      P(3, "Aisha Rahman", { bday: "11-06" }), // birthday Friday (year-less)
      P(4, "Fred Future", { start: "2026-11-10" }), // starts next Tuesday: within 7 days
      P(5, "Olga Old", { start: "2020-01-15", bday: "1990-12-25" }), // nothing this week
      P(6, "Pat Past", { start: "2026-10-28" }), // 8 days ago: not new any more
      P(7, "Una Undated", { other: "2026-11-05" }), // a date with no role
      P(8, "Al Anniv", { start: "2025-11-08" }), // 1 year on Sunday
    ];
    const got = peopleThisWeek(people, fields, today);
    assert.deepEqual(
      got.map((e) => [e.person.name, e.kind, e.date, e.years]),
      [
        ["Lena Fischer", "started", "2026-11-02", 0],
        ["Tom Becker", "anniversary", "2026-11-04", 5],
        ["Aisha Rahman", "birthday", "2026-11-06", 0],
        ["Al Anniv", "anniversary", "2026-11-08", 1],
        ["Fred Future", "starting", "2026-11-10", 0],
      ]
    );
  });

  test("the five nearest today are kept; a 29 February recurs on the 28th; the week may straddle a year", () => {
    const many = Array.from({ length: 8 }, (_, i) => P(10 + i, `P${i}`, { bday: `11-0${2 + (i % 7)}` }));
    const kept = peopleThisWeek(many, fields, today);
    assert.equal(PEOPLE_THIS_WEEK_MAX, 5);
    assert.equal(kept.length, PEOPLE_THIS_WEEK_MAX);
    assert.equal(peopleThisWeek(many, fields, today, 100).length, 8, "the cap is the only thing that drops them");
    assert.ok(kept.every((e) => Math.abs(Number(e.date.slice(-2)) - 5) <= 2), "the nearest days win");
    assert.deepEqual(kept.map((e) => e.date), [...kept.map((e) => e.date)].sort(), "then shown in day order");

    const leap = peopleThisWeek([P(30, "Leap", { bday: "2000-02-29" })], fields, { y: 2027, m: 2, d: 26 });
    assert.deepEqual(leap.map((e) => e.date), ["2027-02-28"]);

    const newYear = peopleThisWeek([P(31, "Jan", { start: "2020-01-01" })], fields, { y: 2026, m: 12, d: 30 });
    assert.deepEqual(newYear.map((e) => [e.date, e.years]), [["2027-01-01", 7]]);

    assert.deepEqual(peopleThisWeek(many, [dateField("other", "")], today), [], "no dated roles, nothing");
  });
});

// --- Against the database -----------------------------------------------------

let lockClient: PoolClient | null = null;
let savedDefaults: string | undefined;
const userIds: number[] = [];
const personIds: number[] = [];
const docIds: number[] = [];
const fieldIds: number[] = [];
let spaceId = 0;
let privateSpaceId = 0;
const groupIds: number[] = [];

const ids = {
  boss: 0, mia: 0, peer: 0, r1: 0, r2: 0, r3: 0, hiddenReport: 0, loner: 0,
  uMia: 0, uR1: 0, uR2: 0, uLoner: 0, uAdmin: 0, uPeer: 0,
};

async function person(name: string, extra: { department?: string; hidden?: number; custom?: Record<string, string> } = {}): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO directory_people (name, title, department, hidden, custom) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`${STAMP} ${name}`, `${name} title`, extra.department ?? "", extra.hidden ?? 0, JSON.stringify(extra.custom ?? {})]
  );
  personIds.push(r.rows[0].id);
  return r.rows[0].id;
}
async function reportsTo(personId: number, managerId: number) {
  await fixtureQuery(
    `INSERT INTO directory_person_links (person_id, field_key, target_id, source) VALUES ($1, 'manager', $2, 'manual')`,
    [personId, managerId]
  );
}
async function account(suffix: string, name: string, personId: number | null, role = "viewer"): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, directory_person_id) VALUES ($1, $2, $3, $4, 'active', $5) RETURNING id`,
    [`${STAMP}-${suffix}`, name, `${STAMP}-${suffix}@example.test`, role, personId]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}
const session = (id: number, role: "viewer" | "admin" = "viewer"): SessionUser =>
  ({ id, username: `u${id}`, name: `User ${id}`, email: "", role, must_change_password: false, timezone: "", date_format: "auto" }) as SessionUser;

/**
 * Run `fn` with the rows of the queries whose SQL matches `match` passed
 * through `rewrite` — in this process only, the database untouched. The
 * shared database's other people and fields stay out of an assertion
 * without changing what anyone else reads. `hits` says the query was met.
 */
async function withRowsRewritten<T>(
  match: RegExp,
  rewrite: (rows: any[]) => any[],
  fn: () => Promise<T>
): Promise<{ result: T; hits: number }> {
  const p = pool() as unknown as { query: (...args: unknown[]) => Promise<{ rows: any[] }> };
  const original = p.query;
  let hits = 0;
  p.query = async (...args: unknown[]) => {
    const res = await original.apply(p, args);
    const text = typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string } | null)?.text ?? "");
    if (match.test(text)) {
      hits++;
      res.rows = rewrite(res.rows);
    }
    return res;
  };
  try {
    return { result: await fn(), hits };
  } finally {
    p.query = original;
  }
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  edition.features = ["policy_ack", "training"];
  const client = await pool().connect();
  await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
  lockClient = client;
  savedDefaults = await getSetting("ack_defaults");
  const stored = JSON.parse(savedDefaults || "{}");
  await setSetting("ack_defaults", JSON.stringify({ ...stored, leads_see_policies: true }));

  // The directory: Boss ← Mia, Peer; Mia ← R1, R2, R3 (no account), a hidden report.
  ids.boss = await person("Boss");
  ids.mia = await person("Mia");
  ids.peer = await person("Peer");
  ids.r1 = await person("Rae One");
  ids.r2 = await person("Rob Two");
  ids.r3 = await person("Ria Three");
  ids.hiddenReport = await person("Hidden", { hidden: 1 });
  ids.loner = await person("Loner");
  await reportsTo(ids.mia, ids.boss);
  await reportsTo(ids.peer, ids.boss);
  for (const r of [ids.r1, ids.r2, ids.r3, ids.hiddenReport]) await reportsTo(r, ids.mia);

  ids.uMia = await account("mia", "Mia Manager", ids.mia);
  ids.uR1 = await account("r1", "Rae One", ids.r1);
  ids.uR2 = await account("r2", "Rob Two", ids.r2);
  ids.uLoner = await account("loner", "Lone Wolf", ids.loner);
  ids.uPeer = await account("peer", "Peer Person", ids.peer);
  ids.uAdmin = await account("admin", "Ada Admin", null, "admin");

  // A private space Mia, R1 and R2 can read; another only R1 and R2 can.
  const s1 = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id`,
    [`Team ${STAMP}`, `${STAMP}-team`]
  );
  spaceId = s1.rows[0].id;
  const s2 = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '🔒', '', 'private') RETURNING id`,
    [`Private ${STAMP}`, `${STAMP}-priv`]
  );
  privateSpaceId = s2.rows[0].id;
  const g1 = (await createGroup({ name: `${STAMP} team` })).id;
  const g2 = (await createGroup({ name: `${STAMP} reports` })).id;
  groupIds.push(g1, g2);
  for (const u of [ids.uMia, ids.uR1, ids.uR2]) await addGroupMember(g1, u);
  for (const u of [ids.uR1, ids.uR2]) await addGroupMember(g2, u);
  await setSpaceGroups(spaceId, [g1]);
  await setSpaceGroups(privateSpaceId, [g2]);
});

after(async () => {
  edition.features = ["policy_ack"];
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM groups WHERE id = ANY($1)", [groupIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [[spaceId, privateSpaceId]]);
  await pool().query("DELETE FROM directory_people WHERE id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM directory_fields WHERE id = ANY($1)", [fieldIds]);
  if (savedDefaults === undefined) await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");
  else await setSetting("ack_defaults", savedDefaults);
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
    lockClient.release();
  }
});

describe("My team", () => {
  test("the manager, the people who share them, the direct reports; hidden people never", async () => {
    const t = await getMyTeam(session(ids.uMia));
    assert.ok(t);
    assert.equal(t.me, ids.mia);
    assert.equal(t.manager?.id, ids.boss);
    assert.deepEqual(t.team.map((p) => p.id), [ids.peer]);
    assert.deepEqual(t.reports.map((p) => p.id), [ids.r1, ids.r3, ids.r2], "by name: Rae, Ria, Rob");
    assert.ok(!t.reports.some((p) => p.id === ids.hiddenReport));
    assert.equal(t.presence, false, "manual people carry no presence");
    assert.equal(t.manager?.photo, "", "no photo, initials");

    const r1 = await getMyTeam(session(ids.uR1));
    assert.equal(r1?.manager?.id, ids.mia);
    assert.deepEqual(r1?.team.map((p) => p.id).sort(), [ids.r2, ids.r3].sort(), "teammates, not the hidden one, not oneself");
    assert.deepEqual(r1?.reports, []);
  });

  test("null for an unlinked account, a person with nobody around them, and an admin-only Reports to", async () => {
    assert.equal(await getMyTeam(session(ids.uAdmin, "admin")), null);
    assert.equal(await getMyTeam(session(ids.uLoner)), null);

    // "Reports to" made admin-only in memory: the shared built-in field is
    // never changed, so other files reading it meanwhile are not affected.
    const fields = await listFields();
    assert.ok(managerField(fields), "the built-in Reports to field");
    const adminsOnly = fields.map((f) => (f.key === "manager" ? { ...f, visibility: "admins" as const } : f));
    assert.ok(managerField((await viewerScope(session(ids.uMia), fields)).fields), "visible as stored");
    assert.equal(managerField((await viewerScope(session(ids.uMia), adminsOnly)).fields), undefined, "admin-only: not a viewer's");
    assert.ok(managerField((await viewerScope(session(ids.uAdmin, "admin"), adminsOnly)).fields), "an admin's still");

    // The readers themselves, with the field list they load read as admin-only.
    const FIELD_READ = /FROM directory_fields ORDER BY sort, id/;
    const asAdminsOnly = (rows: { key: string }[]) => rows.map((r) => (r.key === "manager" ? { ...r, visibility: "admins" } : r));
    const team = await withRowsRewritten(FIELD_READ, asAdminsOnly, () => getMyTeam(session(ids.uMia)));
    assert.ok(team.hits > 0, "the field list was read");
    assert.equal(team.result, null, "a viewer may not see Reports to");
    const reports = await withRowsRewritten(FIELD_READ, asAdminsOnly, () => directReportAccounts(session(ids.uMia)));
    assert.ok(reports.hits > 0);
    assert.deepEqual(reports.result, [], "nor build a team on it");
    assert.ok(await getMyTeam(session(ids.uMia)), "and as stored, Mia's team is there");
  });
});

describe("People this week", () => {
  // Thursday 5 November 2026.
  const now = new Date("2026-11-05T12:00:00Z");
  let start: { key: string };
  let bday: { key: string };
  before(async () => {
    const s = await createField({ key: `${KEY}_start`, label: `${STAMP} Start`, kind: "date", date_role: "start" });
    const b = await createField({ key: `${KEY}_bday`, label: `${STAMP} Birthday`, kind: "date", date_role: "birthday", visibility: "admins" });
    fieldIds.push(s.id, b.id);
    start = s;
    bday = b;
  });

  // The tile keeps the five nearest today across the whole directory, and
  // the shared database has other people with dates this week: the people
  // read is narrowed to this test's own, so the five are chosen from them.
  // Hidden people and the dated keys are still the real query's to filter.
  const PEOPLE_READ = /jsonb_each_text\(p\.synced \|\| p\.custom\)/;
  const weekFor = async (u: SessionUser, mine: Set<number>) => {
    const r = await withRowsRewritten(PEOPLE_READ, (rows: { id: number }[]) => rows.filter((x) => mine.has(x.id)), () =>
      getPeopleThisWeek(u, "UTC", now)
    );
    assert.equal(r.hits, 1, "the people read was met");
    return r.result;
  };
  const people = () => {
    const mine = new Set<number>();
    const add = async (name: string, custom: Record<string, string>, extra: { hidden?: number; department?: string } = {}) => {
      const id = await person(name, { ...extra, custom });
      mine.add(id);
      return id;
    };
    return { mine, add };
  };

  test("start dates for everyone, an admin-only birthday for admins only, hidden people never", async () => {
    const { mine, add } = people();
    const lena = await add("Lena", { [start.key]: "2026-11-02" }, { department: "Customer Success" });
    const tom = await add("Tom", { [start.key]: "2021-11-04" });
    const aisha = await add("Aisha", { [bday.key]: "1990-11-06" });
    await add("Ghost", { [start.key]: "2026-11-03" }, { hidden: 1 });
    await add("Olga", { [start.key]: "2020-01-15" });

    const view = async (u: SessionUser) => (await weekFor(u, mine)).map((e) => [e.person.id, e.kind, e.date, e.years]);
    assert.deepEqual(await view(session(ids.uMia)), [
      [lena, "started", "2026-11-02", 0],
      [tom, "anniversary", "2026-11-04", 5],
    ]);
    assert.deepEqual(await view(session(ids.uAdmin, "admin")), [
      [lena, "started", "2026-11-02", 0],
      [tom, "anniversary", "2026-11-04", 5],
      [aisha, "birthday", "2026-11-06", 0],
    ]);
    const row = (await weekFor(session(ids.uMia), mine)).find((e) => e.person.id === lena)!;
    assert.equal(row.person.department, "Customer Success");
    assert.ok(!("custom" in row.person), "the date values stay on the server");
  });

  test("at most five, the nearest today, shown in day order", async () => {
    const { mine, add } = people();
    // A five-year anniversary on each day, Monday 2 to Sunday 8 November.
    const byDay = new Map<number, number>();
    for (let d = 2; d <= 8; d++) byDay.set(d, await add(`Anniv ${d}`, { [start.key]: `2021-11-0${d}` }));
    const got = await weekFor(session(ids.uMia), mine);
    assert.equal(got.length, PEOPLE_THIS_WEEK_MAX, "seven this week, five on the tile");
    assert.deepEqual(
      got.map((e) => [e.person.id, e.date]),
      [3, 4, 5, 6, 7].map((d) => [byDay.get(d), `2026-11-0${d}`]),
      "Monday and Sunday, three days off, are the two left out"
    );
  });
});

describe("My training", () => {
  test("open assignments, overdue first then the soonest; N of M counts the done ones; null when unlicensed or none", async () => {
    assert.equal(await getMyOpenTraining(session(ids.uR2)), null, "nothing assigned");
    const deck = async (title: string) => {
      const doc = await createDocument({
        space_id: spaceId,
        title: `${STAMP} ${title}`,
        type: "knowledge",
        status: "published",
        content: "# One\n\n---\n\n# Two\n\n---\n\n# Three\n\n---\n\n# Four\n\n---\n\n# Five",
        summary: "",
        tags: [],
        author: "test",
      });
      docIds.push(doc.id);
      return (await fixtureQuery(`INSERT INTO training_decks (document_id) VALUES ($1) RETURNING id`, [doc.id])).rows[0].id as number;
    };
    const assign = (deckId: number, due: string | null, lastSlide: number, done = false) =>
      fixtureQuery(
        `INSERT INTO training_assignments (deck_id, user_id, due_at, last_slide, completed_at) VALUES ($1, $2, $3, $4, $5)`,
        [deckId, ids.uR1, due, lastSlide, done ? new Date().toISOString() : null]
      );
    const later = await deck("Fire safety");
    const soon = await deck("Data protection");
    const late = await deck("Security awareness");
    const done = await deck("Done already");
    const undated = await deck("Undated");
    await assign(later, new Date(Date.now() + 30 * 86_400_000).toISOString(), 0);
    await assign(soon, new Date(Date.now() + 5 * 86_400_000).toISOString(), 1);
    await assign(late, new Date(Date.now() - 2 * 86_400_000).toISOString(), 3);
    await assign(done, null, 5, true);
    await assign(undated, null, 0);

    const t = await getMyOpenTraining(session(ids.uR1));
    assert.ok(t);
    assert.equal(t.openCount, 4);
    assert.equal(t.total, 5);
    assert.deepEqual(
      t.open.map((x) => [x.title.replace(`${STAMP} `, ""), x.overdue, x.pct]),
      [
        ["Security awareness", true, 60],
        ["Data protection", false, 20],
        ["Fire safety", false, 0],
      ],
      "three rows: overdue, then by deadline; the undated one is counted but not shown"
    );

    edition.features = ["policy_ack"];
    try {
      assert.equal(await getMyOpenTraining(session(ids.uR1)), null, "unlicensed: no tile");
    } finally {
      edition.features = ["policy_ack", "training"];
    }
  });
});

describe("Team compliance", () => {
  let policyA = 0;
  let policyB = 0;
  before(async () => {
    const policy = async (space: number, title: string) => {
      const doc = await createDocument({
        space_id: space,
        title: `${STAMP} ${title}`,
        type: "policy",
        status: "published",
        content: "Clause 1: follow the procedure.",
        summary: "",
        tags: [],
        author: "test",
      });
      await switchOn(doc.id, { editDefault: null, recertMonths: null });
      docIds.push(doc.id);
      return doc.id;
    };
    policyA = await policy(spaceId, "Access Control Policy");
    policyB = await policy(privateSpaceId, "Private handling");
    const v1 = (await listVersions(policyA))[0].id;
    await recordAcknowledgement(policyA, ids.uR1, "", v1);
  });

  test("reports are the active accounts of direct reports; the standing never names a policy the manager cannot read", async () => {
    assert.deepEqual(await directReportAccounts(session(ids.uMia)), [ids.uR1, ids.uR2].sort((a, b) => a - b));
    const rows = await reportPolicyStanding([ids.uR1, ids.uR2], ids.uMia);
    assert.deepEqual(
      rows.map((r) => [r.document_id, r.owed, r.confirmed, r.outstanding]),
      [[policyA, 2, 1, ["Rob Two"]]]
    );
    assert.ok(!rows.some((r) => r.document_id === policyB));
    const asR1 = await reportPolicyStanding([ids.uR1, ids.uR2], ids.uR1);
    assert.deepEqual(asR1.map((r) => [r.document_id, r.confirmed]).sort(), [[policyA, 1], [policyB, 0]].sort(), "fewest confirmed first, for a viewer who reads both");
    assert.equal(asR1[0].document_id, policyB);
  });

  test("the tile's data: only for a manager, only with Read confirmation, only while leads see policy standing", async () => {
    const c = await getTeamCompliance(session(ids.uMia));
    assert.ok(c);
    assert.equal(c.reports, 2);
    assert.deepEqual(c.policies.map((p) => p.document_id), [policyA]);
    assert.equal(c.teamView, false, "Mia leads no group: no link to the team view");
    assert.equal(await getTeamCompliance(session(ids.uR1)), null, "not a manager");

    const stored = JSON.parse((await getSetting("ack_defaults")) || "{}");
    await setSetting("ack_defaults", JSON.stringify({ ...stored, leads_see_policies: false }));
    try {
      assert.equal(await getTeamCompliance(session(ids.uMia)), null, "standing closed to leads");
    } finally {
      await setSetting("ack_defaults", JSON.stringify({ ...stored, leads_see_policies: true }));
    }
    edition.features = ["training"];
    try {
      assert.equal(await getTeamCompliance(session(ids.uMia)), null, "unlicensed");
    } finally {
      edition.features = ["policy_ack", "training"];
    }
  });
});
