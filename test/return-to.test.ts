// The post-sign-in return path is attacker-controllable (it rides in the
// URL), so every sign-in path reduces it through one function (1.9.4,
// lib/return-to). These are the cases that must never redirect off-site,
// loop, or hit an endpoint on the user's behalf — and the ones that must
// keep working, the OAuth consent bounce above all.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/return-to.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { loginHref, safeReturnPath, withReturnPath } from "../src/lib/return-to";

test("same-app paths pass through, with their query and hash", () => {
  assert.equal(safeReturnPath("/doc/42"), "/doc/42");
  assert.equal(safeReturnPath("/search?q=hello%20world&type=sop"), "/search?q=hello%20world&type=sop");
  assert.equal(safeReturnPath("/search?q=hello+world"), "/search?q=hello+world");
  assert.equal(safeReturnPath("/doc/42#first-section"), "/doc/42#first-section");
  assert.equal(safeReturnPath("/"), "/");
  assert.equal(safeReturnPath("  /directory  "), "/directory");
  // The consent page an MCP client bounces through sign-in to reach.
  assert.equal(
    safeReturnPath("/oauth/authorize?client_id=c&redirect_uri=r&code_challenge=x"),
    "/oauth/authorize?client_id=c&redirect_uri=r&code_challenge=x"
  );
});

test("the result is header-safe: dot segments resolved, non-ASCII percent-encoded", () => {
  assert.equal(safeReturnPath("/doc/42/../43"), "/doc/43");
  assert.equal(safeReturnPath("/doc/42?q=日本"), "/doc/42?q=%E6%97%A5%E6%9C%AC");
  assert.equal(safeReturnPath("/spaces/café"), "/spaces/caf%C3%A9");
});

test("anything that could leave the app falls back to the dashboard", () => {
  for (const bad of [
    "https://evil.example/phish",
    "http://evil.example",
    "//evil.example/doc/1",
    "/\\evil.example",
    "/\\\\evil.example",
    "/..//evil.example",
    "/.//evil.example",
    "/%2e%2e//evil.example",
    "/a/..//evil.example/doc/1?x=1",
    "/%5C%5Cevil.example/x".replace(/%5C/g, "\\"),
    "javascript:alert(1)",
    "evil.example",
    "doc/1",
    "",
    "   ",
    null,
    undefined,
    "/doc/1\r\nSet-Cookie: x=y",
    "/doc/1\u0000",
    `/${"a".repeat(2001)}`,
  ]) {
    assert.equal(safeReturnPath(bad), "/", `rejects ${JSON.stringify(bad)}`);
  }
});

test("the sign-in page, API routes and the setup wizard are never a destination, however spelled", () => {
  for (const bad of [
    "/login",
    "/login?next=/doc/1",
    "/LOGIN",
    "/login/",
    "/api/auth/logout",
    "/api/documents/1",
    "/api",
    "/setup",
    "/logout",
    "/account/password",
    "/account/password?next=%2Fdoc%2F1",
    "/doc/../api/documents/1",
    "/doc/%2e%2e/login",
    "/%61pi/export",
    "/%6Cogin",
    "/api%2Fexport",
  ]) {
    assert.equal(safeReturnPath(bad), "/", `rejects ${bad}`);
  }
  // A page whose name merely starts with those letters is fine.
  assert.equal(safeReturnPath("/loginwall"), "/loginwall");
  assert.equal(safeReturnPath("/apis"), "/apis");
  assert.equal(safeReturnPath("/account/security"), "/account/security");
  // A malformed escape is not a page either.
  assert.equal(safeReturnPath("/doc/%E0%A4%A"), "/");
});

test("the result is a fixed point: sanitising it again changes nothing", () => {
  // "/..\\evil.example" is a backslash the parser reads as "/", so it is the
  // on-site path "/evil.example" — allowed, and it must stay on-site.
  for (const raw of ["/..\\evil.example", "/doc/42", "/search?q=hello%20world", "/doc/42/../43", "/doc/42?q=日本", "/spaces/caf\u00e9", "/a/..//x", "/..//evil.example", "/oauth/authorize?client_id=c"]) {
    const once = safeReturnPath(raw);
    assert.equal(safeReturnPath(once), once, `fixed point for ${raw}`);
    assert.equal(new URL(once, "https://compass.example/login").origin, "https://compass.example", `stays on-site for ${raw}`);
  }
});

test("a custom fallback is honoured", () => {
  assert.equal(safeReturnPath("https://evil.example", "/account"), "/account");
});

test("loginHref and withReturnPath only add next for a page worth returning to", () => {
  assert.equal(loginHref("/doc/42?x=1"), "/login?next=%2Fdoc%2F42%3Fx%3D1");
  assert.equal(loginHref("/"), "/login");
  assert.equal(loginHref("https://evil.example"), "/login");
  assert.equal(loginHref(undefined), "/login");
  assert.equal(withReturnPath("/api/ee/sso/login", "/doc/42"), "/api/ee/sso/login?next=%2Fdoc%2F42");
  assert.equal(withReturnPath("/api/ee/saml/login?a=b", "/doc/42"), "/api/ee/saml/login?a=b&next=%2Fdoc%2F42");
  assert.equal(withReturnPath("/api/ee/sso/login", "/"), "/api/ee/sso/login");
  assert.equal(withReturnPath("/api/ee/sso/login", "//evil.example"), "/api/ee/sso/login");
});
