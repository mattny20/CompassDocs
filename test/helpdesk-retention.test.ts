// Helpdesk 1.19.1 retention and privacy (agent V5, mock-up #6): auto-close,
// anonymise or delete after a retention period, legal hold, account
// removal and the personal data export.
//
//   - the dry run lists exactly what the run then does
//   - open tickets are never touched; legal hold blocks closing and both purges
//   - anonymising keeps what reports count (reportSummary is identical) and
//     removes names, emails, message text, answers and files (bytes too)
//   - delete removes the rows and the files
//   - removing an account anonymises their tickets as requester and CC;
//     agents' replies keep the agents' names
//   - the export has their requests and the public conversation only
//
// Parallel-safe: every run is limited to this file's own tickets (`only`)
// and passes its settings explicitly, so no workspace setting is written
// and nobody else's ticket can be touched. Files go to a scratch uploads
// folder. Everything this file creates is removed afterwards.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-retention.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const UPLOADS = mkdtempSync(path.join(tmpdir(), "hd-retention-"));
process.env.COMPASSDOCS_UPLOAD_DIR = UPLOADS;

import { pool, getSetting, deleteUser } from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import { anonymiseRemovedAccount, personalHelpdeskExport, planRetention, runRetention } from "../src/lib/helpdesk/retention";
import { HD_FORMER_REQUESTER, HD_RETENTION_DEFAULTS, normalizeRetention, planSentence, retentionCutoff, retentionPatchError } from "../src/lib/helpdesk/retention-shared";
import type { HdRetentionSettings } from "../src/lib/helpdesk/retention-shared";
import { saveHelpdeskAttachment } from "../src/lib/helpdesk/attachments";
import { reportSummary } from "../src/lib/helpdesk/reports";

const STAMP = `hdret-${Date.now()}-${process.pid}`;
const NOW = new Date("2026-11-07T02:05:00Z");
// Both rules on (they default to off; see "off by default" below).
const ANON: HdRetentionSettings = { ...HD_RETENTION_DEFAULTS, auto_close_enabled: true, retention_enabled: true, auto_close_days: 7, keep_amount: 3, keep_unit: "years", action: "anonymise" };
const DEL: HdRetentionSettings = { ...ANON, action: "delete" };

let teamId = 0;
let agentId = 0;
let requesterId = 0;
let ccId = 0;
const userIds: number[] = [];
const ticketIds: number[] = [];

async function user(key: string, name: string): Promise<number> {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    `${STAMP}-${key}@example.test`,
  ]);
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

interface TicketOpts {
  status: string;
  requester?: number | null;
  requesterEmail?: string;
  createdAt?: string;
  solvedAt?: string | null;
  closedAt?: string | null;
  hold?: boolean;
}

/** A ticket with a requester message, an agent reply, an internal note and a held reply. */
async function ticket(o: TicketOpts): Promise<number> {
  const r = await pool().query(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, priority, created_at, solved_at, closed_at,
                             form_answers, csat_score, csat_comment, csat_at, legal_hold, tags, first_replied_at)
     VALUES ($1, $2, 'Rita Requester', $3, $4, $5, 'high', $6, $7, $8, '{"reason":"My payslip is wrong"}', 5, 'Thanks Rita here', $7, $9, '{payroll}', $6::timestamptz + interval '1 hour')
     RETURNING id`,
    [
      `${STAMP} payslip for Rita`,
      o.requester === undefined ? requesterId : o.requester,
      o.requesterEmail ?? `${STAMP}-rita@example.test`,
      teamId,
      o.status,
      o.createdAt ?? "2022-01-10T10:00:00Z",
      o.solvedAt === undefined ? (o.status === "open" ? null : "2022-01-11T10:00:00Z") : o.solvedAt,
      o.closedAt === undefined ? (o.status === "closed" ? "2022-01-18T10:00:00Z" : null) : o.closedAt,
      o.hold ? 1 : 0,
    ]
  );
  const id = r.rows[0].id as number;
  ticketIds.push(id);
  const m = async (author: number | null, name: string, email: string, kind: string, body: string, via: string, review: string | null = null) =>
    pool().query(
      `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via, review_state, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id`,
      [id, author, name, email, kind, body, via, review]
    );
  await m(o.requester === undefined ? requesterId : o.requester, "Rita Requester", o.requesterEmail ?? `${STAMP}-rita@example.test`, "public", "My payslip shows the wrong salary.", "portal");
  await m(agentId, "Andy Agent", "", "public", "Fixed it, Rita.", "desk");
  await m(agentId, "Andy Agent", "", "internal", "Rita's salary is 50k.", "desk");
  await m(agentId, "Andy Agent", "", "public", "A held reply.", "desk", "pending");
  return id;
}

const row = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const msgs = async (id: number) =>
  (await pool().query("SELECT author_id, author_name, author_email, kind, body, attachments FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [id])).rows;

before(async () => {
  await getSetting("__schema_bootstrap__");
  agentId = await user("agent", "Andy Agent");
  requesterId = await user("rita", "Rita Requester");
  ccId = await user("cc", "Cora Copied");
  teamId = (await pool().query("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} Payroll`])).rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent')", [teamId, agentId]);
});

after(async () => {
  if (ticketIds.length) await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1::int[])", [ticketIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = $1", [teamId]);
  await pool().query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]);
  rmSync(UPLOADS, { recursive: true, force: true });
  await pool().end();
});

describe("settings", () => {
  test("defaults, clamping and the patch check", () => {
    assert.deepEqual(normalizeRetention(null), HD_RETENTION_DEFAULTS);
    assert.equal(HD_RETENTION_DEFAULTS.auto_close_days, 7);
    assert.equal(HD_RETENTION_DEFAULTS.action, "anonymise");
    // Owner decision (1.19.1): nothing destructive on upgrade. Both rules are off until an admin turns them on.
    assert.equal(HD_RETENTION_DEFAULTS.auto_close_enabled, false);
    assert.equal(HD_RETENTION_DEFAULTS.retention_enabled, false);
    assert.equal(HD_RETENTION_DEFAULTS.anonymise_on_account_removal, true, "account removal still anonymises");
    const stored = normalizeRetention({ auto_close_days: 3, keep_amount: 1, keep_unit: "years", action: "delete" });
    assert.equal(stored.auto_close_enabled, false, "a stored value without the switches reads as off");
    assert.equal(stored.retention_enabled, false);
    assert.equal(normalizeRetention({ auto_close_enabled: "yes" }).auto_close_enabled, false, "only true turns a rule on");
    assert.equal(retentionPatchError({ retention_enabled: 1 }), "Switches are on or off.");
    assert.equal(retentionPatchError({ auto_close_enabled: true, retention_enabled: false }), null);
    assert.deepEqual(normalizeRetention({ auto_close_days: 0, keep_unit: "weeks", action: "shred" }), HD_RETENTION_DEFAULTS);
    assert.equal(retentionPatchError({ auto_close_days: 400 }), "Close solved tickets after 1 to 365 days.");
    assert.equal(retentionPatchError({ keep_amount: 30, keep_unit: "years" }), "Keep closed tickets for 1 to 20 years.");
    assert.equal(retentionPatchError({ nope: 1 }), 'There is no retention setting called "nope".');
    assert.equal(retentionPatchError({ keep_amount: 18, keep_unit: "months", action: "delete" }), null);
    assert.equal(retentionCutoff({ keep_amount: 1, keep_unit: "months" }, new Date("2026-03-31T00:00:00Z")).toISOString(), "2026-02-28T00:00:00.000Z");
    assert.equal(
      planSentence({ counts: { close: 41, anonymise: 312, delete: 0, held: 0 }, purge_before: "2023-11-07T02:05:00Z", action: "anonymise" }),
      "Tonight: 41 tickets close, 312 are anonymised (closed before Nov 2023). Nothing is deleted."
    );
    assert.match(
      planSentence({ enabled: { close: false, purge: false }, counts: { close: 0, anonymise: 0, delete: 0, held: 0 }, purge_before: "2023-11-07T02:05:00Z", action: "anonymise" }),
      /^Both rules are off/
    );
  });
});

describe("off by default", () => {
  test("with the defaults the preview and the run touch nothing; each rule runs only when it is on", async () => {
    const solvedOld = await ticket({ status: "solved", createdAt: "2026-10-01T10:00:00Z", solvedAt: "2026-10-20T10:00:00Z" });
    const closedOld = await ticket({ status: "closed" });
    const mine = [solvedOld, closedOld];
    const subject = async (id: number) => (await pool().query("SELECT status, subject, anonymised_at FROM hd_tickets WHERE id = $1", [id])).rows[0];
    const before = await subject(closedOld);

    const plan = await planRetention({ at: NOW, settings: HD_RETENTION_DEFAULTS, only: mine, withIds: true });
    assert.deepEqual(plan.enabled, { close: false, purge: false });
    assert.deepEqual(plan.counts, { close: 0, anonymise: 0, delete: 0, held: 0 });
    assert.deepEqual(plan.ids, { close: [], purge: [] });
    assert.deepEqual(plan.items, []);
    const ran = await runRetention({ now: NOW, settings: HD_RETENTION_DEFAULTS, only: mine });
    assert.deepEqual([ran.closed, ran.anonymised, ran.deleted], [[], [], []]);
    assert.equal((await subject(solvedOld)).status, "solved");
    assert.deepEqual(await subject(closedOld), before, "nothing anonymised");

    // Auto-close on, retention off: only the solved ticket closes.
    const closeOnly = { ...HD_RETENTION_DEFAULTS, auto_close_enabled: true };
    const p2 = await planRetention({ at: NOW, settings: closeOnly, only: mine, withIds: true });
    assert.deepEqual(p2.ids, { close: [solvedOld], purge: [] });
    const r2 = await runRetention({ now: NOW, settings: closeOnly, only: mine });
    assert.deepEqual([r2.closed, r2.anonymised, r2.deleted], [[solvedOld], [], []]);
    assert.equal((await subject(closedOld)).anonymised_at, null, "the retention period is still off");

    // Retention on, auto-close off: the old closed ticket is anonymised; nothing closes.
    const purgeOnly = { ...HD_RETENTION_DEFAULTS, retention_enabled: true };
    const p3 = await planRetention({ at: NOW, settings: purgeOnly, only: [closedOld], withIds: true });
    assert.deepEqual(p3.ids, { close: [], purge: [closedOld] });
    const r3 = await runRetention({ now: NOW, settings: purgeOnly, only: [closedOld] });
    assert.deepEqual(r3.anonymised, [closedOld]);
  });
});

describe("the run", () => {
  test("the dry run equals the real run; open tickets and legal holds are never touched", async () => {
    const solvedOld = await ticket({ status: "solved", createdAt: "2026-10-01T10:00:00Z", solvedAt: "2026-10-20T10:00:00Z" });
    const solvedNew = await ticket({ status: "solved", createdAt: "2026-11-01T10:00:00Z", solvedAt: "2026-11-05T10:00:00Z" });
    const closedOld = await ticket({ status: "closed" });
    const closedNew = await ticket({ status: "closed", createdAt: "2025-01-01T10:00:00Z", solvedAt: "2025-01-02T10:00:00Z", closedAt: "2025-01-09T10:00:00Z" });
    const openOld = await ticket({ status: "open", createdAt: "2020-01-01T10:00:00Z" });
    const pendingOld = await ticket({ status: "pending", createdAt: "2020-01-01T10:00:00Z" });
    const heldSolved = await ticket({ status: "solved", createdAt: "2026-10-01T10:00:00Z", solvedAt: "2026-10-20T10:00:00Z", hold: true });
    const heldClosed = await ticket({ status: "closed", hold: true });
    const mine = [solvedOld, solvedNew, closedOld, closedNew, openOld, pendingOld, heldSolved, heldClosed];

    const plan = await planRetention({ at: NOW, settings: ANON, only: mine, withIds: true });
    assert.deepEqual(plan.ids, { close: [solvedOld], purge: [closedOld] });
    assert.deepEqual(plan.counts, { close: 1, anonymise: 1, delete: 0, held: 2 });
    assert.deepEqual(plan.items.map((i) => [i.id, i.what]), [[solvedOld, "close"], [closedOld, "anonymise"]]);

    const ran = await runRetention({ now: NOW, settings: ANON, only: mine });
    assert.deepEqual(ran.closed, plan.ids!.close, "closed exactly what the preview listed");
    assert.deepEqual(ran.anonymised, plan.ids!.purge, "anonymised exactly what the preview listed");
    assert.deepEqual(ran.deleted, []);
    assert.deepEqual(ran.failed, []);

    const closed = await row(solvedOld);
    assert.equal(closed.status, "closed");
    assert.equal(new Date(closed.closed_at).toISOString(), NOW.toISOString());
    assert.match((await msgs(solvedOld)).at(-1).body, /^Closed automatically: solved 7 days ago/);
    for (const id of [solvedNew, closedNew, openOld, pendingOld, heldSolved, heldClosed]) {
      const r = await row(id);
      assert.equal(r.anonymised_at, null, `#${r.number} untouched`);
      assert.equal(r.requester_name, "Rita Requester");
    }
    assert.equal((await row(heldSolved)).status, "solved", "legal hold blocks closing");
    assert.equal((await row(openOld)).status, "open");
    assert.equal((await row(pendingOld)).status, "pending");

    // A second run finds nothing more.
    const again = await planRetention({ at: NOW, settings: ANON, only: mine, withIds: true });
    assert.deepEqual(again.ids, { close: [], purge: [] });
  });

  test("anonymise keeps report counts and removes names, text, answers and files", async () => {
    const id = await ticket({ status: "closed", createdAt: "2022-02-07T10:00:00Z", solvedAt: "2022-02-08T10:00:00Z", closedAt: "2022-02-15T10:00:00Z" });
    const att = await saveHelpdeskAttachment({ buf: Buffer.from("payslip contents"), filename: "payslip.txt", ticketId: id, userId: requesterId });
    const stored = (await pool().query("SELECT stored_name FROM hd_attachments WHERE id = $1", [att.id])).rows[0].stored_name as string;
    assert.ok(existsSync(path.join(UPLOADS, stored)));
    await pool().query("UPDATE hd_messages SET attachments = $2 WHERE ticket_id = $1 AND kind = 'public' AND author_id = $3", [
      id,
      JSON.stringify([{ id: att.id, filename: "payslip.txt" }]),
      requesterId,
    ]);
    const range = { from: "2022-02-01", to: "2022-02-28", team_id: teamId };
    const before = await reportSummary(range, { now: NOW.getTime() });
    const ran = await runRetention({ now: NOW, settings: ANON, only: [id] });
    assert.deepEqual(ran.anonymised, [id]);
    const afterSummary = await reportSummary(range, { now: NOW.getTime() });
    assert.deepEqual(afterSummary, before, "reports count it the same");

    const r = await row(id);
    assert.equal(r.subject, "Anonymised request");
    assert.equal(r.requester_id, null);
    assert.equal(r.requester_name, HD_FORMER_REQUESTER);
    assert.equal(r.requester_email, "");
    assert.deepEqual(r.form_answers, {});
    assert.equal(r.csat_comment, "");
    assert.equal(r.csat_score, 5, "the score stays for reports");
    assert.equal(r.priority, "high");
    assert.equal(r.team_id, teamId);
    assert.deepEqual(r.tags, ["payroll"]);
    assert.ok(r.anonymised_at);
    const m = await msgs(id);
    assert.equal(m.length, 5, "message rows stay (four plus the note it was anonymised)");
    assert.ok(m.slice(0, 4).every((x: { body: string }) => x.body === ""), "every body wiped");
    assert.equal(m[0].author_name, HD_FORMER_REQUESTER);
    assert.equal(m[0].author_id, null);
    assert.equal(m[1].author_name, "Andy Agent", "agents keep their names");
    assert.deepEqual(m[0].attachments, []);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_attachments WHERE ticket_id = $1", [id])).rows[0].n, 0);
    assert.equal(existsSync(path.join(UPLOADS, stored)), false, "the file is gone from the uploads volume");
  });

  // 1.19.4 (C7): delete moves the ticket to the recycle bin; the bin's purge removes the rows and files 30 days later.
  test("delete moves the ticket to the recycle bin; the bin's purge removes its rows and files", async () => {
    const id = await ticket({ status: "closed" });
    const att = await saveHelpdeskAttachment({ buf: Buffer.from("x"), filename: "a.txt", ticketId: id, userId: requesterId });
    const stored = (await pool().query("SELECT stored_name FROM hd_attachments WHERE id = $1", [att.id])).rows[0].stored_name as string;
    const plan = await planRetention({ at: NOW, settings: DEL, only: [id], withIds: true });
    assert.deepEqual(plan.counts, { close: 0, anonymise: 0, delete: 1, held: 0 });
    const ran = await runRetention({ now: NOW, settings: DEL, only: [id] });
    assert.deepEqual(ran.deleted, plan.ids!.purge);
    const binned = (await pool().query("SELECT deleted_at, deleted_by, deleted_by_name FROM hd_tickets WHERE id = $1", [id])).rows[0];
    assert.ok(binned?.deleted_at, "in the recycle bin");
    assert.equal(binned.deleted_by, null);
    assert.equal(binned.deleted_by_name, "Retention rule");
    assert.ok(existsSync(path.join(UPLOADS, stored)), "its file stays while it can be restored");
    // A binned ticket is not picked again.
    assert.deepEqual((await planRetention({ at: NOW, settings: DEL, only: [id], withIds: true })).ids!.purge, []);
    // 30 days on (the database's clock), the bin's purge removes it with its rows and files.
    await pool().query("UPDATE hd_tickets SET deleted_at = now() - interval '31 days' WHERE id = $1", [id]);
    const { purgeExpired } = await import("../src/lib/helpdesk/recycle-bin");
    assert.deepEqual((await purgeExpired({ only: [id] })).purged, [id]);
    assert.equal(await row(id), undefined);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1", [id])).rows[0].n, 0);
    assert.equal(existsSync(path.join(UPLOADS, stored)), false);
  });

  // 1.19.4 review (C7, high): retention's Delete bins only what its own rule selected. A closed request's
  // open task tickets stay live, as they did when the request was deleted outright (parent_ticket_id SET NULL).
  test("delete bins a closed request but never its open task tickets", async () => {
    const parent = await ticket({ status: "closed" });
    const task = await ticket({ status: "open" });
    await pool().query("UPDATE hd_tickets SET parent_ticket_id = $1, source = 'workflow' WHERE id = $2", [parent, task]);
    const ran = await runRetention({ now: NOW, settings: DEL, only: [parent, task] });
    assert.deepEqual(ran.deleted, [parent]);
    assert.ok((await row(parent)).deleted_at, "the closed request is in the bin");
    const t = await row(task);
    assert.equal(t.deleted_at, null, "its open task stays live");
    assert.equal(t.status, "open");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND body LIKE '%recycle bin%'", [task])).rows[0].n, 0);
  });

  test("delete also removes tickets anonymised earlier; anonymise skips them", async () => {
    const id = await ticket({ status: "closed" });
    await runRetention({ now: NOW, settings: ANON, only: [id] });
    assert.deepEqual((await planRetention({ at: NOW, settings: ANON, only: [id], withIds: true })).ids!.purge, []);
    assert.deepEqual((await planRetention({ at: NOW, settings: DEL, only: [id], withIds: true })).ids!.purge, [id]);
  });
});

describe("account removal and the data export", () => {
  test("the export holds their requests and the public conversation only", async () => {
    const who = await user("exp", "Ezra Export");
    const id = await ticket({ status: "open", requester: who, requesterEmail: `${STAMP}-exp@example.test` });
    const out = await personalHelpdeskExport(who);
    assert.equal(out.included, true);
    assert.equal(out.requests.length, 1);
    const r = out.requests[0];
    assert.equal(r.number, (await row(id)).number);
    assert.deepEqual(
      r.conversation.map((c) => c.text),
      ["My payslip shows the wrong salary.", "Fixed it, Rita."],
      "no internal note, no held reply"
    );
    assert.ok(!JSON.stringify(out).includes("50k"));
  });

  test("removing an account anonymises their tickets as requester and CC; agents keep their names", async () => {
    const own = await ticket({ status: "open", requester: requesterId });
    const ownClosed = await ticket({ status: "closed", requester: requesterId });
    const held = await ticket({ status: "closed", requester: requesterId, hold: true });
    const someoneElse = await user("else", "Sam Someone");
    const copied = await ticket({ status: "open", requester: someoneElse, requesterEmail: `${STAMP}-else@example.test` });
    const hasCcs = (await pool().query("SELECT to_regclass('hd_ticket_ccs') IS NOT NULL AS ok")).rows[0].ok as boolean;
    if (hasCcs) {
      await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, $2, '', 'Rita Requester')", [copied, requesterId]);
    }
    await pool().query(
      `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via) VALUES ($1, $2, 'Rita Requester', $3, 'public', 'Copying myself in.', 'portal')`,
      [copied, requesterId, `${STAMP}-rita@example.test`]
    );
    // deleteUser runs the anonymising first (lib/db hook), then removes the account.
    assert.equal(await deleteUser(requesterId), true);
    userIds.splice(userIds.indexOf(requesterId), 1);

    for (const id of [own, ownClosed]) {
      const r = await row(id);
      assert.ok(r.anonymised_at, "their request is anonymised, open or not");
      assert.equal(r.requester_name, HD_FORMER_REQUESTER);
      const m = await msgs(id);
      assert.equal(m[1].author_name, "Andy Agent");
      assert.ok(m.slice(0, 4).every((x: { body: string }) => x.body === ""));
    }
    assert.equal((await row(own)).status, "open", "status is left alone");
    const h = await row(held);
    assert.equal(h.anonymised_at, null, "legal hold keeps it");
    assert.equal(h.requester_name, "Rita Requester");
    if (hasCcs) {
      const c = await row(copied);
      assert.equal(c.anonymised_at, null, "someone else's request is not anonymised");
      assert.equal(c.requester_email, `${STAMP}-else@example.test`, "its own requester stays");
      const m = await msgs(copied);
      assert.equal(m[0].body, "My payslip shows the wrong salary.", "the requester's own message stays");
      assert.equal(m[1].body, "Fixed it, Rita.", "everyone else's messages stay");
      const theirs = m.at(-1);
      assert.equal(theirs.author_name, HD_FORMER_REQUESTER, "their message as a CC is anonymised");
      assert.equal(theirs.author_id, null);
      assert.equal(theirs.body, "");
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_ticket_ccs WHERE ticket_id = $1", [copied])).rows[0].n, 0);
    }
    const audits = (
      await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.anonymised' AND target_id = $1 ORDER BY id DESC LIMIT 1", [String(requesterId)])
    ).rows;
    assert.equal(audits[0]?.details.reason, "account_removed");
    // Rita requested earlier tests' tickets too: every one not on hold or already anonymised counts.
    assert.ok(audits[0]?.details.requester >= 2);
  });

  test("account removal does nothing for someone with no tickets", async () => {
    const nobody = await user("none", "Nell None");
    assert.deepEqual(await anonymiseRemovedAccount(nobody), { requester: 0, cc: 0 });
  });
});

// --- 1.19.1 review fixes -------------------------------------------------------------

const num = async (id: number) => (await row(id)).number as number;

describe("1.19.1 review: account removal", () => {
  test("a failed account delete changes nothing: the anonymising is in the same transaction", async () => {
    const who = await user("fkfail", "Fay Failing");
    const other = await user("fkother", "Otis Other");
    const id = await ticket({ status: "open", requester: who, requesterEmail: `${STAMP}-fkfail@example.test` });
    const att = await saveHelpdeskAttachment({ buf: Buffer.from("keep me"), filename: "k.txt", ticketId: id, userId: who });
    const stored = (await pool().query("SELECT stored_name FROM hd_attachments WHERE id = $1", [att.id])).rows[0].stored_name as string;
    // suggestions.resolved_by has no ON DELETE: the account delete fails on it.
    const sug = (await pool().query("INSERT INTO suggestions (body, created_by, resolved_by) VALUES ($1, $2, $3) RETURNING id", [`${STAMP} fk`, other, who])).rows[0].id;
    try {
      await assert.rejects(deleteUser(who));
      const r = await row(id);
      assert.equal(r.anonymised_at, null, "not anonymised");
      assert.equal(r.requester_id, who);
      assert.equal((await msgs(id))[0].body, "My payslip shows the wrong salary.");
      assert.ok(existsSync(path.join(UPLOADS, stored)), "the file is still there");
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM users WHERE id = $1", [who])).rows[0].n, 1);
    } finally {
      await pool().query("DELETE FROM suggestions WHERE id = $1", [sug]);
    }
  });

  test("their own messages and files go on tickets they are no longer copied on; held CC rows stay as name and address", async () => {
    const bob = await user("bob", "Bob Builder");
    const bobEmail = `${STAMP}-bob@example.test`;
    const someone = await user("bobreq", "Ada Asker");
    const t10 = await ticket({ status: "open", requester: someone, requesterEmail: `${STAMP}-bobreq@example.test` });
    const mid = (
      await pool().query(
        `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via) VALUES ($1, $2, 'Bob Builder', $3, 'public', 'Bob was here', 'portal') RETURNING id`,
        [t10, bob, bobEmail]
      )
    ).rows[0].id;
    const att = await saveHelpdeskAttachment({ buf: Buffer.from("bob's file"), filename: "bob.txt", ticketId: t10, userId: bob });
    await pool().query("UPDATE hd_attachments SET message_id = $2 WHERE id = $1", [att.id, mid]);
    const stored = (await pool().query("SELECT stored_name FROM hd_attachments WHERE id = $1", [att.id])).rows[0].stored_name as string;
    // No CC row on t10 (removed earlier). A held ticket where Bob is copied in.
    const held = await ticket({ status: "closed", requester: someone, requesterEmail: `${STAMP}-bobreq@example.test`, hold: true });
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, $2, $3, 'Bob Builder')", [held, bob, bobEmail]);

    assert.equal(await deleteUser(bob), true);
    userIds.splice(userIds.indexOf(bob), 1);
    const m = (await pool().query("SELECT author_id, author_name, author_email, body FROM hd_messages WHERE id = $1", [mid])).rows[0];
    assert.deepEqual(m, { author_id: null, author_name: HD_FORMER_REQUESTER, author_email: "", body: "" });
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_attachments WHERE id = $1", [att.id])).rows[0].n, 0);
    assert.equal(existsSync(path.join(UPLOADS, stored)), false, "the bytes are gone");
    assert.equal((await msgs(t10))[0].body, "My payslip shows the wrong salary.", "other people's messages stay");
    const cc = (await pool().query("SELECT user_id, email, name FROM hd_ticket_ccs WHERE ticket_id = $1", [held])).rows;
    assert.deepEqual(cc, [{ user_id: null, email: bobEmail, name: "Bob Builder" }], "the held ticket keeps the record");
  });
});

describe("1.19.1 review: anonymising", () => {
  test("report lines keep their text (names replaced); bells and audit rows lose the subject, names and addresses", async () => {
    const rita = await user("rita-lines", "Rita Requester");
    const id = await ticket({ status: "closed", requester: rita });
    const n = await num(id);
    const line = async (kind: string, body: string) =>
      (await pool().query("INSERT INTO hd_messages (ticket_id, author_name, kind, body, via) VALUES ($1, 'x', $2, $3, 'system') RETURNING id", [id, kind, body])).rows[0].id;
    const reopen = await line("system", "Rita Requester changed the status from Solved to Open");
    const took = await line("internal", "Andy Agent took the ticket");
    const cced = await line("system", "Rita Requester added Cora Copied as CC.");
    const bell = (
      await pool().query("INSERT INTO notifications (user_id, kind, title, body, link, actor_name) VALUES ($1, 'hd_request', $2, 'From Rita Requester', $3, 'Rita Requester') RETURNING id", [
        agentId,
        `New in Payroll: #${n} ${STAMP} payslip for Rita`,
        `/desk/tickets/${n}`,
      ])
    ).rows[0].id;
    const other = (
      await pool().query("INSERT INTO notifications (user_id, kind, title, link) VALUES ($1, 'hd_request', 'Another ticket', $2) RETURNING id", [agentId, `/desk/tickets/${n}0`])
    ).rows[0].id;
    const aud = (
      await pool().query(
        `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, target_label, details)
         VALUES ($1, 'Andy Agent', 'helpdesk.ticket.cc_added', 'helpdesk_ticket', $2, $3, $4) RETURNING id`,
        [agentId, String(id), `#${n} ${STAMP} payslip for Rita`, JSON.stringify({ ccs: [{ email: "vendor@outside.example.test" }, { user_id: ccId, name: "Rita Requester" }], via: "desk" })]
      )
    ).rows[0].id;
    try {
      assert.deepEqual((await runRetention({ now: NOW, settings: ANON, only: [id] })).anonymised, [id]);
      const body = async (mid: number) => (await pool().query("SELECT body FROM hd_messages WHERE id = $1", [mid])).rows[0].body;
      assert.equal(await body(reopen), `${HD_FORMER_REQUESTER} changed the status from Solved to Open`, "Reopened still counts it");
      assert.equal(await body(took), "Andy Agent took the ticket", "pick-up time still reads it");
      assert.equal(await body(cced), "", "other lines are blanked");
      const b = (await pool().query("SELECT title, body, actor_name FROM notifications WHERE id = $1", [bell])).rows[0];
      assert.deepEqual(b, { title: `#${n} Anonymised request`, body: "", actor_name: HD_FORMER_REQUESTER });
      assert.equal((await pool().query("SELECT title FROM notifications WHERE id = $1", [other])).rows[0].title, "Another ticket", "another ticket's bell is left alone");
      const a = (await pool().query("SELECT action, actor_id, target_id, target_label, details FROM audit_log WHERE id = $1", [aud])).rows[0];
      assert.equal(a.action, "helpdesk.ticket.cc_added");
      assert.equal(a.actor_id, agentId);
      assert.equal(a.target_id, String(id));
      assert.equal(a.target_label, `#${n}`);
      assert.deepEqual(a.details, { ccs: [{ email: "" }, { user_id: ccId, name: HD_FORMER_REQUESTER }], via: "desk" });
    } finally {
      await pool().query("DELETE FROM notifications WHERE id = ANY($1::int[])", [[bell, other]]);
      await pool().query("DELETE FROM audit_log WHERE id = $1", [aud]);
    }
  });

  test("content added after anonymising is anonymised on the next run", async () => {
    const id = await ticket({ status: "closed", requester: await user("rita-later", "Rita Requester") });
    await runRetention({ now: NOW, settings: ANON, only: [id] });
    assert.deepEqual((await planRetention({ at: NOW, settings: ANON, only: [id], withIds: true })).ids!.purge, [], "nothing new yet");
    const lines = (await msgs(id)).length;
    await pool().query("INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at) VALUES ($1, $2, 'Andy Agent', 'internal', 'Rita phoned: 0170 555', 'desk', now() + interval '1 minute')", [id, agentId]);
    await saveHelpdeskAttachment({ buf: Buffer.from("later"), filename: "later.txt", ticketId: id, userId: agentId });
    assert.deepEqual((await planRetention({ at: NOW, settings: ANON, only: [id], withIds: true })).ids!.purge, [id]);
    assert.deepEqual((await runRetention({ now: new Date(Date.now() + 120_000), settings: ANON, only: [id] })).anonymised, [id]);
    const m = await msgs(id);
    assert.equal(m.length, lines + 1, "no second 'Anonymised' line");
    assert.ok(!m.some((x: { body: string }) => x.body.includes("0170")));
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_attachments WHERE ticket_id = $1", [id])).rows[0].n, 0);
    assert.deepEqual((await planRetention({ at: NOW, settings: ANON, only: [id], withIds: true })).ids!.purge, [], "settles");
  });

  test("an outside portal contact left with no ticket goes, with its sessions; a blocked one keeps only its address", async () => {
    const mk = async (tag: string, blocked: number) => {
      const c = (await pool().query("INSERT INTO hd_portal_contacts (email, name, last_seen_at, blocked) VALUES ($1, 'Jane Outside', now(), $2) RETURNING id", [`${STAMP}-${tag}@ext.example.test`, blocked])).rows[0].id;
      await pool().query("INSERT INTO hd_portal_sessions (contact_id, token_hash, expires_at, ip, user_agent) VALUES ($1, $2, now() + interval '1 day', '203.0.113.5', 'UA')", [c, `${STAMP}-${tag}`]);
      const id = await ticket({ status: "closed", requester: null, requesterEmail: `${STAMP}-${tag}@ext.example.test` });
      await pool().query("UPDATE hd_tickets SET portal_contact_id = $2 WHERE id = $1", [id, c]);
      return { c, id };
    };
    const plain = await mk("jane", 0);
    const blocked = await mk("spam", 1);
    const twice = await mk("twice", 0);
    const second = await ticket({ status: "open", requester: null, requesterEmail: `${STAMP}-twice@ext.example.test` });
    await pool().query("UPDATE hd_tickets SET portal_contact_id = $2 WHERE id = $1", [second, twice.c]);
    try {
      await runRetention({ now: NOW, settings: ANON, only: [plain.id, blocked.id, twice.id] });
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_portal_contacts WHERE id = $1", [plain.c])).rows[0].n, 0, "contact gone");
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_portal_sessions WHERE contact_id = $1", [plain.c])).rows[0].n, 0, "sessions gone");
      const b = (await pool().query("SELECT name, blocked FROM hd_portal_contacts WHERE id = $1", [blocked.c])).rows[0];
      assert.deepEqual(b, { name: "", blocked: 1 }, "the block holds, without the name");
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_portal_sessions WHERE contact_id = $1", [blocked.c])).rows[0].n, 0);
      assert.equal((await pool().query("SELECT name FROM hd_portal_contacts WHERE id = $1", [twice.c])).rows[0].name, "Jane Outside", "a contact with another ticket stays");
    } finally {
      await pool().query("UPDATE hd_tickets SET portal_contact_id = NULL WHERE id = ANY($1::int[])", [[plain.id, blocked.id, twice.id, second]]);
      await pool().query("DELETE FROM hd_portal_contacts WHERE id = ANY($1::int[])", [[plain.c, blocked.c, twice.c]]);
    }
  });
});

describe("1.19.1 review: the data export", () => {
  test("covers email-raised requests, CC'd requests (their own messages only) and merged conversations", async () => {
    const carol = await user("carol", "Carol Copied");
    const carolEmail = `${STAMP}-carol@example.test`;
    const dave = await user("dave", "Dave Kept");
    // (b) emailed in before her account: requester_id NULL, her address.
    const emailed = await ticket({ status: "open", requester: null, requesterEmail: carolEmail });
    // (a) Copied on Dave's request, where she replied.
    const ccd = await ticket({ status: "open", requester: dave, requesterEmail: `${STAMP}-dave@example.test` });
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, $2, $3, 'Carol Copied')", [ccd, carol, carolEmail]);
    await pool().query("INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via) VALUES ($1, $2, 'Carol Copied', $3, 'public', 'Carol on Dave''s', 'portal')", [ccd, carol, carolEmail]);
    // (c) Her #21 merged into Dave's #22: every message moved, she is a CC there.
    const m21 = await ticket({ status: "open", requester: carol, requesterEmail: carolEmail });
    const m22 = await ticket({ status: "open", requester: dave, requesterEmail: `${STAMP}-dave@example.test` });
    await pool().query("UPDATE hd_messages SET ticket_id = $2, merged_from = $3 WHERE ticket_id = $1", [m21, m22, await num(m21)]);
    await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now(), merged_into = $2 WHERE id = $1", [m21, m22]);
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, $2, $3, 'Carol Copied')", [m22, carol, carolEmail]);
    try {
      const out = await personalHelpdeskExport(carol);
      const by = new Map(out.requests.map((r) => [r.number, r]));
      const e = by.get(await num(emailed))!;
      assert.equal(e.relation, "requester", "an email-raised request is hers");
      assert.deepEqual(e.conversation.map((c) => c.text), ["My payslip shows the wrong salary.", "Fixed it, Rita."]);
      const c = by.get(await num(ccd))!;
      assert.equal(c.relation, "cc");
      assert.deepEqual(c.conversation.map((x) => x.text), ["Carol on Dave's"], "only her own messages on someone else's request");
      assert.deepEqual(c.answers, []);
      const merged = by.get(await num(m21))!;
      assert.equal(merged.relation, "requester");
      assert.equal(merged.merged_into, await num(m22));
      assert.deepEqual(merged.conversation.map((x) => x.text), ["My payslip shows the wrong salary.", "Fixed it, Rita."], "the moved conversation");
      assert.ok(merged.conversation.every((x) => x.from_request === undefined || x.from_request === merged.number));
      const kept = by.get(await num(m22))!;
      assert.equal(kept.relation, "cc");
      assert.deepEqual(kept.conversation, [], "nothing listed twice, nothing of Dave's");
      assert.ok(!JSON.stringify(out).includes("50k"), "never internal notes");
      assert.ok(!JSON.stringify(out).includes("A held reply"), "never held replies");
    } finally {
      await pool().query("UPDATE hd_tickets SET merged_into = NULL WHERE id = $1", [m21]);
    }
  });
});
