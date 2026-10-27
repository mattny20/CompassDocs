// The ?sso_error sentence on /login (1.16.0, lib/sso-error). Only the
// table's own codes count: a crafted link naming an Object.prototype member
// ("constructor", "__proto__") once handed a function to the client
// component and the page answered 500. Pure, so no database.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/sso-error.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ssoErrorMessage } from "../src/lib/sso-error";

const INTERNAL = "Something went wrong during sign-in. Please try again.";

describe("ssoErrorMessage", () => {
  test("no code is no banner", () => {
    assert.equal(ssoErrorMessage(undefined), undefined);
    assert.equal(ssoErrorMessage(""), undefined);
  });

  test("a known code is its sentence", () => {
    assert.equal(ssoErrorMessage("domain"), "Your email domain isn't allowed to sign in here.");
    assert.equal(ssoErrorMessage("idp"), "Your identity provider reported an error. Please try again.");
    assert.equal(ssoErrorMessage("internal"), INTERNAL);
  });

  test("each refused link has its own sentence, and none tells the admin to confirm an email", () => {
    const sentences: Record<string, string> = {
      link_unconfirmed:
        "An account here already uses your email address, but the address hasn't been confirmed as yours, so single sign-on can't link to it. Ask your administrator to check which account uses your address.",
      link_ambiguous:
        "More than one account here uses your email address, so single sign-on can't tell which one is yours. Ask your administrator.",
      link_admin:
        "Your email address belongs to an administrator account, and single sign-on never links administrator accounts. Sign in with your username and password instead (at /login?local=1 when single sign-on is required).",
      link_other_provider:
        "Your email address belongs to an account that signs in with a different identity provider. Ask your administrator.",
      // The generic one an older overlay sends for every cause.
      link_denied:
        "An account with your email already exists and can't be linked to single sign-on automatically. Ask your administrator.",
    };
    for (const [code, sentence] of Object.entries(sentences)) {
      assert.equal(ssoErrorMessage(code), sentence, code);
      assert.doesNotMatch(sentence, /confirm the email|Email…/, code);
      // Nothing in the product links an existing account to SSO by hand.
      assert.doesNotMatch(sentence, /has to link|must link/, code);
    }
  });

  test("an unknown code is the internal sentence", () => {
    for (const code of ["bogus", "DOMAIN", " domain", "domain "]) {
      assert.equal(ssoErrorMessage(code), INTERNAL, code);
    }
  });

  test("Object.prototype's members are unknown codes, always a string", () => {
    for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "__defineGetter__"]) {
      const m = ssoErrorMessage(code);
      assert.equal(typeof m, "string", code);
      assert.equal(m, INTERNAL, code);
    }
  });

  test("a repeated parameter (an array) is the internal sentence", () => {
    assert.equal(ssoErrorMessage(["domain", "idp"]), INTERNAL);
    assert.equal(ssoErrorMessage(["constructor"]), INTERNAL);
  });
});
