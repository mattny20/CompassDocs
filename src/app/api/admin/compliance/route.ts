import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import {
  complianceDocs,
  complianceUserSummary,
  compliancePendingUsers,
  ackCandidateDocs,
  ackStatusForDocument,
  ackFormerStaffRows,
  getDocument,
  setAckRequired,
  setAckLastReminded,
} from "@/lib/db";
import { notifyAckRequest } from "@/lib/compliance";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Central compliance portal (admins): org-wide read-confirmation progress,
// asking for a read confirmation of any published doc, and reminders to
// stragglers.

const REMIND_COOLDOWN_MS = 60 * 60 * 1000; // one reminder per doc per hour

async function gated() {
  const gate = await sectionApiGuard("compliance");
  if (gate instanceof NextResponse) return { denied: gate };
  if (!(await featureEnabled("policy_ack"))) {
    return {
      denied: NextResponse.json(
        { error: "Read confirmations are not included in your license." },
        { status: 402 }
      ),
    };
  }
  return { user: gate as SessionUser };
}

export async function GET(req: Request) {
  const { denied, user } = await gated();
  if (denied || !user) return denied!;

  const [docs, users, candidates] = await Promise.all([
    complianceDocs(),
    complianceUserSummary(),
    ackCandidateDocs(),
  ]);

  const url = new URL(req.url);
  if (url.searchParams.get("format") === "csv") {
    // Full matrix: one row per (policy, eligible user), then one per former
    // staff member with a record. Existing columns stay in place;
    // revision_as_of is the confirmation marker date since 1.10.0 (it was
    // updated_at); the version, hash, source and former_staff columns are
    // appended, then the ledger's asked_at, asked_by, reason and
    // kept_since_asked (C1; asked_by and reason are empty when the marker
    // predates the ledger).
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      "document,space,revision_as_of,name,username,email,role,acknowledged_at,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked",
    ];
    for (const d of docs) {
      const [rows, former] = await Promise.all([ackStatusForDocument(d.id), ackFormerStaffRows(d.id)]);
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
          ].join(",")
        );
      }
    }
    return new Response(lines.join("\n") + "\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="compliance-report.csv"',
      },
    });
  }

  const required = docs.reduce((n, d) => n + d.required, 0);
  const acked = docs.reduce((n, d) => n + d.acked, 0);
  const usersWithRequirements = users.filter((u) => u.required > 0);
  return NextResponse.json({
    kpis: {
      policies: docs.length,
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
  });
}

export async function POST(req: Request) {
  const { denied, user } = await gated();
  if (denied || !user) return denied!;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const docId = Number(body?.docId);
  const action = body?.action === "remind" ? "remind" : "request";
  const doc = await getDocument(docId);
  if (!doc || doc.status !== "published") {
    return NextResponse.json({ error: "Document not found or not published." }, { status: 404 });
  }

  if (action === "request") {
    if (doc.ack_required === 1) {
      return NextResponse.json({ error: "This document already asks for a read confirmation." }, { status: 400 });
    }
    await setAckRequired(doc.id, true);
  } else if (doc.ack_required !== 1) {
    return NextResponse.json({ error: "This document doesn't ask for a read confirmation." }, { status: 400 });
  } else if (
    doc.ack_last_reminded_at &&
    Date.now() - new Date(doc.ack_last_reminded_at).getTime() < REMIND_COOLDOWN_MS
  ) {
    return NextResponse.json(
      { error: "A reminder went out less than an hour ago — give people a moment." },
      { status: 429 }
    );
  }

  const pending = await compliancePendingUsers(doc.id);
  const { emailed, noticed } = await notifyAckRequest({
    docId: doc.id,
    docTitle: doc.title,
    users: pending,
    requesterId: user.id,
    requesterName: user.name || user.username,
    origin: requestOrigin(req),
    mode: action === "remind" ? "reminder" : "request",
  });
  await setAckLastReminded(doc.id);
  await audit({
    actor: actorFrom(user),
    action: action === "remind" ? "ack.reminder_sent" : "ack.requested",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    details: { pending: pending.length, emailed, noticed },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, pending: pending.length, emailed, noticed });
}
