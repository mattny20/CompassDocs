// The team view for group leads (F4, 1.14.0): teamPolicyRows scopes a
// lead's rows to the spaces the lead can read (a private-space policy a
// member owes is a count, never a title); GET /api/compliance/team opens for
// a lead when Program settings let leads see policy standing, for a
// compliance.team_read holder always (every group), and for nobody else;
// POST /api/compliance/team reminds one person on the row's own cadence
// (429 inside remind_every_days), only within the lead's groups (403), and
// never for a hidden row (404).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/team-policies.test.ts

// lib/ee as a licensed build sees it, installed before the route loads.
import "./support/ee-stub";
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
  setGroupLeads,
  setSpaceGroups,
  listVersions,
  recordAcknowledgement,
  teamPolicyRows,
  leadMayRemind,
  createRole,
  assignRole,
  createSession,
  pendingAckOutboxFor,
} from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";
import { teamGroupSummaries, remindedAgoSentence, daysSince } from "../src/lib/team-digest";

const STAMP = `teampol-${Date.now()}`;
const HOUR = 3_600_000;
const SETTINGS_LOCK = 728342;

const TEXT = Array.from({ length: 8 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");

let internalSpaceId = 0;
let privateSpaceId = 0;
let groupId = 0; // led by the lead
let otherGroupId = 0; // led by nobody the test knows
let leadId = 0;
let strangerId = 0;
let holderId = 0;
let m1 = 0;
let m2 = 0;
let m3 = 0;
let policyA = 0; // internal space: the lead can read it
let policyB = 0; // private space granted to the group: the lead cannot
let roleId = 0;
const docIds: number[] = [];
const userIds: number[] = [];

let lockClient: PoolClient | null = null;
let savedDefaults: string | undefined;

async function user(suffix: string, name: string): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP}-${suffix}`, name, `${STAMP}-${suffix}@example.test`]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function policy(spaceId: number, title: string): Promise<number> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content: TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  await switchOn(doc.id, { editDefault: null, recertMonths: null });
  docIds.push(doc.id);
  return doc.id;
}

async function leadsSeePolicies(on: boolean) {
  const stored = JSON.parse((await getSetting("ack_defaults")) || "{}");
  await setSetting("ack_defaults", JSON.stringify({ ...stored, leads_see_policies: on }));
}

const rowOf = async (docId: number, userId: number) =>
  (
    await pool().query<{ id: number; reminded_at: string | null; reminder_count: number }>(
      "SELECT id, reminded_at, reminder_count FROM policy_assignments WHERE document_id = $1 AND user_id = $2",
      [docId, userId]
    )
  ).rows[0];

before(async () => {
  await getSetting("__schema_bootstrap__");
  // ack_defaults is shared with the other settings-touching files: one
  // advisory lock for the file, the row restored after it.
  const client = await pool().connect();
  await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
  lockClient = client;
  savedDefaults = await getSetting("ack_defaults");

  const internal = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Team ${STAMP}`, `${STAMP}-int`]
  );
  internalSpaceId = internal.rows[0].id;
  const priv = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '🔒', '', 'private') RETURNING id`,
    [`Team private ${STAMP}`, `${STAMP}-priv`]
  );
  privateSpaceId = priv.rows[0].id;

  leadId = await user("lead", "Lena Lead");
  strangerId = await user("stranger", "Sam Stranger");
  holderId = await user("holder", "Holly Holder");
  m1 = await user("m1", "Ana Member");
  m2 = await user("m2", "Ben Member");
  m3 = await user("m3", "Cy Other");

  groupId = (await createGroup({ name: `Team ${STAMP}` })).id;
  otherGroupId = (await createGroup({ name: `Other ${STAMP}` })).id;
  await addGroupMember(groupId, m1);
  await addGroupMember(groupId, m2);
  await addGroupMember(otherGroupId, m3);
  // The lead leads the group without being in it, so the private space
  // granted to the group is one the lead cannot read.
  await setGroupLeads(groupId, [leadId]);
  await setSpaceGroups(privateSpaceId, [groupId]);

  policyA = await policy(internalSpaceId, `${STAMP} Code of conduct`);
  policyB = await policy(privateSpaceId, `${STAMP} Private handling`);

  // Ana confirmed A; Ben is overdue on A (a deadline long past, whatever the grace).
  const v1 = (await listVersions(policyA))[0].id;
  await recordAcknowledgement(policyA, m1, "", v1);
  await pool().query("UPDATE policy_assignments SET due_at = now() - interval '100 days' WHERE document_id = $1 AND user_id = $2", [
    policyA,
    m2,
  ]);

  const role = await createRole({ name: `Team reader ${STAMP}`, permissions: ["compliance.team_read"] });
  assert.ok("id" in role, "the custom role exists");
  roleId = (role as { id: number }).id;
  await assignRole({ roleId, userId: holderId });
});

after(async () => {
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM audit_log WHERE action = 'ack.reminder_sent' AND target_id = ANY($1)", [docIds.map(String)]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  if (roleId) await pool().query("DELETE FROM roles WHERE id = $1", [roleId]);
  await pool().query("DELETE FROM groups WHERE id = ANY($1)", [[groupId, otherGroupId]]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [[internalSpaceId, privateSpaceId]]);
  if (savedDefaults === undefined) await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");
  else await setSetting("ack_defaults", savedDefaults);
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
    lockClient.release();
  }
});

describe("teamPolicyRows (the lead's scope in SQL)", () => {
  test("a lead of a broad group gets the private-space policy as a count, never a title; statuses and order per member", async () => {
    const rows = await teamPolicyRows([groupId], leadId);
    const mine = rows.filter((r) => r.group_id === groupId);
    assert.deepEqual(
      mine.map((r) => [r.user_name, r.title, r.status, r.hidden_count]),
      [
        ["Ana Member", `${STAMP} Code of conduct`, "confirmed", 1],
        ["Ben Member", `${STAMP} Code of conduct`, "overdue", 1],
      ]
    );
    assert.ok(!rows.some((r) => r.title === `${STAMP} Private handling`), "the private title never leaves the database");
    assert.ok(!rows.some((r) => r.document_id === policyB), "nor its id");
    const ben = mine.find((r) => r.user_id === m2)!;
    assert.ok(ben.due_at, "the row carries the deadline");
    assert.equal(ben.acknowledged_at, null);
    assert.ok(mine.find((r) => r.user_id === m1)!.acknowledged_at, "a confirmed row carries its date");

    const summary = teamGroupSummaries([{ id: groupId, name: "G" }], rows);
    assert.deepEqual(summary, [{ id: groupId, name: "G", members: 2, confirmed: 1, open: 1, overdue: 1 }]);
  });

  test("a viewer who can read the private space sees both policies and no hidden count; a member with nothing to confirm still appears once", async () => {
    // Ana can read the private space (the group's grant), so as a viewer she sees every row.
    const rows = (await teamPolicyRows([groupId, otherGroupId], m1)).filter((r) => [groupId, otherGroupId].includes(r.group_id));
    const ana = rows.filter((r) => r.user_id === m1);
    assert.deepEqual(
      ana.map((r) => [r.title, r.status, r.hidden_count]).sort(),
      [
        [`${STAMP} Code of conduct`, "confirmed", 0],
        [`${STAMP} Private handling`, "pending", 0],
      ].sort()
    );
    // Cy is in the other group and can see the internal space, so A asks him
    // (space mode enrols everyone who can see the space).
    const cy = rows.filter((r) => r.user_id === m3);
    assert.equal(cy.length, 1);
    assert.equal(cy[0].group_id, otherGroupId);
    assert.equal(cy[0].status, "pending");
    // Remove his row: he appears once with nothing to confirm.
    await pool().query("UPDATE policy_assignments SET removed_at = now(), removed_reason = 'left_group' WHERE document_id = $1 AND user_id = $2", [
      policyA,
      m3,
    ]);
    const again = (await teamPolicyRows([otherGroupId], m1)).filter((r) => r.group_id === otherGroupId);
    assert.deepEqual(
      again.map((r) => [r.user_name, r.assignment_id, r.title, r.status, r.hidden_count]),
      [["Cy Other", null, null, null, 0]]
    );
    await pool().query("UPDATE policy_assignments SET removed_at = NULL, removed_reason = '' WHERE document_id = $1 AND user_id = $2", [
      policyA,
      m3,
    ]);
    assert.deepEqual(await teamPolicyRows([], m1), [], "no groups, no rows");
  });

  test("leadMayRemind answers the row with its cadence, the leadership test and whether anything is left to remind; a hidden row is null", async () => {
    const ben = await rowOf(policyA, m2);
    const row = await leadMayRemind(ben.id, leadId, 7);
    assert.ok(row, "Ben's row on A is visible to the lead");
    assert.equal(row!.user_id, m2);
    assert.equal(row!.document_id, policyA);
    assert.equal(row!.leads, true);
    assert.equal(row!.confirmed, false);
    assert.equal(row!.exempt, false);
    assert.equal(row!.remind_every_days, 7, "the workspace number when the policy and the space set none");
    assert.equal(row!.reminded_at, null);

    const ana = await rowOf(policyA, m1);
    assert.equal((await leadMayRemind(ana.id, leadId, 7))!.confirmed, true, "Ana confirmed: nothing to remind");
    const cy = await rowOf(policyA, m3);
    assert.equal((await leadMayRemind(cy.id, leadId, 7))!.leads, false, "Cy is in a group the lead does not lead");
    const benPrivate = await rowOf(policyB, m2);
    assert.equal(await leadMayRemind(benPrivate.id, leadId, 7), null, "a private-space row the lead cannot read is absent");
    assert.ok(await leadMayRemind(benPrivate.id, m1, 7), "a viewer who can read the space gets it");
    // The policy's own cadence wins over the workspace number.
    await pool().query("UPDATE policy_settings SET remind_every_days = 3 WHERE document_id = $1", [policyA]);
    assert.equal((await leadMayRemind(ben.id, leadId, 7))!.remind_every_days, 3);
    await pool().query("UPDATE policy_settings SET remind_every_days = NULL WHERE document_id = $1", [policyA]);
  });

  test("the pure helpers: the 429 sentence and whole days", () => {
    assert.equal(remindedAgoSentence("Ben Member", 0), "Ben Member was reminded earlier today.");
    assert.equal(remindedAgoSentence("Ben Member", 1), "Ben Member was reminded 1 day ago.");
    assert.equal(remindedAgoSentence("Ben Member", 3), "Ben Member was reminded 3 days ago.");
    const now = Date.now();
    assert.equal(daysSince(new Date(now - 2.5 * 86_400_000).toISOString(), now), 2);
    assert.equal(daysSince(new Date(now + 60_000).toISOString(), now), 0, "never negative");
  });
});

// --- The routes ---------------------------------------------------------------
// The handlers are called directly, the way test/ack-exempt.test.ts does it:
// next/headers resolves to a stub serving the request under test (a session
// cookie per person), lib/ee to the licensed stub installed above.

describe("GET and POST /api/compliance/team", () => {
  let currentRequest: Request | null = null;
  let route: typeof import("../src/app/api/compliance/team/route");
  const sessions = new Map<number, string>();

  before(async () => {
    const Module = (await import("node:module")).default;
    const path = (await import("node:path")).default;
    const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.team-policies.virtual.js");
    const jar = () => {
      const out = new Map<string, string>();
      for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
      }
      return out;
    };
    const headers = new Module(HEADERS_STUB);
    headers.filename = HEADERS_STUB;
    headers.loaded = true;
    headers.exports = {
      headers: async () => new Headers(currentRequest?.headers ?? {}),
      cookies: async () => {
        const c = jar();
        return {
          get: (name: string) => (c.has(name) ? { name, value: c.get(name) } : undefined),
          getAll: () => [...c].map(([name, value]) => ({ name, value })),
          has: (name: string) => c.has(name),
        };
      },
      draftMode: async () => ({ isEnabled: false }),
    };
    require.cache[HEADERS_STUB] = headers;
    const loader = Module as unknown as {
      _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
    };
    const resolveFilename = loader._resolveFilename;
    loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
      if (request === "next/headers") return HEADERS_STUB;
      return resolveFilename.call(this, request, parent, ...rest);
    };
    route = await import("../src/app/api/compliance/team/route");
    for (const id of [leadId, strangerId, holderId, m1]) {
      const token = newToken();
      await createSession(token, id, new Date(Date.now() + HOUR).toISOString());
      sessions.set(id, token);
    }
  });

  async function call(as: number, init?: { method: "POST"; body: unknown }): Promise<{ status: number; body: any }> {
    const req = new Request("http://localhost/api/compliance/team", {
      method: init?.method ?? "GET",
      headers: { cookie: `compass_session=${sessions.get(as)}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: init ? JSON.stringify(init.body) : undefined,
    });
    currentRequest = req;
    try {
      const res = init ? await route.POST(req) : await route.GET();
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
      currentRequest = null;
    }
  }

  test("the rule: a lead needs the setting; a stranger never; a compliance.team_read holder sees every group", async () => {
    await leadsSeePolicies(false);
    let r = await call(leadId);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "Group leads don't see policy standing in this workspace.");
    r = await call(strangerId);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "You don't lead any groups.");

    await leadsSeePolicies(true);
    r = await call(leadId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.groups, [{ id: groupId, name: `Team ${STAMP}`, members: 2, confirmed: 1, open: 1, overdue: 1 }]);
    assert.equal(r.body.rows.length, 2);
    assert.ok(r.body.rows.every((x: any) => x.hidden_count === 1 && x.title === `${STAMP} Code of conduct`), "the private policy is a count");
    r = await call(strangerId);
    assert.equal(r.status, 403, "the setting opens nothing for someone who leads no group");

    // The permission holder leads nothing and sees every group, setting or not.
    await leadsSeePolicies(false);
    r = await call(holderId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const names = r.body.groups.map((g: any) => g.name);
    assert.ok(names.includes(`Team ${STAMP}`) && names.includes(`Other ${STAMP}`), `every group: ${names.join(", ")}`);
    assert.ok(
      r.body.rows.some((x: any) => x.user_id === m3 && x.group_id === otherGroupId),
      "the other group's member is in the rows"
    );
    await leadsSeePolicies(true);
  });

  test("a lead reminds one person on the row's cadence: queued once, stamped, audited by: 'lead'; 429 inside the cadence; 403 outside the lead's groups; 404 for a hidden row", async () => {
    await leadsSeePolicies(true);
    const ben = await rowOf(policyA, m2);
    assert.equal(ben.reminded_at, null);
    assert.equal((await pendingAckOutboxFor(policyA)).length, 0);

    let r = await call(leadId, { method: "POST", body: { assignment_id: ben.id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.queued, 1);
    assert.equal(r.body.user_id, m2);
    const queued = await pendingAckOutboxFor(policyA);
    assert.equal(queued.length, 1, "one outbox row");
    assert.equal(queued[0].mode, "reminder");
    assert.equal(queued[0].source, "manual");
    assert.deepEqual(queued[0].user_ids, [m2], "for Ben alone");
    assert.equal(queued[0].actor_name, "Lena Lead");
    const stamped = await rowOf(policyA, m2);
    assert.ok(stamped.reminded_at, "the row is stamped");
    assert.equal(stamped.reminder_count, 1);
    assert.equal((await rowOf(policyA, m1)).reminded_at, null, "nobody else is stamped");
    const audit = await pool().query<{ actor_name: string; details: Record<string, unknown> }>(
      "SELECT actor_name, details FROM audit_log WHERE action = 'ack.reminder_sent' AND target_id = $1 ORDER BY id",
      [String(policyA)]
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_name, "Lena Lead");
    assert.equal(audit.rows[0].details.by, "lead");
    assert.equal(audit.rows[0].details.user_id, m2);
    assert.equal(audit.rows[0].details.assignment_id, ben.id);

    // Inside the cadence (7 days built in): refused with the sentence.
    r = await call(leadId, { method: "POST", body: { assignment_id: ben.id } });
    assert.equal(r.status, 429, JSON.stringify(r.body));
    assert.equal(r.body.error, "Ben Member was reminded earlier today.");
    assert.equal((await pendingAckOutboxFor(policyA)).length, 1, "nothing more queued");
    // Three days in, still inside; past the cadence, allowed again.
    await pool().query("UPDATE policy_assignments SET reminded_at = now() - interval '3 days' WHERE id = $1", [ben.id]);
    r = await call(leadId, { method: "POST", body: { assignment_id: ben.id } });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "Ben Member was reminded 3 days ago.");
    await pool().query("UPDATE policy_assignments SET reminded_at = now() - interval '8 days' WHERE id = $1", [ben.id]);
    r = await call(leadId, { method: "POST", body: { assignment_id: ben.id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await pendingAckOutboxFor(policyA)).length, 2);

    // Ana confirmed: nothing to remind. Cy: not the lead's group. A hidden row: absent.
    const ana = await rowOf(policyA, m1);
    r = await call(leadId, { method: "POST", body: { assignment_id: ana.id } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /has already confirmed/);
    const cy = await rowOf(policyA, m3);
    r = await call(leadId, { method: "POST", body: { assignment_id: cy.id } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "You can only remind members of groups you lead.");
    const benPrivate = await rowOf(policyB, m2);
    r = await call(leadId, { method: "POST", body: { assignment_id: benPrivate.id } });
    assert.equal(r.status, 404);
    r = await call(leadId, { method: "POST", body: { assignment_id: "x" } });
    assert.equal(r.status, 400);
    // The setting off closes the POST too; a stranger never reaches it.
    await leadsSeePolicies(false);
    r = await call(leadId, { method: "POST", body: { assignment_id: ben.id } });
    assert.equal(r.status, 403);
    await leadsSeePolicies(true);
    r = await call(strangerId, { method: "POST", body: { assignment_id: ben.id } });
    assert.equal(r.status, 403);
    assert.equal((await pendingAckOutboxFor(policyA)).length, 2, "nothing more queued by the refusals");
  });
});
