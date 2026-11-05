// The home dashboard's own queries (1.17.0, lib/dashboard-data and
// lib/dashboard-sections): which spaces a person follows (their own
// subscription, or an admin-assigned group they have not muted, inside
// their scope); Latest, newest first, narrowed to the followed spaces for
// the Following view, never outside the scope, never a draft unless asked,
// never a trashed document or a branch, and without the pick-up cards'
// documents; Popular this week, ranked by views over the last 7 days only;
// the status strip's per-service standing (the worse of the polled status
// and an open incident, problems first); and the per-person hidden
// sections (known keys only, in dashboard order).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/dashboard-data.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, getSetting } from "../src/lib/db";
import { asScope } from "../src/lib/space-scope";
import {
  listFollowedSpaceIds,
  listLatestDocuments,
  listPopularThisWeek,
  listStatusStrip,
} from "../src/lib/dashboard-data";
import {
  DASHBOARD_SECTIONS,
  getHiddenDashboardSections,
  setHiddenDashboardSections,
} from "../src/lib/dashboard-sections";
import { fixtureQuery } from "./support/retry";

const STAMP = `dashdata-${Date.now()}`;

let userId = 0;
let groupId = 0;
/** [own subscription, via group, via group but muted, not followed, out of scope] */
let spaces: number[] = [];
const docs: Record<string, number> = {};
const serviceIds: number[] = [];

async function doc(key: string, space: number, opts: { status?: string; ago?: string; deleted?: boolean; branchOf?: number } = {}) {
  const r = await fixtureQuery(
    `INSERT INTO documents (space_id, title, slug, type, status, author, updated_at, deleted_at, branch_of)
     VALUES ($1, $2, $3, 'knowledge', $4, 'Dash Author', now() - $5::interval, $6, $7) RETURNING id`,
    [
      space,
      `${STAMP} ${key}`,
      `${STAMP}-${key}`,
      opts.status ?? "published",
      opts.ago ?? "0 minutes",
      opts.deleted ? new Date().toISOString() : null,
      opts.branchOf ?? null,
    ]
  );
  docs[key] = r.rows[0].id;
  return docs[key];
}

async function views(documentId: number, n: number, ago = "1 day") {
  await fixtureQuery(
    `INSERT INTO doc_views (document_id, user_id, source, viewed_at)
     SELECT $1, NULL, 'app', now() - $3::interval FROM generate_series(1, $2)`,
    [documentId, n, ago]
  );
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const s = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility)
     SELECT $1 || ' ' || g, $1 || '-' || g, '📁', '', 'internal' FROM generate_series(1, 5) g RETURNING id`,
    [STAMP]
  );
  spaces = s.rows.map((r: { id: number }) => r.id).sort((a: number, b: number) => a - b);
  const u = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Dash Reader', $2, 'editor', 'active') RETURNING id`,
    [`${STAMP}-reader`, `${STAMP}@example.test`]
  );
  userId = u.rows[0].id;
  groupId = (await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} group`])).rows[0].id;
  await fixtureQuery("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, userId]);
  await fixtureQuery(
    "INSERT INTO space_subscription_groups (space_id, group_id) VALUES ($1, $3), ($2, $3)",
    [spaces[1], spaces[2], groupId]
  );
  await fixtureQuery(
    `INSERT INTO space_subscriptions (space_id, user_id, state) VALUES ($1, $3, 'subscribed'), ($2, $3, 'muted'), ($4, $3, 'subscribed')`,
    [spaces[0], spaces[2], userId, spaces[4]]
  );
});

after(async () => {
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [Object.values(docs)]);
  await pool().query("DELETE FROM status_services WHERE id = ANY($1)", [serviceIds]);
  await pool().query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool().query("DELETE FROM users WHERE id = $1", [userId]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [spaces]);
});

describe("listFollowedSpaceIds", () => {
  test("own subscriptions and unmuted group ones, inside the scope", async () => {
    const scope = asScope(spaces.slice(0, 4));
    assert.deepEqual(await listFollowedSpaceIds(userId, scope), [spaces[0], spaces[1]]);
    // "all" adds the subscribed space the narrower scope left out.
    const all = await listFollowedSpaceIds(userId, asScope("all"));
    assert.deepEqual(all.filter((id) => spaces.includes(id)), [spaces[0], spaces[1], spaces[4]]);
  });
});

describe("listLatestDocuments", () => {
  test("newest first, scoped, published only unless drafts are asked for, never trashed or a branch", async () => {
    const a = await doc("followed-new", spaces[0], { ago: "1 minute" });
    const b = await doc("group-older", spaces[1], { ago: "2 hours" });
    const c = await doc("unfollowed", spaces[3], { ago: "3 hours" });
    const draft = await doc("draft", spaces[0], { status: "draft", ago: "4 hours" });
    await doc("trashed", spaces[0], { deleted: true });
    await doc("branch", spaces[0], { status: "draft", branchOf: a });
    const hidden = await doc("out-of-scope", spaces[4]);
    const scope = asScope(spaces.slice(0, 4));

    const everything = await listLatestDocuments({ scope, includeDrafts: false, limit: 50 });
    assert.deepEqual(everything.map((d) => d.id), [a, b, c], "published, in scope, newest first");
    assert.equal(everything[0].space_name, `${STAMP} 1`);
    assert.equal(everything[0].author, "Dash Author");

    const withDrafts = await listLatestDocuments({ scope, includeDrafts: true, limit: 50 });
    assert.deepEqual(withDrafts.map((d) => d.id), [a, b, c, draft], "the draft, never the branch or the trashed one");
    assert.ok(!withDrafts.some((d) => d.id === hidden));

    const followed = await listFollowedSpaceIds(userId, scope);
    const following = await listLatestDocuments({ scope, includeDrafts: false, spaceIds: followed, limit: 50 });
    assert.deepEqual(following.map((d) => d.id), [a, b]);
    assert.deepEqual(await listLatestDocuments({ scope, includeDrafts: false, spaceIds: [] }), [], "following nothing lists nothing");

    const skipped = await listLatestDocuments({ scope, includeDrafts: false, excludeIds: [a], limit: 2 });
    assert.deepEqual(skipped.map((d) => d.id), [b, c], "the pick-up cards' documents are left out, and the limit still fills");
  });
});

describe("listPopularThisWeek", () => {
  test("ranks by views in the last 7 days among readable documents", async () => {
    const top = await doc("pop-top", spaces[0]);
    const second = await doc("pop-second", spaces[1]);
    const stale = await doc("pop-stale", spaces[3]);
    const draft = await doc("pop-draft", spaces[3], { status: "draft" });
    const outside = await doc("pop-outside", spaces[4]);
    await views(top, 9);
    await views(second, 4);
    await views(stale, 2);
    await views(stale, 50, "9 days");
    await views(draft, 6);
    await views(outside, 20);
    const scope = asScope(spaces.slice(0, 4));

    const rows = await listPopularThisWeek(scope, false, 10);
    assert.deepEqual(
      rows.map((r) => [r.id, r.views]),
      [
        [top, 9],
        [second, 4],
        [stale, 2],
      ],
      "last week's 50 views do not count; the draft and the out-of-scope document are absent"
    );
    const editors = await listPopularThisWeek(scope, true, 2);
    assert.deepEqual(editors.map((r) => r.id), [top, draft], "drafts for someone who may see them; the limit holds");
  });
});

describe("listStatusStrip", () => {
  test("the worse of the polled status and an open incident, problems first", async () => {
    const add = async (name: string, provider: string, status: string, detail = "") => {
      const r = await fixtureQuery(
        "INSERT INTO status_services (name, provider, status, status_detail) VALUES ($1, $2, $3, $4) RETURNING id",
        [`${STAMP} ${name}`, provider, status, detail]
      );
      serviceIds.push(r.rows[0].id);
      return r.rows[0].id as number;
    };
    const fine = await add("a fine", "statuspage", "operational");
    const slow = await add("b slow", "statuspage", "degraded", "Elevated latency");
    const internal = await add("c internal", "manual", "operational");
    const unknown = await add("d unknown", "statuspage", "unknown");
    await fixtureQuery(
      "INSERT INTO status_incidents (service_id, title, severity, state) VALUES ($1, 'Down hard', 'outage', 'open'), ($1, 'Old', 'degraded', 'resolved'), ($2, 'Minor', 'maintenance', 'open')",
      [internal, slow]
    );

    const mine = (await listStatusStrip()).filter((s) => serviceIds.includes(s.id));
    assert.deepEqual(
      mine.map((s) => [s.id, s.status, s.detail]),
      [
        [internal, "outage", "Down hard"],
        [slow, "degraded", "Elevated latency"],
        [fine, "operational", ""],
        [unknown, "unknown", ""],
      ],
      "an open incident outranks a healthy status; a milder incident does not soften a worse status; resolved ones are ignored"
    );
  });
});

describe("hidden dashboard sections", () => {
  test("known keys only, once each, in dashboard order", async () => {
    assert.deepEqual([...(await getHiddenDashboardSections(userId))], []);
    const stored = await setHiddenDashboardSections(userId, ["people", "nope", "status", "people"]);
    assert.deepEqual(stored, ["status", "people"]);
    assert.deepEqual([...(await getHiddenDashboardSections(userId))], ["status", "people"]);
    // A key retired from the dashboard is ignored on read.
    await pool().query("UPDATE users SET dashboard_hidden = ARRAY['spaces','retired'] WHERE id = $1", [userId]);
    assert.deepEqual([...(await getHiddenDashboardSections(userId))], ["spaces"]);
    await setHiddenDashboardSections(userId, []);
    assert.deepEqual([...(await getHiddenDashboardSections(userId))], []);
    assert.equal(new Set(DASHBOARD_SECTIONS.map((s) => s.key)).size, 9);
    assert.deepEqual(
      DASHBOARD_SECTIONS.map((s) => s.key).sort(),
      ["compliance", "latest", "my_team", "people", "popular", "quick_links", "spaces", "status", "training"]
    );
  });
});
