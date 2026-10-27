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
