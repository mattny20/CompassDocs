// The typed signature (C2, 1.12.0): lib/attestation's verifyAttestation,
// shared by the read confirmation route and the training deck. The name is
// compared whitespace-collapsed and case-insensitively against the account's
// display name (its username when it has none); a local account re-enters
// its password, which is checked behind the sign-in throttle; an SSO account
// is identified by its session; and the result never carries the password
// or the typed name, so a caller can log it as it is.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/attestation.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, getSetting } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";
import { verifyAttestation, nameKey, signedNameFrom, SIGNED_NAME_MAX } from "../src/lib/attestation";
import { loginRetryAfter, recordLoginFailure } from "../src/lib/login-guard";
import { fixtureQuery } from "./support/retry";

const STAMP = `attest-${Date.now()}`;
const PASSWORD = "Sign!Me12345";
const userIds: number[] = [];

interface Account {
  id: number;
  username: string;
  name: string;
}

/** A user row shaped like the sign-up paths write it: a local account with a hash, or an SSO identity without one. */
async function newUser(tag: string, name: string, opts: { password?: string; provider?: string } = {}): Promise<Account> {
  const creds = opts.password ? hashPassword(opts.password) : { hash: null, salt: null };
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, password_hash, password_salt, auth_provider, external_id)
     VALUES ($1, $2, $3, 'viewer', 'active', $4, $5, $6, $7) RETURNING id, username, name`,
    [
      `${STAMP}-${tag}`,
      name,
      `${STAMP}-${tag}@example.test`,
      creds.hash,
      creds.salt,
      opts.provider ?? "local",
      opts.provider && opts.provider !== "local" ? `${STAMP}-${tag}` : null,
    ]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0];
}

before(async () => {
  await getSetting("__schema_bootstrap__");
});

after(async () => {
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
});

describe("the name rule", () => {
  test("nameKey collapses whitespace and case; signedNameFrom trims, bounds and refuses non-text", () => {
    assert.equal(nameKey("  Dana   Whitfield "), "dana whitfield");
    assert.equal(nameKey("DANA\tWHITFIELD"), "dana whitfield");
    assert.equal(signedNameFrom("  Dana Whitfield  "), "Dana Whitfield");
    assert.equal(signedNameFrom("x".repeat(SIGNED_NAME_MAX + 50)).length, SIGNED_NAME_MAX);
    assert.equal(signedNameFrom(undefined), "");
    assert.equal(signedNameFrom(42), "");
    assert.equal(signedNameFrom(null), "");
  });

  test("the typed name must match the account's display name under nameKey; an account without a name is matched by its username", async () => {
    const dana = await newUser("name", "Dana Whitfield", { password: PASSWORD });
    const ip = { ip: "203.0.113.11" };

    const missing = await verifyAttestation(dana, { password: PASSWORD }, ip);
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.status, 409);
      assert.equal(missing.code, "name");
      assert.equal(missing.error, "Type your full name exactly as it appears on your account (Dana Whitfield).");
    }
    const other = await verifyAttestation(dana, { signed_name: "Dana Whitfeld", password: PASSWORD }, ip);
    assert.equal(other.ok, false, "a near miss is a miss");
    if (!other.ok) assert.equal(other.code, "name");

    for (const typed of ["Dana Whitfield", "  dana   whitfield ", "DANA WHITFIELD"]) {
      const r = await verifyAttestation(dana, { signed_name: typed, password: PASSWORD }, ip);
      assert.equal(r.ok, true, `${JSON.stringify(typed)} matches`);
    }

    const nameless = await newUser("nameless", "", { password: PASSWORD });
    const byUsername = await verifyAttestation(nameless, { signed_name: nameless.username.toUpperCase(), password: PASSWORD }, ip);
    assert.equal(byUsername.ok, true, "the username stands in for a missing name");
    const wrongForNameless = await verifyAttestation(nameless, { signed_name: "Somebody", password: PASSWORD }, ip);
    assert.equal(wrongForNameless.ok, false);
    if (!wrongForNameless.ok) assert.match(wrongForNameless.error, new RegExp(`\\(${nameless.username}\\)`));
  });
});

describe("local and SSO accounts", () => {
  test("a local account re-enters its password: wrong is 409, right is identity_proof 'password', and the result never carries the password", async () => {
    const local = await newUser("local", "Priya Nair", { password: PASSWORD });
    const ip = { ip: "203.0.113.12" };

    const wrong = await verifyAttestation(local, { signed_name: "Priya Nair", password: "not-the-password" }, ip);
    assert.equal(wrong.ok, false);
    if (!wrong.ok) {
      assert.equal(wrong.status, 409);
      assert.equal(wrong.code, "password");
      assert.equal(wrong.error, "Password check failed. Re-enter your account password to sign.");
    }
    assert.doesNotMatch(JSON.stringify(wrong), /not-the-password/, "the refusal never echoes the input");

    const empty = await verifyAttestation(local, { signed_name: "Priya Nair" }, ip);
    assert.equal(empty.ok, false, "no password is a wrong password");
    if (!empty.ok) assert.equal(empty.code, "password");

    const right = await verifyAttestation(local, { signed_name: "Priya Nair", password: PASSWORD }, ip);
    assert.deepEqual(right, { ok: true, identity_proof: "password" });
    assert.doesNotMatch(JSON.stringify(right), new RegExp(PASSWORD.replace(/[!]/g, "\\$&")), "the result never carries the password");
    assert.doesNotMatch(JSON.stringify(right), /Priya/, "nor the typed name");

    // A non-string password is treated as absent, never coerced.
    const coerced = await verifyAttestation(local, { signed_name: "Priya Nair", password: { toString: () => PASSWORD } }, ip);
    assert.equal(coerced.ok, false);
  });

  test("an SSO account signs with its name alone and is identified by its session; a local account without a hash is the typed name only", async () => {
    const sso = await newUser("sso", "Alex Chen", { provider: "saml" });
    const viaSession = await verifyAttestation(sso, { signed_name: "alex chen" }, { ip: "203.0.113.13" });
    assert.deepEqual(viaSession, { ok: true, identity_proof: "sso_session" });
    const withStrayPassword = await verifyAttestation(sso, { signed_name: "Alex Chen", password: "anything" }, { ip: "203.0.113.13" });
    assert.deepEqual(withStrayPassword, { ok: true, identity_proof: "sso_session" }, "nothing to check a password against");
    assert.doesNotMatch(JSON.stringify(withStrayPassword), /anything/);

    const bare = await newUser("bare", "Sam Local");
    const typedOnly = await verifyAttestation(bare, { signed_name: "Sam Local" }, { ip: "203.0.113.13" });
    assert.deepEqual(typedOnly, { ok: true, identity_proof: "typed_name_only" });
  });

  test("the password branch sits behind the sign-in throttle: five wrong passwords lock the username and address (the fifth says so), and the lock refuses the right one too", async () => {
    const user = await newUser("locked", "Lock Smith", { password: PASSWORD });
    // An address of this test's own: the throttle is keyed on username+IP
    // (the pair only: the signature never feeds the sign-in form's per-IP
    // spray counter), so nothing here can lock another test's pair.
    const ip = { ip: "203.0.113.14" };
    for (let i = 0; i < 5; i++) {
      const r = await verifyAttestation(user, { signed_name: "Lock Smith", password: `wrong-${i}` }, ip);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.status, 409, `attempt ${i + 1} is a plain refusal`);
        assert.equal(r.lock_engaged, i === 4, `attempt ${i + 1}: only the fifth failure engages the lock`);
      }
    }
    const locked = await verifyAttestation(user, { signed_name: "Lock Smith", password: PASSWORD }, ip);
    assert.equal(locked.ok, false, "the right password is refused while the lock holds");
    if (!locked.ok) {
      assert.equal(locked.status, 429);
      assert.equal(locked.code, "locked");
      assert.equal(locked.lock_engaged, false, "a refusal under the lock did not engage it");
      assert.match(locked.error, /^Too many failed attempts\. Try again in \d+ minutes?\.$/);
    }
    // The sign-in form reads the same pair: the lock holds there too.
    assert.ok(loginRetryAfter(user.username, ip.ip) > 0, "the sign-in form is locked for the same pair");
    // Another address for the same account is a different pair: not locked.
    const elsewhere = await verifyAttestation(user, { signed_name: "Lock Smith", password: PASSWORD }, { ip: "203.0.113.15" });
    assert.equal(elsewhere.ok, true);
    // A wrong name is not a password guess: it never counts and never engages anything.
    const wrongName = await verifyAttestation(user, { signed_name: "Someone Else", password: PASSWORD }, { ip: "203.0.113.16" });
    assert.equal(wrongName.ok, false);
    if (!wrongName.ok) assert.deepEqual([wrongName.code, wrongName.lock_engaged], ["name", false]);
  });

  test("the throttle counts the username+IP pair only: after one account's five failures, another account on the same address still signs, and the address is not locked for sign-in", async () => {
    const first = await newUser("pair-a", "Pair Alpha", { password: PASSWORD });
    const second = await newUser("pair-b", "Pair Beta", { password: PASSWORD });
    // One shared address, as an office behind one NAT signs a policy.
    const ip = "203.0.113.17";
    for (let i = 0; i < 5; i++) {
      const r = await verifyAttestation(first, { signed_name: "Pair Alpha", password: `wrong-${i}` }, { ip });
      assert.equal(r.ok, false);
    }
    const alphaLocked = await verifyAttestation(first, { signed_name: "Pair Alpha", password: PASSWORD }, { ip });
    assert.equal(alphaLocked.ok, false, "the first account's pair is locked");
    if (!alphaLocked.ok) assert.equal(alphaLocked.status, 429);

    const beta = await verifyAttestation(second, { signed_name: "Pair Beta", password: PASSWORD }, { ip });
    assert.deepEqual(beta, { ok: true, identity_proof: "password" }, "the second account on the same address signs");
    // One below the 30 spray limit from the sign-in side: any typed-signature
    // miss that had counted against the address would lock it now.
    for (let i = 0; i < 29; i++) recordLoginFailure(`pair-spray-${i}`, ip);
    assert.equal(loginRetryAfter(second.username, ip), 0, "and can sign in: the address itself was never counted");
    assert.ok(loginRetryAfter(first.username, ip) > 0, "while the first account's pair stays locked");
  });
});
