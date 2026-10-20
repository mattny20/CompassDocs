// Chat channel notices through outgoing webhooks (H3, 1.14.0): the five
// policy events of lib/webhooks and the emits of lib/compliance-webhooks.
// A channel hears counts and policy titles, never the names of the people
// who owe a confirmation; every emit is one event per policy, after the
// outbox row, through the org-level hooks and their per-space filter; the
// weekly summary goes only to hooks with no space filter; the deadline
// notice is claimed once per policy per due date; a per-person re-ask tells
// no channel.
//
// The delivery is stubbed at the transport (webhookTransport.post, the one
// seam lib/webhooks exposes for this): nothing here opens a socket, and the
// JSON every hook would have received is read back. Fixtures live in a
// private space granted to a group of this file's own people, so no other
// file's accounts are in these counts; the hooks are this file's own and are
// deleted at the end. The reconfirm route is called directly, as
// test/ack-sets.test.ts calls its routes: next/headers resolves to a stub
// serving the request under test, lib/ee to the stub granting policy_ack.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-webhooks.test.ts

import { edition } from "./support/ee-stub";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import {
  pool,
  getSetting,
  createDocument,
  createGroup,
  setGroupMembers,
  setSpaceGroups,
  createSession,
  createWebhook,
  deleteWebhook,
  retirePolicy,
  setSupersededBy,
  recordAcknowledgement,
  listVersions,
  saveAudienceRules,
  createPolicySet,
  assignPolicySet,
  listComplianceSnapshots,
} from "../src/lib/db";
import { sanitizeRules } from "../src/lib/audience";
import { newToken } from "../src/lib/password";
import { webhookTransport, buildPayload, WEBHOOK_EVENTS } from "../src/lib/webhooks";
import type { WebhookInfo } from "../src/lib/webhooks";
import {
  emitPolicyRequested,
  emitPolicyEscalated,
  emitPolicyRetired,
  emitPolicyDeadlines,
  weeklyPolicyChannelSummary,
  calendarDay,
  DEADLINE_HOOK_CLAIM_PREFIX,
  WEEKLY_HOOK_CLAIM_KEY,
} from "../src/lib/compliance-webhooks";
import { requestAcknowledgement, escalateOverdueAcks, recertifyDueAcks, sweepDefaults } from "../src/lib/compliance";
import { monthId } from "../src/lib/periodic";
import { getAppSettings } from "../src/lib/settings-store";
import { formatDate } from "../src/lib/format";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";

// --- The request scope outside Next (the reconfirm route) ------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.ack-webhooks.virtual.js");
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
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

async function answer(run: () => Promise<Response>, req: Request): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await run();
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON body */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

function request(method: string, url: string, session: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.44" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- The transport stub ---------------------------------------------------------------

interface Post {
  url: string;
  body: any;
}
const posts: Post[] = [];
/** Every generic envelope any hook received, for the privacy assertion at the end. */
const generics: any[] = [];
webhookTransport.post = async (url, body) => {
  const parsed = JSON.parse(body);
  posts.push({ url, body: parsed });
  if (parsed && parsed.source === "compassdocs") generics.push(parsed);
  return { ok: true, status: 200 };
};

const STAMP = `ackweb-${Date.now()}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const hookUrl = (tag: string) => `https://hooks.example.test/${STAMP}/${tag}`;
const postsTo = (tag: string, docId?: number): Post[] =>
  posts.filter((p) => p.url === hookUrl(tag) && (docId === undefined || p.body?.policy?.id === docId));

async function waitFor<T>(read: () => T[], n: number, ms = 8000): Promise<T[]> {
  const until = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got.length >= n) return got;
    if (Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 60));
  }
}
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

// --- Fixtures ----------------------------------------------------------------------------

let spaceP = 0; // private, granted to a group of this file's people
let spaceQ = 0; // private, nobody here: the "elsewhere" scope
let group = 0;
const people: Record<string, number> = {};
const userIds: number[] = [];
const docIds: number[] = [];
const hookIds: number[] = [];
const setIds: number[] = [];
const sessions: string[] = [];
const titles: Record<number, string> = {};

const TEXT = Array.from({ length: 30 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");
/** The actor whose name a sentence may carry (the manager who asked or retired): never marked PERSON. */
const actor = () => ({ id: people.mgr, name: `Mgr Channel ${STAMP}` });

async function newPerson(tag: string, role = "viewer", name?: string): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [`${STAMP}-${tag}`, name ?? `PERSON ${tag} ${STAMP}`, `${STAMP}-${tag}@example.test`, role]
  );
  people[tag] = r.rows[0].id;
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

/**
 * A published document in the private space, asking this file's group
 * (targeted mode: a space-mode policy would also enrol every admin account
 * the shared database holds, so counts would not be this file's own). With
 * `required: false` the audience is stored ahead of the switch-on, the way
 * assignSetToPolicy stores a set's audience, so the switch-on's reconcile
 * reads it; `audience: "none"` leaves the policy with no audience of its own.
 */
async function newDoc(title: string, opts: { required?: boolean; audience?: "group" | "none" } = {}): Promise<number> {
  const full = `POLICY ${title} ${STAMP}`;
  const doc = await createDocument({
    space_id: spaceP,
    title: full,
    type: "policy",
    status: "published",
    content: TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  const audience = opts.audience ?? "group";
  if (opts.required !== false) {
    await switchOn(doc.id, { editDefault: null, recertMonths: null });
    if (audience === "group") {
      await saveAudienceRules(doc.id, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "group", ref: group }]) });
    }
  } else if (audience === "group") {
    await fixtureQuery(
      "INSERT INTO policy_settings (document_id, audience_mode) VALUES ($1, 'targeted') ON CONFLICT (document_id) DO UPDATE SET audience_mode = 'targeted'",
      [doc.id]
    );
    await fixtureQuery(
      "INSERT INTO policy_audience_rules (document_id, kind, ref, effect) VALUES ($1, 'group', $2, 'include') ON CONFLICT DO NOTHING",
      [doc.id, String(group)]
    );
  }
  docIds.push(doc.id);
  titles[doc.id] = full;
  return doc.id;
}

async function hook(tag: string, events: string[], opts: { spaceIds?: number[]; format?: string } = {}): Promise<number> {
  const h = await createWebhook({ name: `${STAMP} ${tag}`, url: hookUrl(tag), format: opts.format ?? "generic", events, spaceIds: opts.spaceIds ?? [] });
  hookIds.push(h.id);
  return h.id;
}

const D = sweepDefaults({ remind_before_days: 3, remind_every_days: 7, escalate_after_days: 7, nudge_every_days: 0, overdue_grace_days: 0 });

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id",
    [`Channel P ${STAMP}`, `${STAMP}-p`]
  );
  spaceP = sp.rows[0].id;
  const sq = await fixtureQuery(
    "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id",
    [`Channel Q ${STAMP}`, `${STAMP}-q`]
  );
  spaceQ = sq.rows[0].id;
  for (const tag of ["alice", "bob", "carol"]) await newPerson(tag);
  await newPerson("mgr", "admin", `Mgr Channel ${STAMP}`);
  group = (await createGroup({ name: `${STAMP} G` })).id;
  await setGroupMembers(group, Object.values(people));
  await setSpaceGroups(spaceP, [group]);
});

after(async () => {
  for (const id of hookIds) await deleteWebhook(id).catch(() => {});
  await fixtureQuery("DELETE FROM settings WHERE key = $1 AND value LIKE $2", [WEEKLY_HOOK_CLAIM_KEY, `${STAMP}%`]);
  for (const id of docIds) await fixtureQuery("DELETE FROM settings WHERE key = $1", [`${DEADLINE_HOOK_CLAIM_PREFIX}${id}`]);
  await fixtureQuery("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  for (const id of userIds) await fixtureQuery("DELETE FROM ack_outbox WHERE user_ids @> $1::jsonb", [JSON.stringify([id])]);
  await fixtureQuery("DELETE FROM compliance_snapshots WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM acknowledgements WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `POLICY %${STAMP}`]);
  await fixtureQuery(
    "DELETE FROM audit_log WHERE (action LIKE 'ack.%' OR action LIKE 'document.ack%') AND (target_id = ANY($1) OR target_id = ANY($2) OR target_id = ANY($3))",
    [docIds.map(String), userIds.map(String), setIds.map(String)]
  );
  await fixtureQuery("DELETE FROM policy_sets WHERE id = ANY($1) OR name LIKE $2", [setIds, `${STAMP}%`]);
  await fixtureQuery("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM groups WHERE id = $1", [group]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM spaces WHERE id = ANY($1)", [[spaceP, spaceQ]]);
});

// --- The sentences (lib/webhooks describe) ------------------------------------------------

describe("lib/webhooks: the five policy events and their sentences", () => {
  const base = (over: Partial<WebhookInfo["policy"]> = {}): WebhookInfo => ({
    title: "Acceptable Use Policy",
    actor: "Priya Shah",
    url: "https://docs.example.test/compliance/policies?policy=7",
    spaceId: 3,
    policy: {
      id: 7,
      title: "Acceptable Use Policy",
      due_at: "2026-10-29T17:00:00.000Z",
      due_label: "29 Oct 2026",
      counts: { required: 500, acked: 88, overdue: 7 },
      people: 412,
      ...over,
    },
  });
  const md = (event: (typeof WEBHOOK_EVENTS)[number], info: WebhookInfo) =>
    (buildPayload("webex", event, info) as { markdown: string }).markdown;

  test("WEBHOOK_EVENTS carries the five, after the six of the approval workflow", () => {
    assert.deepEqual(WEBHOOK_EVENTS.slice(6), [
      "policy.requested",
      "policy.deadline_approaching",
      "policy.escalated",
      "policy.weekly_summary",
      "policy.retired",
    ]);
  });

  test("policy.requested: the ask with its deadline, and the annual cycle", () => {
    const text = md("policy.requested", base());
    assert.ok(text.startsWith("📋 **CompassDocs — Read confirmation requested**"), text);
    assert.ok(text.includes("**Priya Shah** asked 412 people to confirm **“Acceptable Use Policy”** by 29 Oct 2026."), text);
    assert.ok(text.includes("[Open in CompassDocs](https://docs.example.test/compliance/policies?policy=7)"), text);
    assert.ok(
      md("policy.requested", base({ due_at: null, due_label: null })).includes("**Priya Shah** asked 412 people to confirm **“Acceptable Use Policy”**."),
      "no deadline, no by-clause"
    );
    assert.ok(
      md("policy.requested", base({ cycle: "annual" })).includes("Annual re-confirmation of **“Acceptable Use Policy”** started: 412 people to confirm."),
      "the cycle"
    );
    assert.ok(md("policy.requested", base({ people: 1 })).includes("asked 1 person to confirm"), "singular");
  });

  test("policy.deadline_approaching: days and the pending count", () => {
    const text = md("policy.deadline_approaching", base({ people: 88, days: 3 }));
    assert.ok(text.startsWith("⏰ **CompassDocs — Confirmation deadline approaching**"), text);
    assert.ok(text.includes("**“Acceptable Use Policy”** is due in 3 days: 88 people still to confirm."), text);
    assert.ok(md("policy.deadline_approaching", base({ people: 2, days: 1 })).includes("is due tomorrow: 2 people still to confirm."));
    assert.ok(md("policy.deadline_approaching", base({ people: 1, days: 0 })).includes("is due today: 1 person still to confirm."));
  });

  test("policy.escalated: the count and how far past due", () => {
    const text = md("policy.escalated", base({ people: 7, days: 7 }));
    assert.ok(text.startsWith("⚠️ **CompassDocs — Confirmations overdue**"), text);
    assert.ok(text.includes("7 people are more than a week overdue on **“Acceptable Use Policy”**."), text);
    assert.ok(md("policy.escalated", base({ people: 3, days: 14 })).includes("3 people are more than two weeks overdue on"));
    assert.ok(md("policy.escalated", base({ people: 1, days: 10 })).includes("1 person is more than 10 days overdue on"));
  });

  test("policy.weekly_summary: the line, with the monthly snapshot hash when one was taken", () => {
    const info: WebhookInfo = {
      title: "Policy compliance this week",
      actor: "CompassDocs",
      summary: { week: "2026-W43", pct: 94, policies: 4, overdue: 23, lowest: { id: 9, title: "Data Handling", pct: 71 }, snapshot_sha256: null, snapshot_period: null },
    };
    const text = md("policy.weekly_summary", info);
    assert.ok(text.startsWith("📊 **CompassDocs — Compliance summary**"), text);
    assert.ok(text.includes("Policy compliance this week: 94% · 23 overdue across 4 policies · lowest: Data Handling 71%."), text);
    assert.ok(!text.includes("Monthly snapshot"), "no hash line without a snapshot");
    const withHash = md("policy.weekly_summary", {
      ...info,
      summary: { ...info.summary!, snapshot_sha256: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2", snapshot_period: "2026-10" },
    });
    assert.ok(withHash.includes("Monthly snapshot sha256 a1b2c3d4e5f6…"), withHash);
    const nothing = md("policy.weekly_summary", { ...info, summary: { ...info.summary!, lowest: null, policies: 1 } });
    assert.ok(nothing.includes("overdue across 1 policy."), nothing);
  });

  test("policy.retired: by whom and what replaced it", () => {
    const info = base({ id: 11, title: "Travel policy", superseded_by: { id: 12, title: "Expenses and travel" } });
    info.title = "Travel policy";
    const text = md("policy.retired", info);
    assert.ok(text.startsWith("🗄️ **CompassDocs — Policy retired**"), text);
    assert.ok(text.includes("**“Travel policy”** was retired by Priya Shah; replaced by **“Expenses and travel”**."), text);
    const alone = base({ id: 11, title: "Travel policy", superseded_by: null });
    alone.title = "Travel policy";
    assert.ok(md("policy.retired", alone).includes("**“Travel policy”** was retired by Priya Shah."));
  });

  test("the generic envelope passes `policy` and `summary` through; the older events' envelopes are unchanged; Slack and Teams carry the sentence", () => {
    const generic = buildPayload("generic", "policy.requested", base()) as Record<string, unknown>;
    assert.equal(generic.event, "policy.requested");
    assert.equal(generic.title, "Acceptable Use Policy");
    assert.deepEqual(generic.policy, base().policy);
    assert.ok(!("summary" in generic));
    const old = buildPayload("generic", "document.published", { title: "Handbook", actor: "Ana", spaceName: "HR" }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(old).sort(), ["actor", "at", "event", "kind", "note", "source", "title", "url"]);
    const slack = buildPayload("slack", "policy.escalated", base({ people: 7, days: 7 })) as { text: string };
    assert.ok(slack.text.includes("7 people are more than a week overdue on *“Acceptable Use Policy”*."), slack.text);
    const teams = buildPayload("teams", "policy.retired", base({ superseded_by: null })) as { attachments: { content: { body: { text: string }[] } }[] };
    assert.ok(teams.attachments[0].content.body[1].text.includes("was retired by Priya Shah."));
  });

  test("calendarDay keys a deadline on its day in the workspace's zone", () => {
    assert.equal(calendarDay("2026-10-29T23:30:00.000Z", "UTC"), "2026-10-29");
    assert.equal(calendarDay("2026-10-29T23:30:00.000Z", "Pacific/Auckland"), "2026-10-30");
    assert.equal(calendarDay("2026-10-29T23:30:00.000Z", "Not/AZone"), "2026-10-29");
  });
});

// --- The emits, through the hooks ------------------------------------------------------------

describe("lib/compliance-webhooks: the emits and the per-space filter", () => {
  let hookAll = 0;
  let hookMd = 0;
  let hookP = 0;
  let hookQ = 0;
  const POLICY_EVENTS = ["policy.requested", "policy.deadline_approaching", "policy.escalated", "policy.retired"];

  before(async () => {
    hookAll = await hook("all", POLICY_EVENTS);
    hookMd = await hook("md", POLICY_EVENTS, { format: "webex" });
    hookP = await hook("p", POLICY_EVENTS, { spaceIds: [spaceP] });
    hookQ = await hook("q", POLICY_EVENTS, { spaceIds: [spaceQ] });
    assert.ok(hookAll && hookMd && hookP && hookQ);
  });

  test("policy.requested reaches the unscoped hooks and the one scoped to the policy's space, never the one scoped elsewhere; counts, the title and the deadline the workspace's way", async () => {
    const id = await newDoc("Acceptable use");
    const settings = await getAppSettings();
    assert.equal(await emitPolicyRequested(id, { actor: actor().name, people: 3, origin: "https://docs.example.test" }), true);
    assert.equal(postsTo("all", id).length, 1, "the unscoped hook");
    assert.equal(postsTo("p", id).length, 1, "the hook scoped to the policy's space");
    assert.equal(postsTo("q", id).length, 0, "the hook scoped elsewhere");
    const body = postsTo("all", id)[0].body;
    assert.equal(body.event, "policy.requested");
    assert.equal(body.title, titles[id]);
    assert.equal(body.actor, actor().name);
    assert.equal(body.url, `https://docs.example.test/compliance/policies?policy=${id}`);
    assert.equal(body.policy.people, 3);
    assert.deepEqual(body.policy.counts, { required: 4, acked: 0, overdue: 0 });
    assert.ok(body.policy.due_at, "the deadline the switch-on set");
    assert.equal(body.policy.due_label, formatDate(body.policy.due_at, settings));
    const text = posts.find((p) => p.url === hookUrl("md") && (p.body.markdown as string).includes(titles[id]))!.body.markdown as string;
    assert.ok(text.includes(`**${actor().name}** asked 3 people to confirm **“${titles[id]}”** by ${body.policy.due_label}.`), text);
  });

  test("the request path: one event after the outbox row, with the people the request names; a quiet switch-on tells no channel", async () => {
    const id = await newDoc("Security basics", { required: false });
    const r = await requestAcknowledgement({ id, title: titles[id] }, actor(), "https://docs.example.test", { notify: true });
    assert.equal(r.switched_on, true);
    assert.equal(r.queued, 4);
    const got = await waitFor(() => postsTo("all", id), 1);
    assert.equal(got.length, 1, "one event, not one per recipient");
    assert.equal(got[0].body.policy.people, 4);
    assert.equal(got[0].body.policy.counts.required, 4);
    assert.ok(!got[0].body.policy.cycle);
    const quiet = await newDoc("Quiet policy", { required: false });
    const q = await requestAcknowledgement({ id: quiet, title: titles[quiet] }, actor(), "", { notify: false });
    assert.equal(q.switched_on, true);
    await settle();
    assert.equal(postsTo("all", quiet).length, 0, "notify off: nobody and no channel is told");
  });

  test("the whole-audience re-ask through the route emits once; a per-person re-ask emits nothing", async () => {
    const { POST: reconfirm } = await import("../src/app/api/documents/[id]/ack/reconfirm/route");
    const id = await newDoc("Code of conduct");
    const token = newToken();
    sessions.push(token);
    await createSession(token, people.mgr, new Date(Date.now() + HOUR).toISOString());
    const url = `http://localhost/api/documents/${id}/ack/reconfirm`;
    const personal = await answer(
      () => reconfirm(request("POST", url, token, { reason: "Please read the new travel section again", user_ids: [people.alice] }), { params: Promise.resolve({ id: String(id) }) }),
      request("POST", url, token)
    );
    assert.equal(personal.status, 200, JSON.stringify(personal.body));
    assert.deepEqual(personal.body.user_ids, [people.alice]);
    await settle();
    assert.equal(postsTo("all", id).length, 0, "a per-person re-ask names people: no channel notice");
    const whole = await answer(
      () => reconfirm(request("POST", url, token, { reason: "Please read the new travel section again" }), { params: Promise.resolve({ id: String(id) }) }),
      request("POST", url, token)
    );
    assert.equal(whole.status, 200, JSON.stringify(whole.body));
    const got = await waitFor(() => postsTo("all", id), 1);
    assert.equal(got.length, 1);
    assert.equal(got[0].body.policy.people, whole.body.queued);
    assert.equal(got[0].body.actor, actor().name);
  });

  test("a set assignment emits once per member policy: the switched-on member and the reconciled one", async () => {
    const fresh = await newDoc("Onboarding guide", { required: false, audience: "none" });
    const targeted = await newDoc("Expenses");
    await saveAudienceRules(targeted, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "user", ref: people.bob }]) });
    const set = await createPolicySet({ name: `${STAMP} Starter`, description: "", doc_ids: [fresh, targeted], assign_new_members: false }, actor());
    setIds.push(set.id);
    const r = await assignPolicySet(set.id, { user_ids: [people.alice], group_ids: [], everyone: false }, actor(), { origin: "https://docs.example.test" });
    assert.equal(r.policies, 2);
    assert.deepEqual(r.switched_on, [titles[fresh]]);
    const onFresh = await waitFor(() => postsTo("all", fresh), 1);
    assert.equal(onFresh.length, 1, "the switched-on member");
    assert.equal(onFresh[0].body.policy.people, 1, "everyone pending now: the one person named");
    const onTargeted = await waitFor(() => postsTo("all", targeted), 1);
    assert.equal(onTargeted.length, 1, "the reconciled member");
    assert.equal(onTargeted[0].body.policy.people, 1, "the people the reconcile started asking");
    assert.equal(onTargeted[0].body.policy.counts.required, 2, "bob and alice");
  });

  test("the escalation sweep emits once per policy that escalated someone, with the count and the days", async () => {
    const id = await newDoc("Data handling");
    await pool().query("UPDATE policy_assignments SET due_at = now() - interval '20 days' WHERE document_id = $1", [id]);
    const r = await escalateOverdueAcks({ documentIds: [id], defaults: D });
    assert.equal(r.claimed, 4);
    const got = await waitFor(() => postsTo("all", id), 1);
    assert.equal(got.length, 1);
    assert.equal(got[0].body.event, "policy.escalated");
    assert.equal(got[0].body.policy.people, 4);
    assert.equal(got[0].body.policy.days, 7);
    assert.equal(got[0].body.policy.counts.overdue, 4);
    assert.equal(got[0].body.actor, "CompassDocs");
    const text = posts.find((p) => p.url === hookUrl("md") && (p.body.markdown as string).includes(`overdue on **“${titles[id]}”**`))!.body.markdown as string;
    assert.ok(text.includes(`4 people are more than a week overdue on **“${titles[id]}”**.`), text);
    // A second sweep escalates nobody (stamped) and therefore says nothing.
    const again = await escalateOverdueAcks({ documentIds: [id], defaults: D });
    assert.equal(again.claimed, 0);
    await settle();
    assert.equal(postsTo("all", id).length, 1);
    assert.equal(await emitPolicyEscalated(id, 2, { days: 14 }), true);
    assert.equal(postsTo("all", id)[1].body.policy.people, 2);
  });

  test("the deadline notice is claimed once per policy per due date across two calls, counts the people still to confirm, and claims nothing while no hook listens", async () => {
    const id = await newDoc("Travel policy");
    const v1 = (await listVersions(id))[0].id;
    await recordAcknowledgement(id, people.carol, "", v1);
    await pool().query("UPDATE policy_assignments SET due_at = now() + interval '2 days' WHERE document_id = $1", [id]);
    // Before any hook subscribes: nothing is claimed, so the deadline is still announced once one does.
    for (const h of [hookAll, hookMd, hookP, hookQ]) await deleteWebhook(h);
    assert.deepEqual(await emitPolicyDeadlines({ documentIds: [id], defaults: D }), { policies: 0, announced: 0, skipped: "no_hooks" });
    hookAll = await hook("all", POLICY_EVENTS);
    hookMd = await hook("md", POLICY_EVENTS, { format: "webex" });
    hookP = await hook("p", POLICY_EVENTS, { spaceIds: [spaceP] });
    hookQ = await hook("q", POLICY_EVENTS, { spaceIds: [spaceQ] });

    const first = await emitPolicyDeadlines({ documentIds: [id], defaults: D });
    assert.deepEqual(first, { policies: 1, announced: 1, skipped: null });
    assert.equal(postsTo("all", id).length, 1);
    assert.equal(postsTo("q", id).length, 0, "scoped elsewhere");
    const body = postsTo("all", id)[0].body;
    assert.equal(body.event, "policy.deadline_approaching");
    assert.equal(body.policy.people, 3, "alice, bob and the manager; carol confirmed");
    assert.equal(body.policy.days, 2);
    assert.deepEqual(body.policy.counts, { required: 4, acked: 1, overdue: 0 });
    const text = posts.find((p) => p.url === hookUrl("md") && (p.body.markdown as string).includes(`**“${titles[id]}”** is due`))!.body.markdown as string;
    assert.ok(text.includes(`**“${titles[id]}”** is due in 2 days: 3 people still to confirm.`), text);

    const second = await emitPolicyDeadlines({ documentIds: [id], defaults: D });
    assert.deepEqual(second, { policies: 1, announced: 0, skipped: null }, "the same due date is announced once");
    assert.equal(postsTo("all", id).length, 1);

    // A new deadline (an extension, a new cohort) is its own announcement.
    await pool().query("UPDATE policy_assignments SET due_at = now() + interval '1 day' WHERE document_id = $1", [id]);
    const third = await emitPolicyDeadlines({ documentIds: [id], defaults: D });
    assert.deepEqual(third, { policies: 1, announced: 1, skipped: null });
    assert.equal(postsTo("all", id).length, 2);
    assert.equal(postsTo("all", id)[1].body.policy.days, 1);

    // Outside the window: not yet.
    await pool().query("UPDATE policy_assignments SET due_at = now() + interval '10 days' WHERE document_id = $1", [id]);
    assert.deepEqual(await emitPolicyDeadlines({ documentIds: [id], defaults: D }), { policies: 0, announced: 0, skipped: null });
    // The policy's own remind_before_days widens it.
    await fixtureQuery(
      "INSERT INTO policy_settings (document_id, remind_before_days) VALUES ($1, 12) ON CONFLICT (document_id) DO UPDATE SET remind_before_days = 12",
      [id]
    );
    assert.deepEqual(await emitPolicyDeadlines({ documentIds: [id], defaults: D }), { policies: 1, announced: 1, skipped: null });
    assert.equal(postsTo("all", id).length, 3);
  });

  test("retirePolicy emits 'retired by, replaced by' with the counts frozen at retirement", async () => {
    const old = await newDoc("Travel policy (old)");
    const next = await newDoc("Expenses and travel");
    const v1 = (await listVersions(old))[0].id;
    await recordAcknowledgement(old, people.alice, "", v1);
    const named = await setSupersededBy(old, next);
    assert.equal(named.ok, true);
    const r = await retirePolicy(old, actor(), "Superseded by the combined policy");
    assert.ok(r);
    const got = await waitFor(() => postsTo("all", old), 1);
    assert.equal(got.length, 1);
    assert.equal(got[0].body.event, "policy.retired");
    assert.equal(got[0].body.actor, actor().name);
    assert.deepEqual(got[0].body.policy.superseded_by, { id: next, title: titles[next] });
    assert.deepEqual(got[0].body.policy.counts, { required: 4, acked: 1, overdue: 0 });
    assert.equal(postsTo("q", old).length, 0);
    const text = posts.find((p) => p.url === hookUrl("md") && (p.body.markdown as string).includes(`**“${titles[old]}”** was retired`))!.body.markdown as string;
    assert.ok(text.includes(`**“${titles[old]}”** was retired by ${actor().name}; replaced by **“${titles[next]}”**.`), text);
    assert.equal(await emitPolicyRetired(next, actor(), null), true);
    const alone = postsTo("all", next).find((p) => p.body.event === "policy.retired")!;
    assert.equal(alone.body.policy.superseded_by, null);
  });

  test("the annual cycle emits policy.requested with cycle 'annual' and the audience it re-asked", async () => {
    const id = await newDoc("Information security");
    await pool().query("UPDATE documents SET ack_recert_months = 12, ack_next_recert_at = now() - interval '1 minute' WHERE id = $1", [id]);
    const r = await recertifyDueAcks({ documentIds: [id], defaults: {} });
    assert.equal(r.cycles, 1);
    const got = await waitFor(() => postsTo("all", id), 1);
    assert.equal(got.length, 1);
    assert.equal(got[0].body.event, "policy.requested");
    assert.equal(got[0].body.policy.cycle, "annual");
    assert.equal(got[0].body.policy.people, 4);
    assert.equal(got[0].body.actor, "Scheduler");
    const text = posts.find((p) => p.url === hookUrl("md") && (p.body.markdown as string).includes(`Annual re-confirmation of **“${titles[id]}”**`))!.body.markdown as string;
    assert.ok(text.includes(`Annual re-confirmation of **“${titles[id]}”** started: 4 people to confirm.`), text);
  });

  test("the weekly summary goes to hooks with no space filter only, once per period, and burns no claim while nobody listens", async () => {
    const wk = await hook("wk", ["policy.weekly_summary"]);
    const wkMd = await hook("wkmd", ["policy.weekly_summary"], { format: "webex" });
    const wkP = await hook("wkp", ["policy.weekly_summary"], { spaceIds: [spaceP] });
    const now = new Date();
    const period = `${STAMP}w1`;
    const monthly = (await listComplianceSnapshots(100)).find((s) => s.kind === "monthly" && s.period === monthId(now)) ?? null;
    const r = await weeklyPolicyChannelSummary({ now, period });
    assert.equal(r.skipped, null);
    assert.equal(r.sent, 2, "the two unscoped hooks");
    assert.equal(r.period, period);
    assert.equal(postsTo("wk").length, 1);
    assert.equal(postsTo("wkmd").length, 1);
    assert.equal(postsTo("wkp").length, 0, "a scoped hook never gets the workspace total");
    const body = postsTo("wk")[0].body;
    assert.equal(body.event, "policy.weekly_summary");
    assert.equal(body.title, "Policy compliance this week");
    assert.equal(body.summary.week, period);
    assert.ok(Number.isInteger(body.summary.pct) && body.summary.pct >= 0 && body.summary.pct <= 100);
    assert.ok(body.summary.policies >= 1, "this file's live policies are in the count");
    assert.equal(body.summary.snapshot_sha256, monthly?.sha256 ?? null);
    assert.ok(!("policy" in body));
    const text = postsTo("wkmd")[0].body.markdown as string;
    assert.ok(text.startsWith("📊 **CompassDocs — Compliance summary**"), text);
    assert.ok(text.includes(`Policy compliance this week: ${body.summary.pct}% · ${body.summary.overdue} overdue across ${body.summary.policies} `), text);
    assert.equal(text.includes("Monthly snapshot sha256 "), monthly !== null);

    const again = await weeklyPolicyChannelSummary({ now, period });
    assert.equal(again.skipped, "claimed");
    assert.equal(postsTo("wk").length, 1, "once per period");

    for (const h of [wk, wkMd, wkP]) await deleteWebhook(h);
    const nobody = await weeklyPolicyChannelSummary({ now, period: `${STAMP}w2` });
    assert.equal(nobody.skipped, "no_hooks");
    const wk2 = await hook("wk2", ["policy.weekly_summary"]);
    const later = await weeklyPolicyChannelSummary({ now, period: `${STAMP}w2` });
    assert.equal(later.skipped, null, "the period was not burned while nobody listened");
    assert.equal(later.sent, 1);
    assert.equal(postsTo("wk2").length, 1);
    await deleteWebhook(wk2);
  });

  test("an unlicensed workspace emits nothing", async () => {
    const id = await newDoc("Unlicensed");
    const was = edition.features;
    edition.features = [];
    try {
      assert.equal(await emitPolicyRequested(id, { actor: actor().name, people: 4 }), false);
      assert.equal(await emitPolicyEscalated(id, 1), false);
      assert.equal(await emitPolicyRetired(id, actor(), null), false);
      assert.equal((await emitPolicyDeadlines({ documentIds: [id], defaults: D })).skipped, "unlicensed");
      assert.equal((await weeklyPolicyChannelSummary({ period: `${STAMP}w3` })).skipped, "unlicensed");
    } finally {
      edition.features = was;
    }
    assert.equal(postsTo("all", id).length, 0);
    assert.equal(await emitPolicyRequested(999999999, { actor: "x", people: 1 }), false, "a policy that is gone");
  });

  test("no payload of any event names a person: counts and titles only", () => {
    assert.ok(generics.length >= 8, `every event was delivered at least once (${generics.length})`);
    const events = new Set(generics.map((g) => g.event));
    for (const ev of ["policy.requested", "policy.deadline_approaching", "policy.escalated", "policy.weekly_summary", "policy.retired"]) {
      assert.ok(events.has(ev), `${ev} was delivered`);
    }
    for (const g of generics) {
      const json = JSON.stringify(g);
      assert.ok(!json.includes("PERSON"), `a person's name in ${g.event}: ${json}`);
      assert.ok(!json.includes("@example.test"), `an email in ${g.event}: ${json}`);
      assert.ok(!json.includes(`${STAMP}-`), `a username in ${g.event}: ${json}`);
    }
  });
});
