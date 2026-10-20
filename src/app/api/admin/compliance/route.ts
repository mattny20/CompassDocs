import { NextResponse } from "next/server";
import { complianceGuard, type ComplianceKey } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import {
  complianceDocs,
  complianceUserSummary,
  ackCandidateDocs,
  ackStatusForDocument,
  ackFormerStaffRows,
  ackSummary,
  getDocument,
  setAckRequired,
  listAckLedgerAll,
  stampAckReminded,
  ackReminderSummary,
  policyNeedsAttention,
  complianceKpiExtras,
} from "@/lib/db";
import { requestAcknowledgement, enqueueReminder, sweepDefaults, workspaceDueDefaults } from "@/lib/compliance";
import { audit, auditAck, actorFrom, ipFrom } from "@/lib/audit";
import { userHolds } from "@/lib/access";
import { requestOrigin } from "@/lib/oauth";
import { versionProvenance, provenanceCells } from "@/lib/version-provenance";
import { csvCell } from "@/lib/csv";
import {
  MATRIX_CSV_HEADER,
  LEDGER_CSV_HEADER,
  attestationCsvCells,
  recertCsvCells,
  ledgerCsvCells,
  exemptionCsvCells,
  matrixStatus,
} from "@/lib/read-evidence";
import { recertDueWithin } from "@/lib/ack-recert";
import { RESET_MIN_PCT } from "@/lib/diff";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Central compliance portal: org-wide read-confirmation progress, asking for
// a read confirmation of any published doc, reminders to stragglers, and
// stopping the requirement. Three keys gate it (F6, 1.10.1): program_read
// for the JSON, export for the CSV matrix and the ledger (C4, 1.12.0),
// program_manage for every POST.

const REMIND_COOLDOWN_MS = 60 * 60 * 1000; // one reminder per doc per hour

/** The literal set of portal actions. Anything else is 400, never "request". */
const ACTIONS = ["request", "remind", "stop"] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (v: unknown): v is Action => ACTIONS.includes(v as Action);

async function gated(key: ComplianceKey): Promise<{ denied: NextResponse } | { user: SessionUser }> {
  const gate = await complianceGuard(key);
  if (gate instanceof NextResponse) return { denied: gate };
  if (!(await featureEnabled("policy_ack"))) {
    return {
      denied: NextResponse.json(
        { error: "Read confirmations are not included in your license." },
        { status: 402 }
      ),
    };
  }
  return { user: gate };
}

/** A published document by id, or undefined (a NaN id never reaches the database). */
async function publishedDoc(raw: unknown) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const doc = await getDocument(id);
  return doc && doc.status === "published" ? doc : undefined;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  const csv = format === "csv";
  const ledger = format === "ledger";
  const preview = url.searchParams.get("preview");

  // The key follows the shape of the answer: the matrix and the ledger are
  // exports of personal data, everything else is reading the programme.
  // complianceGuard is the section gate AND the key, so a program_read-only
  // role is answered 403 on both files.
  const gate = await gated(csv || ledger ? "compliance.export" : "compliance.program_read");
  if ("denied" in gate) return gate.denied;
  const { user } = gate;

  if (ledger) {
    // The workspace ledger (C4, 1.12.0): every confirmation ever recorded,
    // over every document (purged ones from their title snapshot), with
    // superseded rows, former staff and removed accounts, and the IP and
    // user agent of each (the key above is what makes those two visible).
    // Grouped by document, newest first within each; the header is
    // LEDGER_CSV_HEADER, every cell through csvCell.
    const rows = await listAckLedgerAll();
    const esc = csvCell;
    const lines = [LEDGER_CSV_HEADER, ...rows.map((r) => ledgerCsvCells(r, true).map(esc).join(","))];
    await audit({
      actor: actorFrom(user),
      action: "ack.export",
      targetType: "compliance",
      targetId: null,
      targetLabel: "All policies",
      details: { format: "ledger", doc_id: "all", rows: rows.length, with_ip: true },
      ip: ipFrom(req),
    });
    return new Response(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="compliance-ledger.csv"',
      },
    });
  }

  if (preview !== null) {
    // ?preview={docId} -> the audience the Request question names (A8):
    // how many people would be asked right now. Counts only, no names.
    const doc = await publishedDoc(preview);
    if (!doc) {
      return NextResponse.json({ error: "Document not found or not published." }, { status: 404 });
    }
    const summary = await ackSummary(doc.id);
    return NextResponse.json(
      { eligible: summary.eligible, pending: summary.pending, required: summary.required },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (csv) {
    // Full matrix: one row per (policy, eligible user), then one per former
    // staff member with a record. Existing columns stay in place;
    // revision_as_of is the confirmation marker date since 1.10.0 (it was
    // updated_at); the version, hash, source and former_staff columns are
    // appended, then the ledger's asked_at, asked_by, reason and
    // kept_since_asked (C1; asked_by and reason are empty when the marker
    // predates the ledger), then who published and approved the version each
    // row cites (C6, 1.10.1), and (C4, 1.12.0) the same six columns the
    // roster appends: statement, signed_name, identity_proof (C2), then
    // recert_months, effective_at, next_recert_at from the documents row
    // (G1), and (D2, 1.13.0) the same five the roster appends after them:
    // exempt_reason, exempt_by, exempt_until (filled on an exempt row,
    // which is in no count), snoozed_until and due_at, then (1.14.0) the
    // standing as the portal counts it, status (F1: confirmed | pending |
    // overdue | exempt through matrixStatus with the policy's resolved
    // grace), and the policy sets the policy belongs to, set (D3). No IP
    // column here: with_ip is false. Every cell goes through
    // csvCell (quotes doubled, a formula-leading value prefixed with a
    // quote), so a name or a note that starts with = never runs when the
    // sheet opens; the header is MATRIX_CSV_HEADER in src/lib/read-evidence.
    // Published policies only: a paused (unpublished) policy is out of the
    // numbers and off the row actions while it is down (G2), so it is out
    // of the matrix too; its record stays on the document's own page. A
    // retired policy (G3, 1.12.0) is out for the same reason as it is out
    // of the tiles: nobody owes it; its evidence stays exportable through
    // its own roster and ledger CSVs.
    const docs = (await complianceDocs()).filter((d) => d.status === "published" && d.ack_retired_at === null);
    const esc = csvCell;
    const lines = [MATRIX_CSV_HEADER];
    for (const d of docs) {
      const [rows, former, provenance, policy] = await Promise.all([
        ackStatusForDocument(d.id),
        ackFormerStaffRows(d.id),
        versionProvenance(d.id),
        getDocument(d.id),
      ]);
      const asked = [
        esc(d.ack_revision_at),
        esc(d.last_reset?.decided_by_name ?? ""),
        esc(d.last_reset?.reason ?? ""),
        esc(d.kept_since_reset),
      ];
      const recert = recertCsvCells(policy ?? {}).map(esc);
      for (const r of rows) {
        lines.push(
          [
            esc(d.title),
            esc(d.space_name),
            esc(d.ack_revision_at),
            esc(r.name),
            esc(r.username),
            esc(r.email),
            esc(r.role),
            esc(r.acknowledged_at ?? ""),
            esc(r.rev ? `v${r.rev}` : ""),
            esc(r.version_id ?? ""),
            esc(r.content_sha256 ?? ""),
            esc(r.version_source ?? ""),
            esc(""),
            ...asked,
            ...provenanceCells(provenance, r.version_id).map(esc),
            ...attestationCsvCells(r).map(esc),
            ...recert,
            ...exemptionCsvCells(r).map(esc),
            esc(matrixStatus(r, d.overdue_grace_days)),
            esc(d.set_names.join("; ")),
          ].join(",")
        );
      }
      for (const r of former) {
        lines.push(
          [
            esc(d.title),
            esc(d.space_name),
            esc(d.ack_revision_at),
            esc(r.name),
            esc(r.username),
            esc(r.email),
            esc(r.role),
            esc(r.acknowledged_at),
            esc(r.rev ? `v${r.rev}` : ""),
            esc(r.version_id ?? ""),
            esc(r.content_sha256 ?? ""),
            esc(r.version_source),
            esc(r.reason),
            ...asked,
            ...provenanceCells(provenance, r.version_id).map(esc),
            ...attestationCsvCells(r).map(esc),
            ...recert,
            // No assignment row travels with a former staff member: five blanks,
            // then the standing their record holds (a confirmation).
            ...exemptionCsvCells({}).map(esc),
            esc(matrixStatus({ acknowledged_at: r.acknowledged_at }, d.overdue_grace_days)),
            esc(d.set_names.join("; ")),
          ].join(",")
        );
      }
    }
    // Every export is on the record before the response streams (F6): an
    // access review samples exactly this.
    await audit({
      actor: actorFrom(user),
      action: "ack.export",
      targetType: "compliance",
      targetId: null,
      targetLabel: "All policies",
      details: { format: "matrix", doc_id: "all", rows: lines.length - 1, with_ip: false },
      ip: ipFrom(req),
    });
    return new Response(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="compliance-report.csv"',
      },
    });
  }

  const [rows, users, candidates, manage, canExport, workspace, attention, extras] = await Promise.all([
    complianceDocs(),
    complianceUserSummary(),
    ackCandidateDocs(),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
    userHolds(user, "compliance.export", { legacyMin: "admin" }),
    workspaceDueDefaults(),
    // The Needs attention queue and the three tile numbers the rows cannot
    // add up (F1, 1.14.0): over the live policies, the same rows as the sums.
    policyNeedsAttention(),
    complianceKpiExtras(),
  ]);

  // The tiles count published policies only (G2, 1.11.0): a paused policy
  // (unpublished, requirement still on) is in `docs` with status 'draft' so
  // the portal can show it, but nobody owes it while it is down, so it is
  // out of every sum and the percentage does not drop on unpublish.
  // complianceUserSummary applies the same rule per person.
  const live = (d: { status: string; ack_retired_at: string | null }) => d.status === "published" && d.ack_retired_at === null;
  // The reminder subtitle (E2, 1.13.0): when each live policy's people were
  // last reminded (the manual Remind or the sweep, whichever is later) and
  // when the sweep next reminds someone, with the cadence resolved as the
  // claim resolves it; a paused or retired policy reminds nobody.
  const reminders = await ackReminderSummary(rows.filter(live).map((d) => d.id), sweepDefaults(workspace));
  const docs = rows.map((d) => ({
    ...d,
    // The policy's deadline rule (E1): its own days or fixed date (both null
    // = inherit) with the days the cascade resolves, for portalDueLine.
    due_rule: { due_days: d.due_days, due_at: d.due_at, resolved_days: d.due_days_resolved },
    reminder: reminders.has(d.id)
      ? {
          last_reminded_at: reminders.get(d.id)!.last_reminded_at,
          next_reminder_at: reminders.get(d.id)!.next_reminder_at,
        }
      : null,
  }));
  const active = docs.filter(live);
  const required = active.reduce((n, d) => n + d.required, 0);
  const acked = active.reduce((n, d) => n + d.acked, 0);
  const usersWithRequirements = users.filter((u) => u.required > 0);
  return NextResponse.json({
    kpis: {
      policies: active.length,
      required,
      acked,
      outstanding: required - acked,
      pct: required ? Math.round((acked / required) * 100) : 100,
      users_compliant: usersWithRequirements.filter((u) => u.acked === u.required).length,
      users_total: usersWithRequirements.length,
      // The Overview's fifth tile (G1, 1.12.0): live policies whose next
      // cycle falls within 30 days, over the same rows as the other sums.
      recert_due_30: active.filter((d) => recertDueWithin(d, 30)).length,
      // The Overdue tile (E1, 1.13.0): open rows past their due date and
      // grace with no current confirmation, summed over the live policies.
      overdue: active.reduce((n, d) => n + d.overdue, 0),
      // The six tiles of 1.14.0 (F1), all over the live policies and
      // additive to the keys above: the people with an overdue row (the
      // Overdue tile's sub-line), the rows due inside seven days, pending
      // (the new name of outstanding), the exempt rows (outside the
      // denominator), the rows whose escalation fired, the rows under a
      // running snooze (which never leaves the other numbers), and the
      // policies whose confirmed text drifted past the re-ask threshold
      // through kept edits.
      overdue_people: users.filter((u) => u.overdue > 0).length,
      due_7d: extras.due_7d,
      pending: required - acked,
      exempt: active.reduce((n, d) => n + d.exempt, 0),
      escalated: extras.escalated,
      snoozed: extras.snoozed,
      drifted: active.filter((d) => d.drift_pct >= RESET_MIN_PCT).length,
    },
    // The queue (F1): { rows, total, snoozed }, rows limited to 200 with
    // total counted before the limit; a snoozed row is counted, not listed.
    attention,
    docs,
    users,
    candidates,
    // What the viewer may do, so the portal hides Request, Remind, Stop
    // requiring and Export from a read-only holder instead of letting them
    // find the 403 (F6/F7).
    can: { manage, export: canExport },
  });
}

// POST { docId, action: 'request' | 'remind' | 'stop', notify?: boolean }
//
// request: the document starts requiring read confirmation; with notify
//   (the default) a 'request' notice is queued for everyone who can see it
//   and delivered by the outbox within a minute; notify: false ("Require
//   quietly") switches it on and tells nobody. Answers { ok, queued, eligible }.
// remind: a 'reminder' notice is queued for everyone still pending, at most
//   once per policy per hour (429 inside the hour). Answers { ok, queued }.
// stop: the requirement is switched off; the record is kept. Answers
//   { ok, acked, required } as they stood at that moment.
//
// The drain writes ack.requested / ack.reminder_sent with the real counts
// once the notices have gone out (H4); this route records the requirement
// changing hands: document.ack_required { notify, eligible, queued } and
// document.ack_removed { acked, required } (the same rows the document
// shield writes, so the two paths read the same in the audit log).
export async function POST(req: Request) {
  const gate = await gated("compliance.program_manage");
  if ("denied" in gate) return gate.denied;
  const { user } = gate;

  let body: { docId?: unknown; action?: unknown; notify?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!isAction(body?.action)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  const action = body.action;
  const doc = await publishedDoc(body?.docId);
  if (!doc) {
    return NextResponse.json({ error: "Document not found or not published." }, { status: 404 });
  }
  const actor = actorFrom(user);
  const ip = ipFrom(req);
  /** The outbox row's actor: the same name the audit row carries. */
  const sender = { id: user.id, name: user.name || user.username };

  // A retired policy (G3, 1.12.0) answers no portal action: requiring it
  // again would leave the retirement columns set on a live requirement.
  // Un-retire is the one way back, as the shield's PATCH refuses too.
  if (doc.ack_retired_at) {
    return NextResponse.json({ error: "This policy is retired. Un-retire it first." }, { status: 409 });
  }

  if (action === "request") {
    if (doc.ack_required === 1) {
      return NextResponse.json({ error: "This document already asks for a read confirmation." }, { status: 400 });
    }
    // `notify` is a boolean or absent: "false", 0 or null would otherwise
    // read as "tell everyone", as the sibling PATCH /ack already refuses.
    if (body.notify !== undefined && typeof body.notify !== "boolean") {
      return NextResponse.json({ error: "'notify' must be true or false." }, { status: 400 });
    }
    const notify = body.notify !== false;
    // The audience as it stands when the requirement is switched on: the
    // number the question showed, kept on the audit row.
    const summary = await ackSummary(doc.id);
    // Switches the requirement on, stamps the Remind cooldown and, with
    // notify, queues the 'request' notice for the outbox (src/lib/compliance).
    // The flip itself is the claim: when two requests race, only the one
    // that switched the requirement on queues a notice and is on the record;
    // the other is answered as a request for a policy that already asks.
    const { queued, switched_on } = await requestAcknowledgement(doc, sender, requestOrigin(req), { notify });
    if (!switched_on) {
      return NextResponse.json({ error: "This document already asks for a read confirmation." }, { status: 400 });
    }
    await auditAck("document.ack_required", doc, {
      actor,
      ip,
      version_id: summary.latest_version_id,
      version: summary.latest_rev,
      source: "manual",
      details: { notify, eligible: summary.eligible, queued },
    });
    return NextResponse.json({ ok: true, queued, eligible: summary.eligible });
  }

  if (doc.ack_required !== 1) {
    return NextResponse.json({ error: "This document doesn't ask for a read confirmation." }, { status: 400 });
  }

  if (action === "remind") {
    if (
      doc.ack_last_reminded_at &&
      Date.now() - new Date(doc.ack_last_reminded_at).getTime() < REMIND_COOLDOWN_MS
    ) {
      return NextResponse.json(
        { error: "A reminder went out less than an hour ago. Give people a moment." },
        { status: 429 }
      );
    }
    // Queues the 'reminder' notice and stamps the cooldown in the request
    // path (not the drain), so a second click inside the hour is refused
    // before anything is delivered. The stamp is the claim (one UPDATE
    // guarded on the hour): the check above gives the friendly refusal,
    // and two clicks that pass it in the same second still queue one row,
    // the loser answering the same 429.
    const { queued, claimed } = await enqueueReminder(doc, sender, requestOrigin(req));
    if (!claimed) {
      return NextResponse.json(
        { error: "A reminder went out less than an hour ago. Give people a moment." },
        { status: 429 }
      );
    }
    // The rows the reminder reaches are stamped (E2, 1.13.0): the automatic
    // cadence counts from this one and the row subtitle reads "last
    // reminded today". The drain resolves the same people a minute later.
    await stampAckReminded(doc.id).catch((e) => console.error("[ack] could not stamp the reminder on the assignments:", e));
    return NextResponse.json({ ok: true, queued });
  }

  // stop: counted before the flip, so "removed" says what standing the
  // record had at that moment (acked of required), exactly as the shield's
  // switch-off does (C1). The record itself is kept.
  const summary = await ackSummary(doc.id);
  await setAckRequired(doc.id, false);
  await auditAck("document.ack_removed", doc, {
    actor,
    ip,
    version_id: summary.version_id,
    version: summary.rev,
    source: "manual",
    details: { acked: summary.current, required: summary.eligible },
  });
  return NextResponse.json({ ok: true, acked: summary.current, required: summary.eligible });
}
