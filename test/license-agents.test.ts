// Helpdesk agent allowances: how a licence's `agents` claim reads.
//   absent → unlimited (keys minted before allowances; existing customers)
//   -1     → unlimited (the explicit sentinel)
//   n > 0  → n
//   anything else is invalid and reads as the 3 included agents, never as
//   unlimited (a broken mint must not fail open).
// The allowance in force is the claim only while the licence is active: in
// grace, and with no, an invalid or an expired licence, nothing is limited.
//
// Pure functions only: no token is signed here, so the suite holds whichever
// public key license.ts carries.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/license-agents.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  agentAllowanceFor,
  agentLimitFor,
  agentsClaim,
  BUY_AGENTS_URL,
  effectiveFeatures,
  INCLUDED_AGENTS,
  type License,
  type LicenseState,
} from "../src/lib/license";

function lic(extra: Record<string, unknown> = {}): License {
  return {
    id: "lic_test",
    customer: "Test Co",
    plan: "enterprise",
    features: ["sso"],
    seats: 0,
    issued: "2026-01-01",
    expires: "2027-01-01",
    ...extra,
  } as License;
}

describe("agentsClaim", () => {
  test("absent reads as unlimited (keys minted before agent allowances)", () => {
    assert.equal(agentsClaim(lic()), null);
    assert.equal(agentsClaim(lic({ agents: undefined })), null);
  });

  test("-1 reads as unlimited", () => {
    assert.equal(agentsClaim(lic({ agents: -1 })), null);
  });

  test("a positive integer is the allowance", () => {
    assert.equal(agentsClaim(lic({ agents: 3 })), 3);
    assert.equal(agentsClaim(lic({ agents: 1 })), 1);
    assert.equal(agentsClaim(lic({ agents: 28 })), 28);
  });

  test("invalid values read as the 3 included agents, never unlimited", () => {
    assert.equal(INCLUDED_AGENTS, 3);
    for (const agents of [0, -0, -2, -100, 2.5, 0.5, NaN, Infinity, -Infinity, Number.MAX_VALUE, "5", "unlimited", "", null, true, false, {}, [], [5]]) {
      assert.equal(agentsClaim(lic({ agents })), 3, `agents: ${JSON.stringify(agents) ?? String(agents)}`);
    }
  });

  test("claims arrive as JSON: a parsed payload reads the same way", () => {
    const parsed = (json: string) => JSON.parse(json) as License;
    assert.equal(agentsClaim(parsed('{"customer":"x","features":[],"expires":"2027-01-01"}')), null);
    assert.equal(agentsClaim(parsed('{"customer":"x","features":[],"expires":"2027-01-01","agents":-1}')), null);
    assert.equal(agentsClaim(parsed('{"customer":"x","features":[],"expires":"2027-01-01","agents":7}')), 7);
    assert.equal(agentsClaim(parsed('{"customer":"x","features":[],"expires":"2027-01-01","agents":0}')), 3);
    assert.equal(agentsClaim(parsed('{"customer":"x","features":[],"expires":"2027-01-01","agents":null}')), 3);
  });

  test("the claim is independent of the plan and leaves ENTERPRISE_IMPLIES alone", () => {
    assert.equal(agentsClaim(lic({ plan: "cloud" })), null, "cloud keys carry no claim: unlimited");
    assert.equal(agentsClaim(lic({ plan: "cloud", agents: 5 })), 5);
    const l = lic({ agents: 3 });
    assert.ok(effectiveFeatures(l).includes("helpdesk"), "an Enterprise key with an allowance still grants the helpdesk");
  });
});

describe("agentAllowanceFor (the allowance in force)", () => {
  test("active: the claim", () => {
    assert.equal(agentAllowanceFor({ status: "active", license: lic({ agents: 5 }), daysLeft: 100 }), 5);
    assert.equal(agentAllowanceFor({ status: "active", license: lic({ agents: 0 }), daysLeft: 100 }), 3);
    assert.equal(agentAllowanceFor({ status: "active", license: lic(), daysLeft: 100 }), null);
    assert.equal(agentAllowanceFor({ status: "active", license: lic({ agents: -1 }), daysLeft: 100 }), null);
  });

  test("grace: unlimited, whatever the claim", () => {
    assert.equal(agentAllowanceFor({ status: "grace", license: lic({ agents: 3 }), daysLeft: 5 }), null);
    assert.equal(agentAllowanceFor({ status: "grace", license: lic({ agents: 0 }), daysLeft: 5 }), null);
  });

  test("no licence, an invalid one or an expired one: unlimited (the helpdesk is off anyway)", () => {
    const states: LicenseState[] = [
      { status: "none" },
      { status: "invalid", reason: "Malformed license." },
      { status: "expired", license: lic({ agents: 3 }) },
    ];
    for (const s of states) assert.equal(agentAllowanceFor(s), null, s.status);
  });
});

describe("agentLimitFor (enforced, and the key's own number)", () => {
  test("active: both are the claim", () => {
    assert.deepEqual(agentLimitFor({ status: "active", license: lic({ agents: 5 }), daysLeft: 100 }), { allowed: 5, licensed: 5 });
    assert.deepEqual(agentLimitFor({ status: "active", license: lic(), daysLeft: 100 }), { allowed: null, licensed: null });
  });

  test("grace: nothing enforced, the key's number still read", () => {
    assert.deepEqual(agentLimitFor({ status: "grace", license: lic({ agents: 3 }), daysLeft: 5 }), { allowed: null, licensed: 3 });
    assert.deepEqual(agentLimitFor({ status: "grace", license: lic({ agents: 0 }), daysLeft: 5 }), { allowed: null, licensed: 3 });
  });

  test("no licence or an invalid one: neither", () => {
    assert.deepEqual(agentLimitFor({ status: "none" }), { allowed: null, licensed: null });
    assert.deepEqual(agentLimitFor({ status: "invalid", reason: "x" }), { allowed: null, licensed: null });
  });
});

test("the purchase link is the pricing page", () => {
  assert.equal(BUY_AGENTS_URL, "https://docs.compassdocs.io/admin/license/#helpdesk-agents");
});
