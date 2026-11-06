// 1.19.1: an Enterprise licence includes the helpdesk even when its key
// predates it (keys issued before 1.19 don't list "helpdesk").
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveFeatures } from "../src/lib/license";

test("an Enterprise key without helpdesk still grants it", () => {
  const f = effectiveFeatures({ plan: "enterprise", features: ["sso", "scim", "policy_ack"] });
  assert.ok(f.includes("helpdesk"));
  assert.ok(f.includes("sso") && f.includes("scim") && f.includes("policy_ack"));
});

test("plan names are matched without case or spaces", () => {
  assert.ok(effectiveFeatures({ plan: " Enterprise ", features: [] }).includes("helpdesk"));
});

test("a key that already lists helpdesk lists it once", () => {
  const f = effectiveFeatures({ plan: "enterprise", features: ["helpdesk", "sso"] });
  assert.equal(f.filter((x) => x === "helpdesk").length, 1);
});

test("other plans get only what the key lists", () => {
  assert.deepEqual(effectiveFeatures({ plan: "sso-addon", features: ["sso"] }), ["sso"]);
  assert.deepEqual(effectiveFeatures({ plan: "", features: [] }), []);
});
