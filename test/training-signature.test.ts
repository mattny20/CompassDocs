// The training deck's e-signature (0.82) through lib/attestation (C2,
// 1.12.0): POST /api/training/assignments/[id] { action: "confirm" } keeps
// its own two sentences for a wrong name and a wrong password, passes the
// helper's 429 through while the username+address throttle holds (the
// behaviour the extraction added), records the typed name on completion,
// and audits a wrong password as the sign-in form audits a miss
// (auth.login_failed with via 'attestation'; auth.lockout when the fifth
// miss engages the lock). The password reaches no row.
//
// The handler is called directly, as test/ack-statement.test.ts drives its
// routes: next/headers resolves to a stub that serves the request under
// test (its session cookie), and lib/ee to a stub that grants 'training',
// because the community `@ee` stub advertises no features and the licence
// check would otherwise answer 402 before anything here runs.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/training-signature.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import {
  pool,
  getSetting,
  createDocument,
  createSession,
  createTrainingDeck,
  updateTrainingDeck,
  assignTraining,
} from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.training-signature.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.training-signature.virtual.js");
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

  // lib/ee as a licensed enterprise build sees it: training is on.
  const edition = { present: true, features: ["training"] };
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

async function call(handler: Handler, req: Request, id: number): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await handler(req, { params: Promise.resolve({ id: String(id) }) });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON body */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

const CLIENT_IP = "203.0.113.31";
/** A second address: the throttle is per username+IP, so the right pair signs from here after the lock. */
const OTHER_IP = "203.0.113.32";

function sessionRequest(url: string, session: string, body: unknown, ip = CLIENT_IP): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      cookie: `compass_session=${session}`,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `trainsig-${Date.now()}`;
const PASSWORD = "Train!Me12345";
let spaceId = 0;
let traineeId = 0;
let traineeSession = "";
let docId = 0;
let deckId = 0;
let assignmentId = 0;

async function auditRows() {
  const r = await pool().query<{ action: string; details: Record<string, unknown> | null; ip: string | null; target_id: string }>(
    "SELECT action, details, ip, target_id FROM audit_log WHERE actor_id = $1 ORDER BY id",
    [traineeId]
  );
  return r.rows;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '🎓', '', 'internal') RETURNING id`,
    [`Training Signature ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const creds = hashPassword(PASSWORD);
  const user = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, password_hash, password_salt)
     VALUES ($1, 'Deck Trainee', $2, 'viewer', 'active', $3, $4) RETURNING id`,
    [`${STAMP}-trainee`, `${STAMP}-trainee@example.test`, creds.hash, creds.salt]
  );
  traineeId = user.rows[0].id;
  traineeSession = newToken();
  await createSession(traineeSession, traineeId, new Date(Date.now() + 3_600_000).toISOString());

  // A deck with no quiz (so the signature is the only gate), requiring the
  // e-signature, assigned to the trainee.
  const doc = await createDocument({
    space_id: spaceId,
    title: `${STAMP} deck`,
    type: "knowledge",
    status: "published",
    content: "# Safety induction\n\nSlide one.\n\n---\n\nSlide two: read it and confirm.",
    summary: "",
    tags: [],
    author: "test",
  });
  docId = doc.id;
  const deck = await createTrainingDeck(docId, { due_days: null, assign_new_members: false }, traineeId);
  assert.ok(deck, "the deck exists");
  deckId = deck.id;
  await updateTrainingDeck(deckId, { require_signature: true });
  assert.deepEqual(await assignTraining(deckId, [traineeId], "test", "manual", null), [traineeId]);
  const a = await pool().query<{ id: number }>("SELECT id FROM training_assignments WHERE deck_id = $1 AND user_id = $2", [
    deckId,
    traineeId,
  ]);
  assignmentId = a.rows[0].id;
});

after(async () => {
  await pool().query("DELETE FROM audit_log WHERE actor_id = $1", [traineeId]);
  await pool().query("DELETE FROM sessions WHERE user_id = $1", [traineeId]);
  await pool().query("DELETE FROM training_assignments WHERE deck_id = $1", [deckId]);
  await pool().query("DELETE FROM training_decks WHERE id = $1", [deckId]);
  await pool().query("DELETE FROM documents WHERE id = $1 OR space_id = $2", [docId, spaceId]);
  await pool().query("DELETE FROM users WHERE id = $1", [traineeId]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

// --- The signature branch ------------------------------------------------------------

describe("POST /api/training/assignments/[id] { action: 'confirm' } on a deck that requires an e-signature", () => {
  test("wrong name 409 and wrong password 409 in the route's own words; the sixth attempt 429; the right pair 200 with the name recorded; a miss is audited without the password", async () => {
    const route = await import("../src/app/api/training/assignments/[id]/route");
    const url = `http://localhost/api/training/assignments/${assignmentId}`;
    const confirm = (typed_name: string, password: string, ip = CLIENT_IP) =>
      call(route.POST as Handler, sessionRequest(url, traineeSession, { action: "confirm", typed_name, password }, ip), assignmentId);
    const completion = async () =>
      (
        await pool().query<{ completed_at: string | null; signed_name: string | null }>(
          "SELECT completed_at, signed_name FROM training_assignments WHERE id = $1",
          [assignmentId]
        )
      ).rows[0];

    // The name: the route's sentence, naming the account's own name.
    const wrongName = await confirm("Somebody Else", PASSWORD);
    assert.equal(wrongName.status, 409);
    assert.equal(wrongName.body.error, "Type your full name exactly as it appears on your account (Deck Trainee).");
    assert.equal((await auditRows()).length, 0, "a wrong name is not a password guess: nothing on the record");

    // The password: the route's sentence (an em dash, unlike the card's),
    // one auth.login_failed row against the deck, no lock yet.
    const wrongPassword = await confirm("deck trainee", "wrong-0");
    assert.equal(wrongPassword.status, 409);
    assert.equal(wrongPassword.body.error, "Password check failed — re-enter your account password to sign.");
    let rows = await auditRows();
    assert.deepEqual(
      rows.map((r) => [r.action, r.details, r.ip, r.target_id]),
      [["auth.login_failed", { via: "attestation" }, CLIENT_IP, String(docId)]]
    );
    assert.equal((await completion()).completed_at, null, "nothing was completed by a refusal");

    // Four more misses: the fifth engages the username+address lock and
    // writes auth.lockout; the sixth attempt, with the right password, is
    // 429 in the helper's words and completes nothing.
    for (let i = 1; i < 5; i++) {
      const r = await confirm("Deck Trainee", `wrong-${i}`);
      assert.equal(r.status, 409, `miss ${i + 1} is a plain refusal`);
    }
    rows = await auditRows();
    assert.equal(rows.filter((r) => r.action === "auth.login_failed").length, 5);
    const lockouts = rows.filter((r) => r.action === "auth.lockout");
    assert.equal(lockouts.length, 1, "the fifth miss engaged the lock");
    assert.deepEqual([lockouts[0].details, lockouts[0].ip, lockouts[0].target_id], [{ minutes: 15 }, CLIENT_IP, String(docId)]);
    const locked = await confirm("Deck Trainee", PASSWORD);
    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /^Too many failed attempts\. Try again in \d+ minutes?\.$/);
    assert.equal((await completion()).completed_at, null, "the right password under the lock completes nothing");
    assert.equal((await auditRows()).length, 6, "and is not a miss");

    // The right pair from another address (a different pair): completed,
    // the name as typed and trimmed, the completion audited with it.
    const signed = await confirm("  Deck Trainee ", PASSWORD, OTHER_IP);
    assert.deepEqual(signed, { status: 200, body: { ok: true } });
    const done = await completion();
    assert.ok(done.completed_at, "completed");
    assert.equal(done.signed_name, "Deck Trainee");
    rows = await auditRows();
    const completed = rows.filter((r) => r.action === "training.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].details?.signed_name, "Deck Trainee");
    assert.equal(completed[0].target_id, String(docId));
    // Once: a second confirmation is acknowledged, not recorded again.
    assert.deepEqual((await confirm("Deck Trainee", PASSWORD, OTHER_IP)).body, { ok: true, already: true });
    assert.equal((await auditRows()).length, 7);

    // No row anywhere carries a password: not the right one, not a guess.
    const everything = JSON.stringify(await auditRows());
    assert.doesNotMatch(everything, /Train!Me|wrong-/, "no password in the audit rows");
    assert.doesNotMatch(
      JSON.stringify(
        (await pool().query("SELECT * FROM training_assignments WHERE id = $1", [assignmentId])).rows
      ),
      /Train!Me|wrong-/,
      "nor on the assignment row"
    );
  });
});
