// The admin preview's scripted sign-in (1.16.0, lib/sign-in-demo): the real
// SignInFlow steps run against these answers on /login/preview, so nothing
// typed there is ever sent. The answers use the workspace's own providers
// (the demo pair when it has none). The rules (spec §7.11):
//   identifier *@sso.example   → the first provider alone
//   identifier *@both.example  → every provider (a choice only with two)
//   any other identifier       → the password step, or with SSO only on
//                                every provider (the real lookup's rule 2)
//   password "wrong"           → Invalid username or password.
//   password "locked"          → the lockout sentence
//   password "2fa"             → a code step; 123456 signs in
//   any other password         → signed in
// No database: the routing's rule 2 is compared on configs built here.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/sign-in-demo.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_PROVIDERS, demoLogin, demoLookup, demoTransport } from "../src/lib/sign-in-demo";
import { providerStart, providersOf, routeByConfig, setupFrom } from "../src/lib/sign-in-routing";
import type { SignInProviderLink } from "../src/lib/sign-in-transport";
import type { SsoConfig } from "../src/lib/sso-config";
import type { SamlConfig } from "../src/lib/saml-config";

const SSO: SsoConfig = {
  enabled: true,
  tenant: "11111111-2222-3333-4444-555555555555",
  clientId: "client",
  clientSecret: "secret",
  authority: "",
  autoProvision: true,
  defaultRole: "viewer",
  allowedDomains: [],
  ssoOnly: false,
  vendor: "microsoft",
};
const SAML: SamlConfig = {
  enabled: true,
  idpSsoUrl: "https://idp.example.test/sso",
  idpIssuer: "https://idp.example.test",
  idpCert: "MIIBdummy",
  autoProvision: true,
  defaultRole: "viewer",
  allowedDomains: [],
  buttonLabel: "Sign in with Okta",
};

/** A workspace's setup and the providers its preview gets, started as /login starts them. */
function workspace(oidc: Partial<SsoConfig> | null, saml: boolean, ssoOnly: boolean) {
  const setup = setupFrom({ ...SSO, ...(oidc ?? { enabled: false }), ssoOnly }, { ...SAML, enabled: saml });
  const providers: SignInProviderLink[] = providersOf(setup).map((p) => ({ ...p, start: providerStart(p.id, "/") }));
  return { setup, providers };
}

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
      assert.deepEqual(demoLookup(id, { ssoOnly: false }), { kind: "password" }, id);
    }
  });

  test("SSO only: every other identifier gets both providers, never the password step", () => {
    for (const id of ["jane", "jane@acme.example", "x@both.example", "admin", ""]) {
      assert.deepEqual(demoLookup(id, { ssoOnly: true }), { kind: "sso", providers: DEMO_PROVIDERS }, id);
    }
    // The scripted single provider still shows the redirect step.
    assert.deepEqual(demoLookup("x@sso.example", { ssoOnly: true }), { kind: "sso", providers: [DEMO_PROVIDERS[0]] });
  });

  test("an empty provider list is the demo pair", () => {
    assert.deepEqual(demoLookup("x@both.example", { providers: [] }), { kind: "sso", providers: DEMO_PROVIDERS });
    assert.deepEqual(demoLookup("jane", { ssoOnly: true, providers: [] }), { kind: "sso", providers: DEMO_PROVIDERS });
  });
});

describe("demoLookup with the workspace's own providers", () => {
  test("one provider (Google): sso.example and both.example go to it alone, never a choice or a SAML option", () => {
    const { providers } = workspace({ vendor: "google" }, false, false);
    assert.deepEqual(providers.map((p) => [p.id, p.label]), [["oidc", "Sign in with Google"]]);
    for (const id of ["x@sso.example", "x@both.example"]) {
      assert.deepEqual(demoLookup(id, { providers }), { kind: "sso", providers }, id);
    }
    assert.deepEqual(demoLookup("jane", { providers }), { kind: "password" });
  });

  test("two providers: sso.example the first, both.example the choice of both, with /login's starts", () => {
    const { providers } = workspace({}, true, false);
    assert.deepEqual(providers.map((p) => p.start), ["/api/ee/sso/login", "/api/ee/saml/login"]);
    assert.deepEqual(demoLookup("x@sso.example", { providers }), { kind: "sso", providers: [providers[0]] });
    assert.deepEqual(demoLookup("x@both.example", { providers }), { kind: "sso", providers });
    assert.deepEqual(demoLookup("jane@acme.example", { providers }), { kind: "password" });
  });

  test("SSO only follows rule 2 as /login does: one provider goes straight there, two are a choice", () => {
    for (const [name, oidc, saml] of [
      ["Microsoft only", {}, false],
      ["Google only", { vendor: "google" as const }, false],
      ["SAML only", null, true],
      ["both", {}, true],
    ] as const) {
      const { setup, providers } = workspace(oidc, saml, true);
      assert.equal(setup.ssoOnly, true, name);
      for (const id of ["jane", "jane@acme.example", "admin"]) {
        const real = routeByConfig(id, setup);
        assert.ok(real?.step === "sso", `${name}: ${id}`);
        const demo = demoLookup(id, { ssoOnly: setup.ssoOnly, providers });
        assert.ok(demo.kind === "sso", `${name}: ${id}`);
        assert.deepEqual(demo.providers.map((p) => p.id), real.providers, `${name}: ${id}`);
        assert.deepEqual(demo.providers, providers, `${name}: ${id}`);
      }
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

  test("with SSO only, the lookup follows it", async () => {
    const t = demoTransport(() => {}, { ssoOnly: true });
    assert.deepEqual(await t.lookup("jane", "/", new AbortController().signal), { kind: "sso", providers: DEMO_PROVIDERS });
    const off = demoTransport(() => {}, { ssoOnly: false });
    assert.deepEqual(await off.lookup("jane", "/", new AbortController().signal), { kind: "password" });
  });

  test("with the workspace's providers, the lookup answers with them", async () => {
    const { providers } = workspace({}, false, true);
    const t = demoTransport(() => {}, { ssoOnly: true, providers });
    assert.deepEqual(await t.lookup("jane", "/", new AbortController().signal), { kind: "sso", providers });
    assert.equal(providers.length, 1, "one provider: the redirect step, no choice");
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
