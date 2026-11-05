// Quick links (1.17.0): link clicks, the dashboard's three groups, personal
// pins, the sign-in page's links and the admin's two placements.
//
//   - getDashboardQuickLinks: pinned (own and curated; a curated pin the
//     viewer can no longer see is skipped), featured (visible to the viewer),
//     most used (the viewer's own counts, topped up to four from the
//     workspace's without counts), de-duplicated pinned → featured → most
//     used; the New flag on links younger than a week
//   - POST /api/links/{id}/click: recorded for a visible link, a quiet 204
//     for an invisible one, NULL-user for a sign-in link without a session,
//     401 for anything else without one, 403 cross-origin
//   - /api/quick-links: pin a curated link (once), an own link (http(s)
//     only), at most twelve, unpin only your own, reorder
//   - admin PATCH: Dashboard and Sign-in page are audited as themselves; the
//     sign-in place is refused on a restricted link and cleared when a link
//     is restricted; listSignInLinks never lists a restricted link and shows
//     the first eight by position
//   - the icon route serves a sign-in link's stored icon without a session,
//     nothing else; with one, the link's visibility applies
//   - clicks older than 90 days are pruned; a deleted account's clicks stay
//     (user NULL) and its pins go
//
// Route handlers are called directly with next/headers stubbed, the way
// test/account-email.test.ts does it.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/quick-links.test.ts

import Module from "node:module";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// lib/uploads reads COMPASSDOCS_UPLOAD_DIR on every call: the icon fixtures'
// files go to a directory of this run's own.
const UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "compass-ql-"));
process.env.COMPASSDOCS_UPLOAD_DIR = UPLOAD_DIR;

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.quick-links.virtual.js");
{
  const jar = () => {
    const out = new Map<string, string>();
    for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
    }
    return out;
  };
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const j = jar();
      return {
        get: (name: string) => (j.has(name) ? { name, value: j.get(name) } : undefined),
        getAll: () => [...j].map(([name, value]) => ({ name, value })),
        has: (name: string) => j.has(name),
        set: () => {},
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const db = require("../src/lib/db") as typeof import("../src/lib/db");
const ql = require("../src/lib/quick-links") as typeof import("../src/lib/quick-links");
const { newToken } = require("../src/lib/password") as typeof import("../src/lib/password");
const { actionLabel } = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const { saveUpload } = require("../src/lib/uploads") as typeof import("../src/lib/uploads");
/* eslint-enable @typescript-eslint/no-require-imports */

const STAMP = `ql${Date.now()}`;
const ORIGIN = "https://docs.example.test";
const userIds: number[] = [];
const linkIds: number[] = [];
const groupIds: number[] = [];

async function newUser(tag: string, role = "viewer"): Promise<number> {
  const r = await db.pool().query<{ id: number }>(
    `INSERT INTO users (username, name, email, role, status, auth_provider)
     VALUES ($1, $2, '', $3, 'active', 'local') RETURNING id`,
    [`${STAMP}-${tag}`, `QL ${tag}`, role]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function sessionFor(userId: number): Promise<string> {
  const token = newToken();
  await db.createSession(token, userId, new Date(Date.now() + 3_600_000).toISOString());
  return token;
}

// A 1×1 transparent PNG: a real stored icon for the icon route to serve.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

async function newLink(
  tag: string,
  opts: { groups?: number[]; featured?: boolean; signin?: boolean; ageDays?: number; icon?: boolean } = {}
) {
  const icon = opts.icon ? { icon_file: await saveUpload(PNG_1X1, ".png"), icon_mime: "image/png" } : {};
  const link = await db.createLink({
    category_id: null,
    title: `${STAMP} ${tag}`,
    url: `https://${tag.toLowerCase()}.${STAMP}.example.test/path`,
    description: "",
    icon_type: opts.icon ? "custom" : "favicon",
    ...icon,
  });
  linkIds.push(link.id);
  if (opts.groups?.length) await db.setLinkGroups(link.id, opts.groups);
  await db.pool().query(
    `UPDATE links SET dashboard_featured = $2, signin = $3, created_at = now() - ($4 * interval '1 day') WHERE id = $1`,
    [link.id, opts.featured ? 1 : 0, opts.signin ? 1 : 0, opts.ageDays ?? 0]
  );
  return link.id;
}

/** n clicks on a link by a user (null: the sign-in page), `daysAgo` old. */
async function clicks(linkId: number, userId: number | null, n: number, daysAgo = 1) {
  await db.pool().query(
    `INSERT INTO link_clicks (link_id, user_id, clicked_at)
     SELECT $1, $2, now() - ($4 * interval '1 day') - (g * interval '1 second') FROM generate_series(1, $3) g`,
    [linkId, userId, n, daysAgo]
  );
}

const clickCount = async (linkId: number, userId: number | null | "any" = "any") =>
  (
    await db.pool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM link_clicks WHERE link_id = $1
         AND ($2::text = 'any' OR ($2::text = 'null' AND user_id IS NULL) OR user_id::text = $2::text)`,
      [linkId, userId === null ? "null" : String(userId)]
    )
  ).rows[0].n;

type Handler = (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(
  handler: Handler,
  url: string,
  opts: { session?: string; body?: unknown; id?: number | string; method?: string; origin?: string; ip?: string } = {}
) {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "203.0.113.77", "x-forwarded-host": "docs.example.test" };
  if (opts.session) headers.cookie = `compass_session=${opts.session}`;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  currentRequest = new Request(url, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  try {
    const res = await handler(
      currentRequest,
      opts.id === undefined ? undefined : { params: Promise.resolve({ id: String(opts.id) }) }
    );
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  } finally {
    currentRequest = null;
  }
}

let viewerId = 0;
let viewerSession = "";
let otherId = 0;
let otherSession = "";
let adminId = 0;
let adminSession = "";
let groupId = 0;
let clickRoute: { POST: Handler };
let pinsRoute: { GET: Handler; POST: Handler };
let pinRoute: { DELETE: Handler };
let orderRoute: { PATCH: Handler };
let adminLinkRoute: { PATCH: Handler };
let iconRoute: { GET: Handler };

const asUser = async (id: number) => (await db.getUserById(id)) as unknown as import("../src/lib/types").SessionUser;

before(async () => {
  await db.getSetting("__schema_bootstrap__");
  viewerId = await newUser("viewer");
  viewerSession = await sessionFor(viewerId);
  otherId = await newUser("other");
  otherSession = await sessionFor(otherId);
  adminId = await newUser("admin", "admin");
  adminSession = await sessionFor(adminId);
  const g = await db.createGroup({ name: `${STAMP} insiders` });
  groupId = g.id;
  groupIds.push(groupId);
  await db.addGroupMember(groupId, otherId);
  clickRoute = (await import("../src/app/api/links/[id]/click/route")) as unknown as typeof clickRoute;
  pinsRoute = (await import("../src/app/api/quick-links/route")) as unknown as typeof pinsRoute;
  pinRoute = (await import("../src/app/api/quick-links/[id]/route")) as unknown as typeof pinRoute;
  orderRoute = (await import("../src/app/api/quick-links/order/route")) as unknown as typeof orderRoute;
  adminLinkRoute = (await import("../src/app/api/admin/links/[id]/route")) as unknown as typeof adminLinkRoute;
  iconRoute = (await import("../src/app/api/links/icon/[id]/route")) as unknown as typeof iconRoute;
});

after(async () => {
  await db.pool().query("DELETE FROM audit_log WHERE target_label LIKE $1", [`${STAMP}%`]);
  await db.pool().query("DELETE FROM links WHERE id = ANY($1)", [linkIds]);
  await db.pool().query("DELETE FROM groups WHERE id = ANY($1)", [groupIds]);
  await db.pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await db.pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await db.pool().end();
  rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

describe("the dashboard's Quick links", () => {
  test("pinned, featured and most used, de-duplicated in that order, visibility applied", async () => {
    const pinnedCurated = await newLink("PinnedCurated", { featured: true });
    const featured = await newLink("Featured", { featured: true });
    const hiddenFeatured = await newLink("HiddenFeatured", { featured: true, groups: [groupId] });
    const mine1 = await newLink("Mine1");
    const mine2 = await newLink("Mine2");
    const restrictedClicked = await newLink("RestrictedClicked", { groups: [groupId] });
    const busy = await newLink("WorkspaceBusy");
    const busier = await newLink("WorkspaceBusier");

    await clicks(mine1, viewerId, 5);
    await clicks(mine2, viewerId, 3);
    await clicks(featured, viewerId, 9); // featured wins over most used
    await clicks(restrictedClicked, viewerId, 7); // clicked before the restriction: not visible now
    // The workspace ranks by people, not clicks: one person's 900 clicks
    // lose to more people's fewer.
    const crowd: number[] = [];
    for (let i = 0; i < 12; i++) crowd.push(await newUser(`crowd${i}`));
    for (const u of crowd) await clicks(busier, u, 1);
    for (const u of crowd.slice(0, 10)) await clicks(busy, u, 1); // 11 people with otherId
    await clicks(busy, otherId, 900);
    await clicks(mine1, viewerId, 50, 45); // outside the 30-day window

    await db.addUserQuickLink(viewerId, { linkId: pinnedCurated });
    await db.addUserQuickLink(viewerId, { title: "My own", url: "https://own.example.test/" });

    const r = await ql.getDashboardQuickLinks(await asUser(viewerId));
    assert.deepEqual(
      r.pinned.map((p) => [p.kind, p.title]),
      [["curated", `${STAMP} PinnedCurated`], ["own", "My own"]]
    );
    assert.equal(r.pinned[1].host, "own.example.test");
    assert.equal(r.pinned[1].letter, "M");
    assert.ok(r.pinned.every((p) => p.pinId !== null));

    const featuredIds = r.featured.map((f) => f.linkId);
    assert.ok(featuredIds.includes(featured), "a featured link is listed");
    assert.ok(!featuredIds.includes(pinnedCurated), "pinned wins over featured");
    assert.ok(!featuredIds.includes(hiddenFeatured), "a featured link the viewer cannot see is not");

    const used = r.mostUsed.map((m) => [m.linkId, m.count]);
    assert.deepEqual(used.slice(0, 2), [[mine1, 5], [mine2, 3]], "the viewer's own counts first, 30 days only");
    assert.ok(!used.some(([id]) => id === featured || id === restrictedClicked));
    assert.equal(r.mostUsed.length, 4, "topped up to four");
    assert.deepEqual(
      used.slice(2),
      [[busier, undefined], [busy, undefined]],
      "filler is the workspace's most clicked, without counts"
    );
    assert.equal(r.mostUsedIsWorkspace, true);

    // The member of the group sees the restricted link among their own counts.
    await clicks(restrictedClicked, otherId, 2);
    const other = await ql.getDashboardQuickLinks(await asUser(otherId));
    assert.ok(other.featured.some((f) => f.linkId === hiddenFeatured));
    assert.ok(other.mostUsed.some((m) => m.linkId === restrictedClicked && m.count === 2));
  });

  test("a curated pin the viewer can no longer see is skipped; New marks links younger than a week", async () => {
    const fresh = await newLink("Fresh");
    const old = await newLink("Old", { ageDays: 10 });
    const lost = await newLink("Lost");
    const me = await newUser("pins");
    for (const id of [fresh, old, lost]) await db.addUserQuickLink(me, { linkId: id });
    await db.setLinkGroups(lost, [groupId]);
    const r = await ql.getDashboardQuickLinks(await asUser(me));
    assert.deepEqual(r.pinned.map((p) => [p.linkId, p.isNew]), [[fresh, true], [old, false]]);
  });

  test("listPinnableLinks lists the links the viewer can see", async () => {
    const restricted = await newLink("PinnableRestricted", { groups: [groupId] });
    const open = await newLink("PinnableOpen");
    const ids = (await ql.listPinnableLinks(await asUser(viewerId))).map((l) => l.linkId);
    assert.ok(ids.includes(open));
    assert.ok(!ids.includes(restricted));
    const adminIds = (await ql.listPinnableLinks(await asUser(adminId))).map((l) => l.linkId);
    assert.ok(adminIds.includes(restricted), "admins see every link");
  });
});

describe("POST /api/links/{id}/click", () => {
  const url = (id: number) => `${ORIGIN}/api/links/${id}/click`;

  test("records a visible link's click for the person, quietly ignores one they cannot see", async () => {
    const open = await newLink("ClickOpen");
    const restricted = await newLink("ClickRestricted", { groups: [groupId] });
    const r = await call(clickRoute.POST, url(open), { session: viewerSession, id: open, origin: ORIGIN });
    assert.equal(r.status, 204);
    assert.equal(await clickCount(open, viewerId), 1);

    const hidden = await call(clickRoute.POST, url(restricted), { session: viewerSession, id: restricted });
    assert.equal(hidden.status, 204);
    assert.equal(await clickCount(restricted), 0, "nothing recorded for a link the viewer cannot see");

    assert.equal((await call(clickRoute.POST, url(restricted), { session: otherSession, id: restricted })).status, 204);
    assert.equal(await clickCount(restricted, otherId), 1, "the group member's click counts");

    assert.equal((await call(clickRoute.POST, url(999_999_999), { session: viewerSession, id: 999_999_999 })).status, 204);
  });

  test("without a session, only a sign-in page link is recorded (with no user)", async () => {
    const signin = await newLink("ClickSignin", { signin: true });
    const plain = await newLink("ClickPlain");
    assert.equal((await call(clickRoute.POST, url(signin), { id: signin, ip: "198.51.100.10" })).status, 204);
    assert.equal(await clickCount(signin, null), 1);
    assert.equal((await call(clickRoute.POST, url(plain), { id: plain, ip: "198.51.100.10" })).status, 401);
    assert.equal(await clickCount(plain), 0);

    // A flagged link that is restricted is not a sign-in link.
    const flaggedRestricted = await newLink("ClickFlaggedRestricted", { signin: true, groups: [groupId] });
    assert.equal((await call(clickRoute.POST, url(flaggedRestricted), { id: flaggedRestricted })).status, 401);
  });

  test("refuses another origin, and limits how many clicks one IP can count", async () => {
    const signin = await newLink("ClickLimit", { signin: true });
    const cross = await call(clickRoute.POST, url(signin), { id: signin, origin: "https://evil.example" });
    assert.equal(cross.status, 403);
    for (let i = 0; i < 25; i++) {
      assert.equal((await call(clickRoute.POST, url(signin), { id: signin, ip: "198.51.100.99" })).status, 204);
    }
    assert.equal(await clickCount(signin), 20, "twenty a minute from one address");
  });
});

describe("/api/quick-links", () => {
  const base = `${ORIGIN}/api/quick-links`;

  test("pins a curated link once and an own link; refuses what is not http(s) or not visible", async () => {
    const me = await newUser("api");
    const s = await sessionFor(me);
    const open = await newLink("ApiOpen");
    const restricted = await newLink("ApiRestricted", { groups: [groupId] });

    const a = await call(pinsRoute.POST, base, { session: s, body: { linkId: open } });
    assert.equal(a.status, 201);
    assert.equal(a.body.item.linkId, open);
    assert.equal(a.body.item.kind, "curated");
    const again = await call(pinsRoute.POST, base, { session: s, body: { linkId: open } });
    assert.equal(again.body.item.pinId, a.body.item.pinId, "pinning twice keeps one pin");

    assert.equal((await call(pinsRoute.POST, base, { session: s, body: { linkId: restricted } })).status, 404);

    const own = await call(pinsRoute.POST, base, { session: s, body: { title: " Payroll ", url: "https://payroll.example.test" } });
    assert.equal(own.status, 201);
    assert.deepEqual(
      [own.body.item.kind, own.body.item.title, own.body.item.url, own.body.item.linkId],
      ["own", "Payroll", "https://payroll.example.test/", null]
    );

    for (const bad of ["javascript:alert(1)", "ftp://x.example.test", "/relative", "mailto:a@b.test", ""]) {
      const r = await call(pinsRoute.POST, base, { session: s, body: { title: "Bad", url: bad } });
      assert.equal(r.status, 400, bad);
    }
    assert.equal((await call(pinsRoute.POST, base, { session: s, body: { title: "", url: "https://x.example.test" } })).status, 400);
    assert.equal(
      (await call(pinsRoute.POST, base, { session: s, body: { title: "x".repeat(61), url: "https://x.example.test" } })).status,
      400
    );
    assert.equal(
      (await call(pinsRoute.POST, base, { session: s, body: { title: "Long", url: `https://x.example.test/${"a".repeat(2000)}` } })).status,
      400
    );

    const list = await call(pinsRoute.GET, base, { session: s, method: "GET" });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.pinned.map((p: { title: string }) => p.title), [`${STAMP} ApiOpen`, "Payroll"]);

    assert.equal((await call(pinsRoute.POST, base, { body: { linkId: open } })).status, 401);
  });

  test("keeps at most twelve, unpins only your own, and reorders", async () => {
    const me = await newUser("twelve");
    const s = await sessionFor(me);
    const pinIds: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const r = await call(pinsRoute.POST, base, { session: s, body: { title: `Pin ${i}`, url: `https://p${i}.example.test` } });
      assert.equal(r.status, 201);
      pinIds.push(r.body.item.pinId);
    }
    const full = await call(pinsRoute.POST, base, { session: s, body: { title: "Pin 13", url: "https://p13.example.test" } });
    assert.equal(full.status, 409);

    assert.equal(
      (await call(pinRoute.DELETE, `${base}/${pinIds[0]}`, { session: otherSession, id: pinIds[0], method: "DELETE" })).status,
      404,
      "another person's pin"
    );
    assert.equal((await call(pinRoute.DELETE, `${base}/${pinIds[0]}`, { session: s, id: pinIds[0], method: "DELETE" })).status, 200);
    assert.equal((await db.listUserQuickLinks(me)).length, 11);

    const reordered = await call(orderRoute.PATCH, `${base}/order`, {
      session: s,
      method: "PATCH",
      body: { pinIds: [pinIds[3], pinIds[1], 424242] },
    });
    assert.equal(reordered.status, 200);
    assert.deepEqual(
      reordered.body.pinned.slice(0, 4).map((p: { title: string }) => p.title),
      ["Pin 4", "Pin 2", "Pin 3", "Pin 5"],
      "the listed pins first, the rest keep their order; a foreign id is ignored"
    );
    assert.equal(
      (await call(orderRoute.PATCH, `${base}/order`, { session: s, method: "PATCH", body: { pinIds: ["x"] } })).status,
      400
    );
  });
});

describe("the admin's placements and the sign-in page", () => {
  const url = (id: number) => `${ORIGIN}/api/admin/links/${id}`;

  test("Dashboard and Sign-in page toggle, each audited as itself", async () => {
    const id = await newLink("Placement");
    const on = await call(adminLinkRoute.PATCH, url(id), { session: adminSession, id, method: "PATCH", body: { dashboard_featured: true, signin: true } });
    assert.equal(on.status, 200);
    assert.equal(on.body.link.dashboard_featured, 1);
    assert.equal(on.body.link.signin, 1);
    assert.equal(typeof on.body.link.clicks, "number");
    const off = await call(adminLinkRoute.PATCH, url(id), { session: adminSession, id, method: "PATCH", body: { signin: false } });
    assert.equal(off.body.link.signin, 0);
    assert.equal(off.body.link.dashboard_featured, 1);

    const actions = (
      await db.pool().query<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_label = $1 ORDER BY id",
        [`${STAMP} Placement`]
      )
    ).rows.map((r) => r.action);
    assert.deepEqual(actions, ["link.dashboard_featured", "link.signin_shown", "link.signin_hidden"]);
    for (const a of ["link.dashboard_featured", "link.dashboard_unfeatured", "link.signin_shown", "link.signin_hidden"]) {
      assert.doesNotMatch(actionLabel(a), /·/, `${a} has its own label`);
    }

    assert.equal(
      (await call(adminLinkRoute.PATCH, url(id), { session: viewerSession, id, method: "PATCH", body: { signin: true } })).status,
      403
    );
    assert.equal(
      (await call(adminLinkRoute.PATCH, url(id), { session: adminSession, id, method: "PATCH", body: { signin: "yes" } })).status,
      400
    );
  });

  test("a restricted link cannot go on the sign-in page, and restricting one takes it off", async () => {
    const restricted = await newLink("SigninRestricted", { groups: [groupId] });
    const refused = await call(adminLinkRoute.PATCH, url(restricted), { session: adminSession, id: restricted, method: "PATCH", body: { signin: true } });
    assert.equal(refused.status, 400);
    assert.equal((await db.getLink(restricted))!.signin, 0);

    const id = await newLink("SigninThenRestricted", { signin: true });
    // Other tests' sign-in links may fill the eight places: ask past the cap.
    assert.ok((await db.listSignInLinkRows(10_000)).some((l) => l.id === id));
    const r = await call(adminLinkRoute.PATCH, url(id), {
      session: adminSession,
      id,
      method: "PATCH",
      body: { title: `${STAMP} SigninThenRestricted`, url: `https://signinthenrestricted.${STAMP}.example.test/path`, group_ids: [groupId] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.link.signin, 0);
    assert.ok(!(await db.listSignInLinkRows(10_000)).some((l) => l.id === id));
    const audit = await db.pool().query<{ action: string; details: Record<string, string> }>(
      "SELECT action, details FROM audit_log WHERE target_label = $1 AND action = 'link.signin_hidden'",
      [`${STAMP} SigninThenRestricted`]
    );
    assert.equal(audit.rows[0]?.details.reason, "restricted_to_groups");

    // A flag set behind the API's back still never shows a restricted link.
    await db.pool().query("UPDATE links SET signin = 1 WHERE id = $1", [restricted]);
    assert.ok(!(await db.listSignInLinkRows(10_000)).some((l) => l.id === restricted));
  });

  test("listSignInLinks shows the first eight by position", async () => {
    // Nine flagged, unrestricted links placed ahead of every other link in
    // the shared database, so the page's eight are exactly the first eight
    // of these whatever else is flagged; given out of order to see the sort.
    const lowest = (await db.pool().query<{ m: number }>("SELECT COALESCE(MIN(position), 0)::int AS m FROM links")).rows[0].m;
    const nine: number[] = [];
    for (let i = 0; i < 9; i++) nine.push(await newLink(`SigninCap${i}`, { signin: true }));
    try {
      const order = [4, 0, 8, 2, 6, 1, 7, 3, 5]; // nine[order[k]] gets the k-th place
      for (const [k, i] of order.entries()) {
        await db.pool().query("UPDATE links SET position = $2 WHERE id = $1", [nine[i], lowest - 100 + k]);
      }
      const shown = await ql.listSignInLinks();
      assert.equal(shown.length, 8, "eight on the page, not nine");
      assert.deepEqual(
        shown.map((l) => l.id),
        order.slice(0, 8).map((i) => nine[i]),
        "by position; the ninth is left off"
      );
      assert.ok(!shown.some((l) => l.id === nine[order[8]]));
      assert.equal(shown[0].title, `${STAMP} SigninCap4`);
      assert.equal(shown[0].iconUrl, null, "no stored icon: the letter tile");
    } finally {
      // Off the shared sign-in page at once (the rows go in after()).
      await db.pool().query("UPDATE links SET signin = 0 WHERE id = ANY($1)", [nine]);
    }
  });

  test("the icon route answers without a session only for a sign-in link", async () => {
    const signin = await newLink("IconSignin", { signin: true, icon: true });
    const plain = await newLink("IconPlain", { icon: true });
    const restricted = await newLink("IconRestricted", { groups: [groupId], icon: true });
    const iconUrl = (id: number) => `${ORIGIN}/api/links/icon/${id}`;
    const get = (id: number, session?: string) => call(iconRoute.GET, iconUrl(id), { id, method: "GET", session });

    // Every fixture has a stored icon, so a 404 below is the visibility rule
    // and not a missing file.
    const pub = await get(signin);
    assert.equal(pub.status, 200, "a sign-in link's icon without a session");
    assert.equal(pub.headers.get("content-type"), "image/png");
    assert.equal((await get(plain)).status, 401, "any other link's needs a session");
    assert.equal((await get(restricted)).status, 401);

    assert.equal((await get(plain, viewerSession)).status, 200, "a visible link's icon with a session");
    assert.equal((await get(restricted, viewerSession)).status, 404, "a restricted link the viewer cannot see");
    assert.equal((await get(restricted, otherSession)).status, 200, "the group member sees it");
    assert.equal((await get(restricted, adminSession)).status, 200, "admins see every link");
  });
});

describe("retention and account deletion", () => {
  test("maintenance prunes clicks older than 90 days; a deleted account's clicks stay, its pins go", async () => {
    const id = await newLink("Retention");
    const gone = await newUser("gone");
    await clicks(id, gone, 2, 91);
    await clicks(id, gone, 3, 10);
    await db.addUserQuickLink(gone, { linkId: id });
    await db.runDbMaintenance();
    assert.equal(await clickCount(id), 3);

    assert.equal(await db.deleteUser(gone), true);
    assert.equal(await clickCount(id, null), 3, "the clicks stay, without the person");
    assert.equal((await db.pool().query("SELECT 1 FROM user_quick_links WHERE user_id = $1", [gone])).rowCount, 0);
  });
});
