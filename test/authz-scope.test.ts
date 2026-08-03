// The scope semantics the 1.0 port rests on.
//
// holds / spacesWith / holdsAnywhere / admits are pure over a resolved Grants,
// so they are testable without a database — and they are worth testing
// directly, because after 1.0 they are what decides every draft-visibility and
// publish question in the product. The subtle one is `admits`: a space-scoped
// permission asked WITHOUT a space is deliberately admitted when held in any
// space, with narrowing left to the caller's SpaceScope. That asymmetry is easy
// to "tidy up" into a security change, so it is pinned here with the reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { holds, spacesWith, holdsAnywhere, admits, type Grants } from "../src/lib/authz";
import type { PermissionKey } from "../src/lib/permissions";
import { permission } from "../src/lib/permissions";

// Two real keys with different scopes, asserted rather than assumed — if the
// catalog ever reclassifies one, these tests should say so loudly instead of
// silently testing the wrong thing.
const SPACE_KEY = "document.read_draft" satisfies PermissionKey;
const GLOBAL_KEY = "user.update_role" satisfies PermissionKey;

test("the catalog still classifies the keys these tests rely on", () => {
  assert.equal(permission(SPACE_KEY).scope, "space");
  assert.equal(permission(GLOBAL_KEY).scope, "global");
});

function grants(global: PermissionKey[], perSpace: [PermissionKey, number[]][] = []): Grants {
  return {
    userId: 1,
    global: new Set(global),
    perSpace: new Map(perSpace.map(([k, ids]) => [k, new Set(ids)])),
  };
}

const nobody = grants([]);
const globally = grants([SPACE_KEY]);
const inSpaceTwo = grants([], [[SPACE_KEY, [2]]]);

test("holds: a global grant applies in every space, and with no space named", () => {
  assert.equal(holds(globally, SPACE_KEY), true);
  assert.equal(holds(globally, SPACE_KEY, 2), true);
  assert.equal(holds(globally, SPACE_KEY, 999), true);
});

test("holds: a space grant applies in that space and nowhere else", () => {
  assert.equal(holds(inSpaceTwo, SPACE_KEY, 2), true);
  assert.equal(holds(inSpaceTwo, SPACE_KEY, 3), false);
  // Asked without a space, a purely space-scoped grant is not a yes. This is
  // what stops a scoped grant leaking into an unscoped check by accident.
  assert.equal(holds(inSpaceTwo, SPACE_KEY), false);
});

test("holds: no grant is never a yes", () => {
  assert.equal(holds(nobody, SPACE_KEY), false);
  assert.equal(holds(nobody, SPACE_KEY, 2), false);
});

test("spacesWith: global reads as everywhere, scoped as a list", () => {
  assert.equal(spacesWith(globally, SPACE_KEY), "all");
  assert.deepEqual(spacesWith(inSpaceTwo, SPACE_KEY), [2]);
  assert.deepEqual(spacesWith(nobody, SPACE_KEY), []);
  assert.deepEqual(spacesWith(grants([], [[SPACE_KEY, [5, 9]]]), SPACE_KEY).sort(), [5, 9]);
});

test("holdsAnywhere: true for global or any single space", () => {
  assert.equal(holdsAnywhere(globally, SPACE_KEY), true);
  assert.equal(holdsAnywhere(inSpaceTwo, SPACE_KEY), true);
  assert.equal(holdsAnywhere(nobody, SPACE_KEY), false);
  // An empty set is not a grant — this is the shape a revoked last assignment
  // can leave behind if the map entry outlives its contents.
  assert.equal(holdsAnywhere(grants([], [[SPACE_KEY, []]]), SPACE_KEY), false);
});

test("admits: with a space named, it is exactly holds()", () => {
  assert.equal(admits(inSpaceTwo, SPACE_KEY, 2), true);
  assert.equal(admits(inSpaceTwo, SPACE_KEY, 3), false);
  assert.equal(admits(globally, SPACE_KEY, 3), true);
});

test("admits: a space-scoped key with no space named admits a holder anywhere", () => {
  // Deliberate. A guard runs before the route knows its space; narrowing is the
  // caller's SpaceScope / canEditSpace check, which is where per-space filtering
  // has always happened. Tightening this to false would break every guard that
  // cannot know its space yet — and widening callers that DO know their space to
  // omit it would be the real bug.
  assert.equal(admits(inSpaceTwo, SPACE_KEY), true);
  assert.equal(admits(nobody, SPACE_KEY), false);
});

test("admits: a global-scoped key with no space named is NOT satisfied by a space grant", () => {
  // The asymmetry that matters. `user.update_role` is global; holding it on one
  // space must never admit an unscoped global check, or a space-scoped role
  // assignment would become a workspace-wide one.
  const scopedGlobalKey = grants([], [[GLOBAL_KEY, [2]]]);
  assert.equal(admits(scopedGlobalKey, GLOBAL_KEY), false);
  assert.equal(admits(grants([GLOBAL_KEY]), GLOBAL_KEY), true);
});

test("grants for one permission say nothing about another", () => {
  const g = grants([GLOBAL_KEY], [[SPACE_KEY, [2]]]);
  assert.equal(holds(g, GLOBAL_KEY), true);
  assert.equal(holds(g, SPACE_KEY, 2), true);
  assert.equal(holds(g, SPACE_KEY, 4), false);
  assert.equal(holds(g, "document.publish", 2), false);
  assert.equal(holdsAnywhere(g, "document.publish"), false);
});
