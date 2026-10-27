// The admin preview's scripted sign-in (1.16.0, lib/sign-in-demo): the real
// SignInFlow steps run against these answers on /login/preview, so nothing
// typed there is ever sent. The rules (spec §7.11):
//   identifier *@sso.example   → one provider (Microsoft)
//   identifier *@both.example  → two providers
//   any other identifier       → the password step
//   password "wrong"           → Invalid username or password.
//   password "locked"          → the lockout sentence
//   password "2fa"             → a code step; 123456 signs in
//   any other password         → signed in
// Pure, so no database.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/sign-in-demo.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_PROVIDERS, demoLogin, demoLookup, demoTransport } from "../src/lib/sign-in-demo";

describe("the demo providers", () => {
  test("Microsoft first, then a second provider; every start is a same-origin /api/ee/ path", () => {
    assert.equal(DEMO_PROVIDERS.length, 2);
    assert.deepEqual(
      { id: DEMO_PROVIDERS[0].id, label: DEMO_PROVIDERS[0].label, mark: DEMO_PROVIDERS[0].mark },
      { id: "oidc", label: "Sign in with Microsoft", mark: "microsoft" }
    );
    assert.equal(DEMO_PROVIDERS[1].id, "saml");
    assert.notEqual(DEMO_PROVIDERS[1].label, DEMO_PROVIDERS[0].label);
    for (const p of DEMO_PROVIDERS) {
      // SignInFlow refuses any start outside /api/ee/ ("Single sign-on isn't available right now").
      assert.ok(p.start.startsWith("/api/ee/"), p.start);
      assert.doesNotMatch(p.start, /login_hint/, "the preview never carries a hint");
    }
  });
});

describe("demoLookup", () => {
  test("an address at sso.example goes to Microsoft alone", () => {
    const r = demoLookup("x@sso.example");
    assert.equal(r.kind, "sso");
    assert.ok(r.kind === "sso");
    assert.deepEqual(r.providers, [DEMO_PROVIDERS[0]]);
  });

  test("an address at both.example gets the choice of both providers", () => {
    const r = demoLookup("x@both.example");
    assert.ok(r.kind === "sso");
    assert.deepEqual(r.providers, DEMO_PROVIDERS);
  });

  test("case and surrounding spaces do not matter", () => {
    assert.equal(demoLookup("  Jane.Doe@SSO.Example ").kind, "sso");
    const both = demoLookup("JANE@BOTH.EXAMPLE");
    assert.ok(both.kind === "sso");
    assert.equal(both.providers.length, 2);
  });

  test("everything else is the password step: usernames, other domains, look-alikes", () => {
    for (const id of ["jane", "jane@acme.example", "x@sub.sso.example", "x@sso.example.com", "sso.example", "x@notsso.example", "x@both.examples", ""]) {
      assert.deepEqual(demoLookup(id), { kind: "password" }, id);
    }
  });
});

describe("demoLogin", () => {
  test("wrong is the server's 401 sentence", () => {
    assert.deepEqual(demoLogin({ password: "wrong" }), { kind: "invalid", error: "Invalid username or password." });
  });

  test("locked is the 429 sentence", () => {
    assert.deepEqual(demoLogin({ password: "locked" }), { kind: "limited", error: "Too many failed attempts. Try again in 15 minutes." });
  });

  test("2fa asks for a code, quietly the first time", () => {
    assert.deepEqual(demoLogin({ password: "2fa" }), { kind: "totp" });
    assert.deepEqual(demoLogin({ password: "2fa", totp_code: "" }), { kind: "totp" });
  });

  test("2fa with 123456 signs in (spaces in the code are ignored); any other code is refused and asked again", () => {
    assert.deepEqual(demoLogin({ password: "2fa", totp_code: "123456" }), { kind: "ok", mustChange: false });
    assert.deepEqual(demoLogin({ password: "2fa", totp_code: "123 456" }), { kind: "ok", mustChange: false });
    assert.deepEqual(demoLogin({ password: "2fa", totp_code: "000000" }), { kind: "totp", error: "That code didn't work — try again." });
    assert.deepEqual(demoLogin({ password: "2fa", totp_code: "abcd-efgh" }), { kind: "totp", error: "That code didn't work — try again." });
  });

  test("any other password signs in, never into a forced password change", () => {
    for (const password of ["hunter2", "Wrong", "LOCKED", "2FA", " wrong", "x"]) {
      assert.deepEqual(demoLogin({ password }), { kind: "ok", mustChange: false }, password);
    }
  });

  test("the password decides before any code: wrong with a code is still wrong", () => {
    assert.equal(demoLogin({ password: "wrong", totp_code: "123456" }).kind, "invalid");
    assert.equal(demoLogin({ password: "locked", totp_code: "123456" }).kind, "limited");
  });
});

describe("demoTransport", () => {
  test("lookup and login answer by the rules after a short, visible wait", async () => {
    const t = demoTransport(() => {});
    const started = Date.now();
    assert.deepEqual(await t.lookup("jane", "/", new AbortController().signal), { kind: "password" });
    assert.ok(Date.now() - started >= 300, "long enough for the 150ms spinner to show");
    const sso = await t.lookup("x@sso.example", "/doc/1", new AbortController().signal);
    assert.ok(sso.kind === "sso");
    assert.equal(sso.providers[0].start, DEMO_PROVIDERS[0].start, "next is not added to the demo starts");
    assert.deepEqual(await t.login({ username: "jane", password: "wrong" }, new AbortController().signal), {
      kind: "invalid",
      error: "Invalid username or password.",
    });
  });

  test("an abort (Change, or Use a password instead) rejects with an AbortError at once", async () => {
    const t = demoTransport(() => {});
    const ac = new AbortController();
    const started = Date.now();
    const pending = t.lookup("jane", "/", ac.signal);
    ac.abort();
    await assert.rejects(pending, (e: unknown) => e instanceof DOMException && e.name === "AbortError");
    assert.ok(Date.now() - started < 300, "it does not wait out the delay");

    const ac2 = new AbortController();
    const login = t.login({ username: "jane", password: "x" }, ac2.signal);
    ac2.abort();
    await assert.rejects(login, (e: unknown) => e instanceof DOMException && e.name === "AbortError");
  });

  test("navigate goes nowhere, and signedIn reports to the preview", () => {
    let signedIn = 0;
    const t = demoTransport(() => signedIn++);
    // No window here: a navigate that touched location would throw.
    assert.doesNotThrow(() => t.navigate("/api/ee/sso/login"));
    t.signedIn("/");
    t.signedIn("/account/password");
    assert.equal(signedIn, 2);
  });
});
