// The weekly team digest (F4, 1.14.0) from the neutral orchestrator
// (lib/periodic): with training unlicensed the Policies section still
// sends; with both licensed one email carries both sections; two
// runPeriodic calls in parallel send once (the settings-table claim); an
// override saved without {{policy_summary}} renders without the section;
// SMTP missing sends nothing and burns no claim; the setting off leaves the
// Policies section out; a lead of a broad group reads a count, not a
// private title; each digest with policies writes one 'digest' notice row.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/team-digest.test.ts

// lib/ee as a licensed build sees it, with the features switchable per test.
import "./support/ee-stub";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { edition } from "./support/ee-stub";
import {
  pool,
  getSetting,
  setSetting,
  createDocument,
  createGroup,
  addGroupMember,
  setGroupLeads,
  setSpaceGroups,
  claimPeriod,
  claimTrainingPeriod,
} from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";
import { saveTemplateOverride, resetTemplate, templateDef, SAMPLE_VARS, renderEmail } from "../src/lib/email-templates";
import { runPeriodic, isoWeekId, monthId } from "../src/lib/periodic";
import { weeklyTeamDigest, TEAM_DIGEST_CLAIM_KEY, policySummaryLines, trainingSummaryLines } from "../src/lib/team-digest";
import type { Mailer } from "../src/lib/compliance";

const STAMP = `teamdig-${Date.now()}`;
const SETTINGS_LOCK = 728342;
const TEXT = Array.from({ length: 8 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");

let internalSpaceId = 0;
let privateSpaceId = 0;
let groupId = 0;
let leadId = 0;
let m1 = 0;
let m2 = 0;
let policyA = 0;
let policyB = 0;
const docIds: number[] = [];
const userIds: number[] = [];
let lockClient: PoolClient | null = null;
let savedDefaults: string | undefined;
let savedClaim: string | undefined;
let savedOverride: string | undefined;
let periods = 0;

/** A period no real week has and no other run of this file reuses. */
const period = () => `${STAMP}-P${++periods}`;

interface Sent {
  to: string;
  subject: string;
  text: string;
}
function mailer(sent: Sent[]): Mailer {
  return async (to, subject, text) => {
    for (const t of to) sent.push({ to: t, subject, text });
  };
}

async function user(suffix: string, name: string): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP}-${suffix}`, name, `${STAMP}-${suffix}@example.test`]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function policy(spaceId: number, title: string): Promise<number> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content: TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  await switchOn(doc.id, { editDefault: null, recertMonths: null });
  docIds.push(doc.id);
  return doc.id;
}

async function leadsSeePolicies(on: boolean) {
  const stored = JSON.parse((await getSetting("ack_defaults")) || "{}");
  await setSetting("ack_defaults", JSON.stringify({ ...stored, leads_see_policies: on }));
}

const digestNotices = async () =>
  (
    await pool().query<{ user_id: number; kind: string; channels: string[]; document_id: number | null; document_title: string; by_name: string }>(
      "SELECT user_id, kind, channels, document_id, document_title, by_name FROM ack_notices WHERE user_id = $1 AND kind = 'digest' ORDER BY id",
      [leadId]
    )
  ).rows;

before(async () => {
  await getSetting("__schema_bootstrap__");
  const client = await pool().connect();
  await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
  lockClient = client;
  savedDefaults = await getSetting("ack_defaults");
  savedClaim = await getSetting(TEAM_DIGEST_CLAIM_KEY);
  savedOverride = await getSetting("email_tpl_training_team_digest");

  const internal = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Digest ${STAMP}`, `${STAMP}-int`]
  );
  internalSpaceId = internal.rows[0].id;
  const priv = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '🔒', '', 'private') RETURNING id`,
    [`Digest private ${STAMP}`, `${STAMP}-priv`]
  );
  privateSpaceId = priv.rows[0].id;

  leadId = await user("lead", "Dana Lead");
  m1 = await user("m1", "Ana Member");
  m2 = await user("m2", "Ben Member");
  groupId = (await createGroup({ name: `Support ${STAMP}` })).id;
  await addGroupMember(groupId, m1);
  await addGroupMember(groupId, m2);
  await setGroupLeads(groupId, [leadId]);
  await setSpaceGroups(privateSpaceId, [groupId]);

  policyA = await policy(internalSpaceId, `${STAMP} Code of conduct`);
  policyB = await policy(privateSpaceId, `${STAMP} Private handling`);
  // Both members overdue on A (Ben the longer), nobody confirmed anything.
  await pool().query("UPDATE policy_assignments SET due_at = now() - interval '20 days' WHERE document_id = $1 AND user_id = $2", [policyA, m1]);
  await pool().query("UPDATE policy_assignments SET due_at = now() - interval '40 days' WHERE document_id = $1 AND user_id = $2", [policyA, m2]);
  await leadsSeePolicies(true);
});

after(async () => {
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [[internalSpaceId, privateSpaceId]]);
  if (savedDefaults === undefined) await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");
  else await setSetting("ack_defaults", savedDefaults);
  if (savedClaim === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [TEAM_DIGEST_CLAIM_KEY]);
  else await setSetting(TEAM_DIGEST_CLAIM_KEY, savedClaim);
  if (savedOverride === undefined) await pool().query("DELETE FROM settings WHERE key = 'email_tpl_training_team_digest'");
  else await setSetting("email_tpl_training_team_digest", savedOverride);
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
    lockClient.release();
  }
});

describe("lib/periodic (pure)", () => {
  test("isoWeekId and monthId are UTC and zero-padded; claimPeriod wins once per value and the old name still answers", async () => {
    assert.equal(isoWeekId(new Date("2026-01-01T00:00:00Z")), "2026-W01");
    assert.equal(isoWeekId(new Date("2024-12-30T23:59:59Z")), "2025-W01", "the ISO year of a December Monday");
    assert.equal(isoWeekId(new Date("2026-10-20T12:00:00Z")), "2026-W43");
    assert.equal(monthId(new Date("2026-03-05T23:30:00Z")), "2026-03");
    assert.equal(monthId(new Date("2026-12-31T23:59:59Z")), "2026-12");
    const key = `${STAMP}-claim`;
    try {
      assert.equal(await claimPeriod(key, "a"), true);
      assert.equal(await claimPeriod(key, "a"), false, "the same period again loses");
      assert.equal(await claimTrainingPeriod(key, "b"), true, "the 1.13.0 name is the same claim");
      assert.equal(await claimPeriod(key, "b"), false);
    } finally {
      await pool().query("DELETE FROM settings WHERE key = $1", [key]);
    }
  });

  test("the template documents its tags, the sample renders with none left showing, and the subject is neutral", async () => {
    const def = templateDef("training_team_digest")!;
    assert.ok(def.tags.some((t) => t.tag === "policy_summary"));
    assert.equal(def.subject, "[{{org_name}}] Your team this week");
    for (const used of def.body.match(/\{\{(\w+)\}\}/g) ?? []) {
      assert.ok(def.tags.some((t) => t.tag === used.slice(2, -2)), `${used} is documented`);
    }
    const vars = SAMPLE_VARS.training_team_digest;
    for (const { tag } of def.tags) if (tag !== "org_name") assert.ok(tag in vars, `the sample carries ${tag}`);
    const { subject, text } = await renderEmail("training_team_digest", vars, "https://docs.example.test");
    assert.doesNotMatch(subject + text, /\{\{/);
    assert.doesNotMatch(subject + text, /acknowledg|attest/i);
  });

  test("the section lines", () => {
    assert.equal(trainingSummaryLines([]), "- No training activity this week.");
    const groups = [{ id: 1, name: "Support" }];
    const row = (user_id: number, user_name: string, status: "confirmed" | "pending" | "overdue" | "exempt" | null, due_at: string | null, id: number | null) => ({
      group_id: 1,
      group_name: "Support",
      user_id,
      user_name,
      username: user_name.toLowerCase(),
      assignment_id: id,
      document_id: id,
      title: id ? `Policy ${id}` : null,
      space_id: 1,
      status,
      due_at,
      acknowledged_at: null,
      reminded_at: null,
      hidden_count: 0,
    });
    const lines = policySummaryLines(
      groups,
      [
        row(1, "Ana", "overdue", "2026-10-03T00:00:00Z", 11),
        row(2, "Ben", "overdue", "2026-10-01T00:00:00Z", 12),
        row(3, "Cy", "pending", null, 13),
        row(4, "Di", "confirmed", null, 14),
        row(5, "Ed", "exempt", null, 15),
        row(6, "Flo", null, null, null),
        row(7, "Gus", "overdue", "2026-10-09T00:00:00Z", 17),
        row(8, "Hal", "overdue", "2026-10-11T00:00:00Z", 18),
      ],
      (iso) => iso.slice(0, 10)
    );
    assert.equal(
      lines,
      [
        "**Policies**",
        "- **Support**: 1 confirmed · 5 open · **4 overdue**",
        "",
        "Most overdue:",
        "- Ben · Policy 12 · due 2026-10-01",
        "- Ana · Policy 11 · due 2026-10-03",
        "- Gus · Policy 17 · due 2026-10-09",
      ].join("\n")
    );
    assert.equal(policySummaryLines([], [], (iso) => iso), "**Policies**\n- No policies to confirm.");
  });
});

describe("the weekly team digest", () => {
  test("training unlicensed: the Policies section still sends, scoped to the lead; one 'digest' notice row per lead", async () => {
    edition.features = ["policy_ack"];
    const sent: Sent[] = [];
    const r = await weeklyTeamDigest({ mailer: mailer(sent), leadIds: [leadId], period: period() });
    assert.equal(r.skipped, null, JSON.stringify(r));
    assert.deepEqual(r.sections, { training: false, policies: true });
    assert.equal(r.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, `${STAMP}-lead@example.test`);
    assert.match(sent[0].subject, /Your team this week$/);
    assert.match(sent[0].text, /Policies/);
    assert.match(sent[0].text, new RegExp(`Support ${STAMP}: 0 confirmed · 2 open · 2 overdue`));
    assert.match(sent[0].text, /Most overdue:/);
    assert.ok(sent[0].text.indexOf("Ben Member") < sent[0].text.indexOf("Ana Member"), "the longest overdue first");
    assert.match(sent[0].text, new RegExp(`Ben Member · ${STAMP} Code of conduct · due `));
    assert.doesNotMatch(sent[0].text, /Private handling/, "the private-space policy is never named");
    assert.doesNotMatch(sent[0].text, /Training/, "no training section without the licence");
    assert.match(sent[0].text, /\/compliance\/team/);
    const notices = await digestNotices();
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0], { user_id: leadId, kind: "digest", channels: ["email"], document_id: null, document_title: "Weekly team digest", by_name: "system" });
  });

  test("both licensed: one email with both sections; the setting off leaves the Policies section out", async () => {
    edition.features = ["policy_ack", "training"];
    let sent: Sent[] = [];
    let r = await weeklyTeamDigest({ mailer: mailer(sent), leadIds: [leadId], period: period() });
    assert.deepEqual(r.sections, { training: true, policies: true });
    assert.equal(sent.length, 1, "one email, not one per section");
    assert.match(sent[0].text, /Training/);
    assert.match(sent[0].text, /No training activity this week|done · /);
    assert.match(sent[0].text, /Policies/);
    assert.match(sent[0].text, /2 overdue/);
    assert.equal((await digestNotices()).length, 2);

    await leadsSeePolicies(false);
    sent = [];
    r = await weeklyTeamDigest({ mailer: mailer(sent), leadIds: [leadId], period: period() });
    assert.deepEqual(r.sections, { training: true, policies: false });
    assert.equal(sent.length, 1, "the training digest still goes");
    assert.doesNotMatch(sent[0].text, /Policies/);
    assert.doesNotMatch(sent[0].text, /Training/, "a training-only digest reads as it did in 1.13.0: no heading");
    assert.match(sent[0].text, /done · /, "the 1.13.0 lines");
    assert.match(sent[0].text, /\/training\/team/);
    assert.equal((await digestNotices()).length, 2, "no notice row without the policies section");

    // Training alone unlicensed and the setting off: nothing to say, no claim.
    edition.features = ["policy_ack"];
    sent = [];
    const p = period();
    r = await weeklyTeamDigest({ mailer: mailer(sent), leadIds: [leadId], period: p });
    assert.equal(r.skipped, "nothing_to_say");
    assert.equal(sent.length, 0);
    assert.notEqual(await getSetting(TEAM_DIGEST_CLAIM_KEY), p, "the week is not claimed");
    await leadsSeePolicies(true);
  });

  test("no SMTP: nothing is sent and the week is not claimed; neither licence: unlicensed", async () => {
    edition.features = ["policy_ack"];
    const p = period();
    const r = await weeklyTeamDigest({ mailer: null, leadIds: [leadId], period: p });
    assert.equal(r.skipped, "no_smtp");
    assert.equal(r.leads, 1);
    assert.notEqual(await getSetting(TEAM_DIGEST_CLAIM_KEY), p, "the claim is checked after SMTP");
    edition.features = [];
    const sent: Sent[] = [];
    assert.equal((await weeklyTeamDigest({ mailer: mailer(sent), leadIds: [leadId], period: period() })).skipped, "unlicensed");
    assert.equal(sent.length, 0);
    edition.features = ["policy_ack"];
  });

  test("two runPeriodic calls in parallel send once (the claim is the only gate); the step reports what ran", async () => {
    edition.features = ["policy_ack"];
    const sent: Sent[] = [];
    const p = period();
    const opts = { only: ["team_digest" as const], digest: { mailer: mailer(sent), leadIds: [leadId], period: p } };
    const [a, b] = await Promise.all([runPeriodic(opts), runPeriodic(opts)]);
    assert.deepEqual(a.ran, ["team_digest"]);
    assert.deepEqual(b.ran, ["team_digest"]);
    assert.deepEqual([...a.failed, ...b.failed], []);
    assert.equal(sent.length, 1, `one email between the two calls (${sent.length})`);
    assert.equal(await getSetting(TEAM_DIGEST_CLAIM_KEY), p);
    // And a third call for the same period sends nothing.
    const again = await weeklyTeamDigest({ mailer: mailer(sent), leadIds: [leadId], period: p });
    assert.equal(again.skipped, "claimed");
    assert.equal(sent.length, 1);
  });

  test("an override saved without {{policy_summary}} renders without the section; one with it shows it", async () => {
    edition.features = ["policy_ack", "training"];
    await saveTemplateOverride("training_team_digest", "Team week for {{lead_name}}", "Hello {{lead_name}}\n\n{{summary}}\n\n[Team]({{team_url}})");
    try {
      let sent: Sent[] = [];
      await weeklyTeamDigest({ mailer: mailer(sent), leadIds: [leadId], period: period() });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].subject, "Team week for Dana Lead");
      assert.doesNotMatch(sent[0].text, /Policies|overdue/, "the old override shows no policies");
      assert.doesNotMatch(sent[0].text, /\{\{/);
      await saveTemplateOverride("training_team_digest", "Team week for {{lead_name}}", "Hello {{lead_name}}\n\n{{summary}}\n\n{{policy_summary}}");
      sent = [];
      await weeklyTeamDigest({ mailer: mailer(sent), leadIds: [leadId], period: period() });
      assert.match(sent[0].text, /Policies/);
      assert.match(sent[0].text, /2 overdue/);
    } finally {
      await resetTemplate("training_team_digest");
    }
  });

  test("a mail the server refuses is not counted and does not stop the loop", async () => {
    edition.features = ["policy_ack"];
    const failing: Mailer = async () => {
      throw new Error("550 mailbox unavailable");
    };
    const before = (await digestNotices()).length;
    const r = await weeklyTeamDigest({ mailer: failing, leadIds: [leadId], period: period() });
    assert.equal(r.skipped, null);
    assert.equal(r.sent, 0);
    assert.equal((await digestNotices()).length, before, "no notice row for a mail that was not accepted");
  });
});
