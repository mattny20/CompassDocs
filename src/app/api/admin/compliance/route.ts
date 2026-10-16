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
} from "@/lib/db";
import { requestAcknowledgement, enqueueReminder } from "@/lib/compliance";
import { audit, auditAck, actorFrom, ipFrom } from "@/lib/audit";
import { userHolds } from "@/lib/access";
import { requestOrigin } from "@/lib/oauth";
import { versionProvenance, provenanceCells } from "@/lib/version-provenance";
import { csvCell } from "@/lib/csv";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Central compliance portal: org-wide read-confirmation progress, asking for
// a read confirmation of any published doc, reminders to stragglers, and
// stopping the requirement. Three keys gate it (F6, 1.10.1): program_read
// for the JSON, export for the CSV matrix, program_manage for every POST.

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
  const csv = url.searchParams.get("format") === "csv";
  const preview = url.searchParams.get("preview");

  // The key follows the shape of the answer: the matrix is an export of
  // personal data, everything else is reading the programme.
  const gate = await gated(csv ? "compliance.export" : "compliance.program_read");
  if ("denied" in gate) return gate.denied;
  const { user } = gate;

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
    // row cites (C6, 1.10.1). No IP column here: with_ip is false. Every
    // cell goes through csvCell (quotes doubled, a formula-leading value
    // prefixed with a quote), so a name or a note that starts with = never
    // runs when the sheet opens; the header line is the literal below.
    // Published policies only: a paused (unpublished) policy is out of the
    // numbers and off the row actions while it is down (G2), so it is out
    // of the matrix too; its record stays on the document's own page.
    const docs = (await complianceDocs()).filter((d) => d.status === "published");
    const esc = csvCell;
    const lines = [
      "document,space,revision_as_of,name,username,email,role,acknowledged_at,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked,version_published_by,version_approved_by",
    ];
    for (const d of docs) {
      const [rows, former, provenance] = await Promise.all([
        ackStatusForDocument(d.id),
        ackFormerStaffRows(d.id),
        versionProvenance(d.id),
      ]);
      const asked = [
        esc(d.ack_revision_at),
        esc(d.last_reset?.decided_by_name ?? ""),
        esc(d.last_reset?.reason ?? ""),
        esc(d.kept_since_reset),
      ];
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

  const [docs, users, candidates, manage, canExport] = await Promise.all([
    complianceDocs(),
    complianceUserSummary(),
    ackCandidateDocs(),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
    userHolds(user, "compliance.export", { legacyMin: "admin" }),
  ]);

  // The tiles count published policies only (G2, 1.11.0): a paused policy
  // (unpublished, requirement still on) is in `docs` with status 'draft' so
  // the portal can show it, but nobody owes it while it is down, so it is
  // out of every sum and the percentage does not drop on unpublish.
  // complianceUserSummary applies the same rule per person.
  const active = docs.filter((d) => d.status === "published");
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
    },
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
