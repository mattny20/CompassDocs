// The per-person compliance record (F3, 1.14.0): userPolicyTranscript and
// GET /api/admin/compliance/people/[id]. The person and the programme see
// every row; a group lead sees members of groups they lead, only for
// policies in spaces they can read, with a count of the rest and never a
// private-space title; a space roster reader sees only the spaces they hold
// document.ack_roster_read on, and opens only people with a row there; a
// compliance.team_read holder opens any group member; a policy that stopped
// asking keeps its rows as closed rows marked stopped; a stranger gets null
// (404). The IP travels
// only where the viewer may see it; the inferred version flag rides along;
// the CSV has 21 columns; every CSV download writes ack.record_exported
// before the response streams; `me` is the viewer's own record.
//
// Fixtures: five accounts, three groups and three private spaces of this
// file's own, so the other files' people never enter these audiences. The
// Program setting leads_see_policies is written under the settings lock the
// other settings suites hold, and restored.
//
// The route handlers are called directly, the way test/ack-statement.test.ts
// does it: next/headers resolves to a stub that serves the request under
// test, and lib/ee to a stub that grants policy_ack.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-record.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import type { PoolClient } from "pg";
import {
  pool,
  getSetting,
  setSetting,
  createDocument,
  setAckRequired,
  listVersions,
  recordAcknowledgement,
  recordAckDecision,
  retirePolicy,
  exemptAssignments,
  createGroup,
  setGroupMembers,
  setGroupLeads,
  setSpaceGroups,
  createSession,
  createRole,
  assignRole,
  userPolicyTranscript,
  rosterReadSpaceIdsFor,
} from "../src/lib/db";
import type { PolicyTranscript, PolicyTranscriptRow } from "../src/lib/db";
import { recordNotices } from "../src/lib/compliance";
import { RECORD_CSV_HEADER, RECORD_STOPPED_CELL, recordCsvCells, supersededByText } from "../src/lib/read-evidence";
import { newToken } from "../src/lib/password";
import type { SessionUser } from "../src/lib/types";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next ------------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.ack-record.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.ack-record.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;

  const edition = { present: true, features: ["policy_ack"] };
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;

  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, req: Request, id: string): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  currentRequest = req;
  try {
    const res = await handler(req, { params: Promise.resolve({ id }) });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, text, headers: res.headers };
  } finally {
    currentRequest = null;
  }
}

function sessionRequest(url: string, session: string | null): Request {
  return new Request(url, {
    method: "GET",
    headers: {
      ...(session ? { cookie: `compass_session=${session}` } : {}),
      "x-forwarded-for": "203.0.113.31",
    },
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `ackrec-${Date.now()}`;
const DAY = 86_400_000;
const SETTINGS_LOCK = 728342;
const IP = "203.0.113.7";
const RESET_REASON = "Section 4 now covers contractors";
const PRIVATE_TITLE = `${STAMP} Private vault policy`;

let lockClient: PoolClient | null = null;
let savedDefaults: string | undefined;

let pubSpace = 0;
let pub2Space = 0;
let privSpace = 0;
let pubGroup = 0;
let privGroup = 0;
let teamGroup = 0;
let ana = 0;
let lead = 0;
let roster = 0;
let program = 0;
let stranger = 0;
const userIds: number[] = [];
const groupIds: number[] = [];
const docIds: number[] = [];
const roleIds: number[] = [];
const sessions = new Map<number, string>();

interface Policy {
  id: number;
  title: string;
  v1: number;
}
let pubPolicy: Policy;
let privPolicy: Policy;
let pub2Policy: Policy;
let oldPolicy: Policy;
let leftPolicy: Policy;
let retiredPolicy: Policy;

const manager = () => ({ id: program, name: "Pam Program" });

async function newUser(tag: string, name: string): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP}-${tag}`, name, `${STAMP}-${tag}@example.test`]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function newSpace(tag: string): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id`,
    [`Ack Record ${tag} ${STAMP}`, `${STAMP}-${tag}`]
  );
  return r.rows[0].id;
}

async function newGroup(tag: string, members: number[]): Promise<number> {
  const g = await createGroup({ name: `${STAMP} ${tag}` });
  groupIds.push(g.id);
  await setGroupMembers(g.id, members);
  return g.id;
}

/** A published policy in `spaceId`; the switch-on's reconcile enrols the space's members (the production path). */
async function policy(spaceId: number, title: string): Promise<Policy> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content: `${title}: staff must follow the procedure described here.`,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  // Both null: leave the edit default and the interval alone rather than
  // read the workspace settings row another test file may be writing.
  await setAckRequired(doc.id, true, { editDefault: null, recertMonths: null });
  return { id: doc.id, title, v1: (await listVersions(doc.id))[0].id };
}

async function assignmentId(docId: number, userId: number): Promise<number> {
  const r = await pool().query<{ id: number }>("SELECT id FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [docId, userId]);
  assert.ok(r.rows[0], `an assignment row for user ${userId} on document ${docId}`);
  return r.rows[0].id;
}

/** The newest confirmation row's id for the person on the document. */
async function lastAckId(docId: number, userId: number): Promise<number> {
  const r = await pool().query<{ id: number }>(
    "SELECT id FROM acknowledgements WHERE document_id = $1 AND user_id = $2 ORDER BY acknowledged_at DESC, id DESC LIMIT 1",
    [docId, userId]
  );
  return r.rows[0].id;
}

/** A whole-audience reset at `at`: the ledger row and the marker, as resetAcknowledgements writes them. */
async function resetAt(doc: Policy, versionId: number, at: string, source: "manual" | "recurrence", reason: string) {
  await recordAckDecision(pool(), {
    document_id: doc.id,
    document_title: doc.title,
    version_id: versionId,
    outcome: "reset",
    source,
    scope: "all",
    decided_by: source === "manual" ? program : null,
    decided_by_name: source === "manual" ? "Pam Program" : "Scheduler",
    reason,
    confirmations_affected: 1,
    eligible: 1,
    decided_at: at,
  });
  await pool().query("UPDATE documents SET ack_revision_at = $2, ack_version_id = $3 WHERE id = $1", [doc.id, at, versionId]);
}

function viewer(id: number): SessionUser {
  return {
    id,
    username: `user-${id}`,
    name: `User ${id}`,
    email: "",
    role: "viewer",
    must_change_password: false,
    page_width: "normal",
    ui_scale: "default",
    single_key_shortcuts: true,
    newsletter_role: "none",
    theme: "system",
    timezone: "",
    date_format: "auto",
    avatar: "",
  };
}

async function record(viewerId: number): Promise<PolicyTranscript> {
  const t = await userPolicyTranscript(ana, viewer(viewerId));
  assert.ok(t, `user ${viewerId} may open the record`);
  return t;
}

const byTitle = (rows: PolicyTranscriptRow[], p: Policy, record?: PolicyTranscriptRow["record"]) =>
  rows.find((r) => r.document_id === p.id && (record === undefined || r.record === record));
const titles = (rows: { title: string }[]) => rows.map((r) => r.title).sort();

/** The cells of one CSV line (every cell is quoted by csvCell; a cell never carries `","`). */
const cellsOf = (line: string) => line.slice(1, -1).split('","');

async function writeLeadsSeePolicies(on: boolean) {
  const raw = await getSetting("ack_defaults");
  let stored: Record<string, unknown> = {};
  try {
    stored = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    stored = {};
  }
  await setSetting("ack_defaults", JSON.stringify({ ...stored, leads_see_policies: on }));
}

describe("the per-person compliance record (F3)", () => {
  before(async () => {
    await getSetting("__schema_bootstrap__"); // run the schema and migrations first
    const client = await pool().connect();
    await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
    lockClient = client;
    savedDefaults = await getSetting("ack_defaults");
    // Off until the lead test switches it on: an upgraded workspace's default.
    await writeLeadsSeePolicies(false);

    ana = await newUser("ana", "Ana Record");
    lead = await newUser("lead", "Lee Lead");
    roster = await newUser("roster", "Ros Roster");
    program = await newUser("program", "Pam Program");
    stranger = await newUser("stranger", "Sam Stranger");

    pubGroup = await newGroup("members", [ana, lead, roster, program]);
    privGroup = await newGroup("vault", [ana]);
    teamGroup = await newGroup("team", [ana]);
    await setGroupLeads(teamGroup, [lead]);

    pubSpace = await newSpace("pub");
    pub2Space = await newSpace("pub2");
    privSpace = await newSpace("priv");
    await setSpaceGroups(pubSpace, [pubGroup]);
    await setSpaceGroups(pub2Space, [pubGroup]);
    await setSpaceGroups(privSpace, [privGroup]);

    // The roster reader holds the approver preset (document.ack_roster_read)
    // on the first space only; the programme viewer holds the Compliance
    // manager preset everywhere (program_read, export, roster_read).
    await fixtureQuery(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
       SELECT r.id, $1, 'space', $2 FROM roles r WHERE r.key = 'approver'`,
      [roster, pubSpace]
    );
    await fixtureQuery(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
       SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'compliance-manager'`,
      [program]
    );

    // 1. Confirmed v1 two days ago, asked again today for v2 (a reset with a
    //    reason), confirmed v2: a current row on v2 and a superseded v1.
    pubPolicy = await policy(pubSpace, `${STAMP} Code of conduct`);
    assert.equal(
      (
        await recordAcknowledgement(pubPolicy.id, ana, IP, pubPolicy.v1, {
          readSeconds: 42,
          reachedEnd: true,
          signedName: "Ana Record",
          identityProof: "password",
        })
      ).recorded,
      true
    );
    await pool().query("UPDATE acknowledgements SET acknowledged_at = now() - interval '2 days' WHERE id = $1", [
      await lastAckId(pubPolicy.id, ana),
    ]);
    const v2 = (
      await pool().query<{ id: number }>(
        "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1, $2, 'Policy body v2', 'test', 'Edited') RETURNING id",
        [pubPolicy.id, pubPolicy.title]
      )
    ).rows[0].id;
    await resetAt(pubPolicy, v2, new Date().toISOString(), "manual", RESET_REASON);
    assert.equal((await recordAcknowledgement(pubPolicy.id, ana, "", v2)).recorded, true);

    // 2. A private-space policy, overdue: due 100 days ago (past any grace).
    privPolicy = await policy(privSpace, PRIVATE_TITLE);
    await pool().query("UPDATE policy_assignments SET due_at = now() - interval '100 days' WHERE document_id = $1 AND user_id = $2", [
      privPolicy.id,
      ana,
    ]);

    // 3. Exempt in the second space.
    pub2Policy = await policy(pub2Space, `${STAMP} Expense policy`);
    const exempted = await exemptAssignments(pub2Policy.id, [await assignmentId(pub2Policy.id, ana)], manager(), {
      reason: "On leave",
      until: null,
    });
    assert.equal(exempted.changed.length, 1, "the exemption was recorded");

    // 4. A confirmation from before 1.10.0: no hash, so the version is inferred.
    oldPolicy = await policy(pubSpace, `${STAMP} Legacy handbook`);
    await pool().query(
      "INSERT INTO acknowledgements (document_id, user_id, acknowledged_at, ip, version_id, content_sha256) VALUES ($1, $2, now(), '', $3, NULL)",
      [oldPolicy.id, ana, oldPolicy.v1]
    );

    // 5. A row closed when the person left the group.
    leftPolicy = await policy(pubSpace, `${STAMP} Old team policy`);
    await pool().query(
      "UPDATE policy_assignments SET removed_at = now(), removed_reason = 'left_group' WHERE document_id = $1 AND user_id = $2",
      [leftPolicy.id, ana]
    );

    // 6. Confirmed three days ago, the annual cycle asked again today, confirmed
    //    again, then retired: a retired row (confirmed) and a superseded row
    //    whose successor is the cycle.
    retiredPolicy = await policy(pubSpace, `${STAMP} Retired policy`);
    assert.equal((await recordAcknowledgement(retiredPolicy.id, ana, "", retiredPolicy.v1)).recorded, true);
    await pool().query("UPDATE acknowledgements SET acknowledged_at = now() - interval '3 days' WHERE id = $1", [
      await lastAckId(retiredPolicy.id, ana),
    ]);
    await resetAt(retiredPolicy, retiredPolicy.v1, new Date().toISOString(), "recurrence", "Annual re-confirmation");
    assert.equal((await recordAcknowledgement(retiredPolicy.id, ana, "", retiredPolicy.v1)).recorded, true);
    assert.ok(await retirePolicy(retiredPolicy.id, manager(), "Replaced by the new handbook"), "retired");

    // Two notices: one on a policy the lead can see, one on the private one.
    await recordNotices([
      {
        user_id: ana,
        user_name: "Ana Record",
        user_email: `${STAMP}-ana@example.test`,
        document_id: pubPolicy.id,
        document_title: pubPolicy.title,
        kind: "request",
        channels: ["inapp"],
        by_user_id: program,
        by_name: "Pam Program",
      },
      {
        user_id: ana,
        user_name: "Ana Record",
        user_email: `${STAMP}-ana@example.test`,
        document_id: privPolicy.id,
        document_title: privPolicy.title,
        kind: "reminder",
        channels: ["inapp", "email"],
        by_name: "system",
      },
    ]);

    const expires = new Date(Date.now() + 3_600_000).toISOString();
    for (const id of [ana, program, stranger, roster]) {
      const token = newToken();
      await createSession(token, id, expires);
      sessions.set(id, token);
    }
  });

  after(async () => {
    await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
    await pool().query("DELETE FROM ack_notices WHERE user_id = ANY($1) OR document_id = ANY($2)", [userIds, docIds]);
    await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
    await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
    await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
    await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
    await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
    await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
    if (roleIds.length) await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
    await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
    await pool().query("DELETE FROM groups WHERE id = ANY($1)", [groupIds]);
    await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [[pubSpace, pub2Space, privSpace]]);
    if (savedDefaults === undefined) await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");
    else await setSetting("ack_defaults", savedDefaults);
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
      lockClient.release();
    }
  });

  test("the person sees every row: the four current standings, the three kinds of history, both notices, nothing hidden, no IP", async () => {
    const t = await record(ana);
    assert.equal(t.viewer_kind, "self");
    assert.equal(t.hidden, 0);
    assert.deepEqual(t.person, {
      id: ana,
      name: "Ana Record",
      username: `${STAMP}-ana`,
      email: `${STAMP}-ana@example.test`,
      status: "active",
    });

    assert.deepEqual(titles(t.current), titles([pubPolicy, privPolicy, pub2Policy, oldPolicy]));
    const current = byTitle(t.current, pubPolicy)!;
    assert.equal(current.record, "current");
    assert.equal(current.status, "confirmed");
    assert.equal(current.version, 2, "the current confirmation cites v2");
    assert.equal(current.version_source, "recorded");
    assert.equal(current.source, "space");
    assert.ok(current.assignment_id && current.assigned_at && current.cycle_started_at, "the assignment rides along");
    assert.equal(current.ip, null, "the person holds neither roster read nor export: no IP");
    assert.deepEqual(current.set_names, []);
    assert.equal(byTitle(t.current, privPolicy)!.status, "overdue");
    const exempt = byTitle(t.current, pub2Policy)!;
    assert.equal(exempt.status, "exempt");
    assert.equal(exempt.exempt_reason, "On leave");
    assert.equal(exempt.exempt_by_name, "Pam Program");
    assert.equal(t.current[t.current.length - 1].document_id, pub2Policy.id, "exempt rows last");
    assert.equal(t.current[0].document_id, privPolicy.id, "the unconfirmed row first");

    assert.equal(t.history.length, 4);
    const superseded = byTitle(t.history, pubPolicy, "superseded")!;
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.version, 1);
    assert.equal(superseded.read_seconds, 42);
    assert.equal(superseded.reached_end, true);
    assert.equal(superseded.signed_name, "Ana Record");
    assert.equal(superseded.identity_proof, "password");
    assert.equal(superseded.purged, false);
    assert.deepEqual(
      { version: superseded.superseded_by?.version, reason: superseded.superseded_by?.reason, kind: superseded.superseded_by?.kind },
      { version: 2, reason: RESET_REASON, kind: "reset" },
      "superseded by the reset that asked for v2"
    );
    const recert = byTitle(t.history, retiredPolicy, "superseded")!;
    assert.equal(recert.superseded_by?.kind, "recert", "the cycle's reset reads as the annual re-confirmation");
    assert.ok(recert.retired_at, "a history row on a retired policy carries the retirement");
    const closed = byTitle(t.history, leftPolicy, "closed")!;
    assert.equal(closed.removed_reason, "left_group");
    assert.ok(closed.removed_at && closed.assigned_at);
    assert.equal(closed.status, "pending");
    const retired = byTitle(t.history, retiredPolicy, "retired")!;
    assert.equal(retired.status, "confirmed", "the standing frozen at retirement");
    assert.ok(retired.retired_at);
    assert.equal(retired.version, 1);

    assert.deepEqual(
      t.notices.map((n) => [n.document_id, n.kind]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        [pubPolicy.id, "request"],
        [privPolicy.id, "reminder"],
      ].sort((a, b) => Number(a[0]) - Number(b[0]))
    );
  });

  test("the inferred version flag: a confirmation without a hash reads as inferred, one with it as recorded", async () => {
    const t = await record(ana);
    const old = byTitle(t.current, oldPolicy)!;
    assert.equal(old.status, "confirmed");
    assert.equal(old.version, 1);
    assert.equal(old.version_id, oldPolicy.v1);
    assert.equal(old.content_sha256, null);
    assert.equal(old.version_source, "inferred");
    assert.equal(byTitle(t.current, pubPolicy)!.version_source, "recorded");
    const pending = byTitle(t.current, privPolicy)!;
    assert.equal(pending.version_source, null, "no confirmation, no source");
  });

  test("the programme sees every row with the IP where one was recorded", async () => {
    const t = await record(program);
    assert.equal(t.viewer_kind, "program");
    assert.equal(t.hidden, 0);
    assert.equal(t.current.length, 4);
    assert.equal(t.history.length, 4);
    assert.equal(t.notices.length, 2);
    assert.equal(byTitle(t.history, pubPolicy, "superseded")!.ip, IP, "compliance.export: the recorded address");
    assert.equal(byTitle(t.current, pubPolicy)!.ip, "", "recorded without an address: blank, not null");
    assert.equal(byTitle(t.current, privPolicy)!.ip, null, "pending: no address");
    assert.equal(await rosterReadSpaceIdsFor(viewer(program)), "all");
  });

  test("a lead of a broad group: nothing until the setting is on, then the member's rows in spaces they can read, a count of the rest and no private title", async () => {
    assert.equal(await userPolicyTranscript(ana, viewer(lead)), null, "leads_see_policies off and no compliance.team_read: not a lead viewer");

    await writeLeadsSeePolicies(true);
    const t = await record(lead);
    assert.equal(t.viewer_kind, "lead");
    assert.equal(t.hidden, 1, "the private-space policy is counted, not shown");
    assert.deepEqual(titles(t.current), titles([pubPolicy, pub2Policy, oldPolicy]));
    assert.equal(t.history.length, 4, "every history row is in a space the lead can read");
    assert.equal(t.notices.length, 1, "the private policy's reminder is filtered the same way");
    assert.equal(t.notices[0].document_id, pubPolicy.id);
    const json = JSON.stringify(t);
    assert.ok(!json.includes(PRIVATE_TITLE), "the private-space title never reaches the JSON");
    assert.ok(!json.includes(IP), "the lead holds neither roster read nor export: no IP anywhere");
    for (const r of [...t.current, ...t.history]) assert.equal(r.ip, null);
    assert.ok(t.current.every((r) => r.space_id !== privSpace));
  });

  test("a space roster reader sees only the spaces they hold the roster permission on, with the IP there", async () => {
    assert.deepEqual(await rosterReadSpaceIdsFor(viewer(roster)), [pubSpace]);
    const t = await record(roster);
    assert.equal(t.viewer_kind, "roster");
    // At least: another file's internal-space policy that also asks Ana is
    // outside the roster reader's spaces too (the files share one database).
    assert.ok(t.hidden >= 2, "the private space and the second space are counted");
    assert.deepEqual(titles(t.current), titles([pubPolicy, oldPolicy]));
    assert.equal(t.history.length, 4);
    assert.equal(t.notices.length, 1);
    assert.equal(byTitle(t.history, pubPolicy, "superseded")!.ip, IP, "document.ack_roster_read on that space: the address");
    const json = JSON.stringify(t);
    assert.ok(!json.includes(PRIVATE_TITLE));
    assert.ok(!json.includes(pub2Policy.title), "no roster read on the second space: its policy is hidden");
  });

  test("a stranger gets null; so does an account that does not exist", async () => {
    assert.equal(await userPolicyTranscript(ana, viewer(stranger)), null);
    assert.equal(await userPolicyTranscript(2_000_000_000, viewer(program)), null);
  });

  test("the CSV: 21 columns, the superseded, inferred and exempt cells", async () => {
    assert.equal(RECORD_CSV_HEADER.split(",").length, 21);
    const t = await record(program);
    for (const r of [...t.current, ...t.history]) assert.equal(recordCsvCells(r).length, 21, `${r.record} ${r.title}`);
    const superseded = recordCsvCells(byTitle(t.history, pubPolicy, "superseded")!);
    assert.equal(superseded[2], "superseded");
    assert.equal(superseded[8], "v1");
    assert.equal(superseded[16], IP);
    assert.match(String(superseded[20]), /^v2 on \d{4}-\d{2}-\d{2}T.* - "Section 4 now covers contractors"$/);
    const recert = recordCsvCells(byTitle(t.history, retiredPolicy, "superseded")!);
    assert.match(String(recert[20]), /^annual re-confirmation on \d{4}/);
    const old = recordCsvCells(byTitle(t.current, oldPolicy)!);
    assert.equal(old[2], "confirmed");
    assert.equal(old[10], "inferred");
    assert.equal(old[11], "");
    const exempt = recordCsvCells(byTitle(t.current, pub2Policy)!);
    assert.deepEqual(exempt.slice(17, 20), ["On leave", "Pam Program", ""]);
    const closed = recordCsvCells(byTitle(t.history, leftPolicy, "closed")!);
    assert.equal(closed[2], "pending");
    assert.notEqual(closed[5], "", "removed_at is filled on a closed row");
    const pending = recordCsvCells(byTitle(t.current, privPolicy)!);
    assert.deepEqual(pending.slice(12, 17), ["", "", "", "", ""], "no confirmation: the evidence cells are blank");
    assert.equal(supersededByText({ version: 13, at: "2026-09-03", reason: "", kind: "confirmation" }, (d) => d), "v13 on 2026-09-03");
    assert.equal(supersededByText({ version: null, at: "x", reason: "r", kind: "reset" }), 'on x - "r"');
  });

  test("the route: the CSV download writes ack.record_exported before it answers; me is the viewer; a stranger, a bogus id and no session", async () => {
    const route = await import("../src/app/api/admin/compliance/people/[id]/route");
    const url = (id: string, qs = "") => `https://docs.example.test/api/admin/compliance/people/${id}${qs}`;

    const csv = await call(route.GET as Handler, sessionRequest(url(String(ana), "?format=csv"), sessions.get(program)!), String(ana));
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /^text\/csv/);
    assert.match(csv.headers.get("content-disposition") ?? "", /compliance-record-.*\.csv/);
    const lines = csv.text.trimEnd().split("\n");
    assert.equal(lines[0], RECORD_CSV_HEADER);
    // This file's rows: another file's internal-space policy may ask Ana too.
    assert.equal(lines.slice(1).filter((l) => l.includes(STAMP)).length, 8, "four current rows and four history rows");
    for (const line of lines.slice(1)) assert.equal(cellsOf(line).length, 21, line);
    assert.ok(csv.text.includes(PRIVATE_TITLE), "the programme's file carries the private policy");
    const audit = await pool().query<{ details: Record<string, unknown>; target_id: string; ip: string | null }>(
      "SELECT details, target_id, ip FROM audit_log WHERE action = 'ack.record_exported' AND actor_id = $1 ORDER BY id",
      [program]
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].target_id, String(ana));
    assert.equal(audit.rows[0].details.user_id, ana);
    assert.equal(audit.rows[0].details.rows, lines.length - 1, "the audit row counts the rows the file carried");
    assert.equal(audit.rows[0].details.viewer_kind, "program");
    assert.equal(audit.rows[0].ip, "203.0.113.31");

    const me = await call(route.GET as Handler, sessionRequest(url("me"), sessions.get(ana)!), "me");
    assert.equal(me.status, 200);
    assert.equal(me.body.person.id, ana);
    assert.equal(me.body.viewer_kind, "self");
    assert.equal(me.body.current.length, 4);

    const denied = await call(route.GET as Handler, sessionRequest(url(String(ana)), sessions.get(stranger)!), String(ana));
    assert.equal(denied.status, 404);
    assert.equal(denied.body.error, "No such person.");
    const bogus = await call(route.GET as Handler, sessionRequest(url("abc"), sessions.get(program)!), "abc");
    assert.equal(bogus.status, 404);
    const anonymous = await call(route.GET as Handler, sessionRequest(url(String(ana)), null), String(ana));
    assert.equal(anonymous.status, 401);
    // A JSON read writes no audit row.
    const again = await pool().query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ack.record_exported' AND actor_id = ANY($1)", [userIds]);
    assert.equal(again.rows[0].n, 1);
  });

  // --- Fix round (1.14.0) ---------------------------------------------------------

  test("a policy that stopped asking keeps the person's rows: a closed row marked stopped with the standing frozen (confirmed, or pending on a paused one), 'no longer required' in the CSV", async () => {
    // Confirmed, then "Stop requiring": the row stays open, the confirmation stands.
    const stopped = await policy(pubSpace, `${STAMP} Stopped policy`);
    assert.equal((await recordAcknowledgement(stopped.id, ana, IP, stopped.v1)).recorded, true);
    await setAckRequired(stopped.id, false);
    // Required, never confirmed, then unpublished (paused) with the requirement on.
    const paused = await policy(pubSpace, `${STAMP} Paused policy`);
    await pool().query("UPDATE documents SET status = 'draft' WHERE id = $1", [paused.id]);

    const t = await record(ana);
    assert.equal(byTitle(t.current, stopped), undefined, "no longer a current requirement");
    assert.equal(byTitle(t.current, paused), undefined);
    const row = byTitle(t.history, stopped, "closed");
    assert.ok(row, "the stopped policy's row is on the record");
    assert.equal(row.stopped, true);
    assert.equal(row.status, "confirmed", "the standing when it stopped");
    assert.equal(row.removed_at, null, "nothing closed the row");
    assert.equal(row.version, 1);
    assert.ok(row.acknowledged_at && row.assignment_id && row.assigned_at);
    assert.equal(byTitle(t.history, stopped, "superseded"), undefined, "the confirmation is not counted twice");
    const pausedRow = byTitle(t.history, paused, "closed")!;
    assert.equal(pausedRow.stopped, true);
    assert.equal(pausedRow.status, "pending", "never overdue on a policy that stopped");
    assert.equal(byTitle(t.history, leftPolicy, "closed")!.stopped, false, "a row the audience closed is not 'stopped'");
    assert.ok(t.history.filter((r) => r.record !== "closed").every((r) => r.stopped === false));
    assert.ok(t.current.every((r) => r.stopped === false));

    const cells = recordCsvCells(row);
    assert.equal(cells.length, 21);
    assert.equal(cells[2], "confirmed");
    assert.equal(cells[5], "", "no removed_at");
    assert.equal(cells[8], "v1");
    assert.equal(cells[20], RECORD_STOPPED_CELL);
    assert.equal(RECORD_STOPPED_CELL, "no longer required");
    assert.equal(recordCsvCells(byTitle(t.history, leftPolicy, "closed")!)[20], "", "a plain closed row's last cell stays blank");

    // The programme sees it with the address, as on any confirmed row.
    const p = await record(program);
    assert.equal(byTitle(p.history, stopped, "closed")!.ip, IP);
  });

  test("a space roster reader opens a record only when the person has a row on a policy in the reader's spaces; anyone else is the stranger's 404, and a global roster grant still opens anyone", async () => {
    assert.equal(await userPolicyTranscript(stranger, viewer(roster)), null, "no row of Sam's in the reader's space");
    const other = await newUser("other", "Oli Other");
    const ackRow = (doc: Policy) =>
      pool().query(
        "INSERT INTO acknowledgements (document_id, user_id, acknowledged_at, ip, version_id, content_sha256) VALUES ($1, $2, now(), '', $3, NULL)",
        [doc.id, other, doc.v1]
      );
    await ackRow(pub2Policy);
    assert.equal(await userPolicyTranscript(other, viewer(roster)), null, "a row in a space the reader holds no roster permission on");
    // A confirmation alone (no assignment row) in the reader's space admits them.
    await ackRow(oldPolicy);
    const t = await userPolicyTranscript(other, viewer(roster));
    assert.ok(t);
    assert.equal(t.viewer_kind, "roster");
    assert.ok(t.hidden >= 1, "the second space's policy is counted, not shown");
    assert.ok(!JSON.stringify(t).includes(pub2Policy.title));

    // The route answers the same 404 body as an unknown id.
    const route = await import("../src/app/api/admin/compliance/people/[id]/route");
    const url = `https://docs.example.test/api/admin/compliance/people/${stranger}`;
    const denied = await call(route.GET as Handler, sessionRequest(url, sessions.get(roster)!), String(stranger));
    assert.deepEqual([denied.status, denied.body], [404, { error: "No such person." }]);
    const allowed = await call(route.GET as Handler, sessionRequest(url.replace(String(stranger), String(ana)), sessions.get(roster)!), String(ana));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.viewer_kind, "roster");

    // The approver preset held globally reads every space's roster: it opens anyone.
    const everywhere = await newUser("everywhere", "Eve Everywhere");
    await fixtureQuery(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
       SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'approver'`,
      [everywhere]
    );
    assert.equal(await rosterReadSpaceIdsFor(viewer(everywhere)), "all");
    assert.equal((await userPolicyTranscript(stranger, viewer(everywhere)))?.viewer_kind, "roster");
  });

  test("a compliance.team_read holder opens any group member's record, as the team page links it, through the spaces they can read; a plain lead still needs the setting; someone in no group is a stranger's null", async () => {
    await writeLeadsSeePolicies(false);
    assert.equal(await userPolicyTranscript(ana, viewer(lead)), null, "a lead without compliance.team_read: the setting is off");

    const reader = await newUser("teamread", "Tia Teamread");
    const role = await createRole({ name: `Team reader ${STAMP}`, permissions: ["compliance.team_read"] });
    assert.ok("id" in role, "the role exists");
    roleIds.push(role.id);
    assert.deepEqual(await assignRole({ roleId: role.id, userId: reader }), { ok: true });
    // The reader leads no group of Ana's and can read the first space only
    // (a direct grant: setSpaceGroups would reconcile the space's policies
    // and re-open Ana's closed row).
    await fixtureQuery(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
       SELECT r.id, $1, 'space', $2 FROM roles r WHERE r.key = 'space-member'`,
      [reader, pubSpace]
    );

    const t = await userPolicyTranscript(ana, viewer(reader));
    assert.ok(t, "team_read opens a group member's record whatever group they are in");
    assert.equal(t.viewer_kind, "lead");
    const own = (rows: PolicyTranscriptRow[]) => rows.filter((r) => r.document_id != null && docIds.includes(r.document_id));
    assert.deepEqual(titles(own(t.current)), titles([pubPolicy, oldPolicy]), "only what the reader can read");
    assert.ok(t.hidden >= 2, "the private and second spaces' policies are counted");
    const json = JSON.stringify(t);
    assert.ok(!json.includes(PRIVATE_TITLE));
    assert.ok(!json.includes(pub2Policy.title));

    assert.equal(await userPolicyTranscript(stranger, viewer(reader)), null, "Sam is in no group: the team page never lists him");
  });
});
