import { NextResponse } from "next/server";
import {
  getDocument,
  recordAcknowledgement,
  getCurrentAck,
  setAckRequired,
  setAckEditDefault,
  isAckEditDefault,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, canSeeDrafts, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { ackSummary } from "@/lib/db";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import { requestAcknowledgement } from "@/lib/compliance";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { requestOrigin } from "@/lib/oauth";
import { readSecondsSince } from "@/lib/analytics";
import { reachedEndFromBody } from "@/lib/read-evidence";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET — the read-confirmation summary for a document (A3, 1.10.0): the
// counts, the marker's version, the edit default and the last decision, as
// `ackSummary` computes them for every surface (the editor's question, the
// merge/restore dialogs, the review card). It never names pending people.
// With ?baseline=1 it adds the text readers last confirmed, so the editor
// can measure the drift since then on the client. Anyone who may edit the
// document or read its roster may ask; apiGuard takes one permission, so the
// OR is written with userHolds. A draft is hidden from anyone who may not
// read drafts, exactly as GET /api/documents/[id] hides it: the marker
// follows a draft's latest text while the requirement is off (A2 rule 3),
// so its "baseline" is the draft itself.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const allowed =
    (await userHolds(user, "document.update", { spaceId: doc.space_id, legacyMin: "editor" })) ||
    (await userHolds(user, "document.ack_roster_read", { spaceId: doc.space_id, legacyMin: "approver" }));
  if (!allowed) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Read confirmations are not included in your license." },
      { status: 402 }
    );
  }

  const baseline = new URL(req.url).searchParams.get("baseline") === "1";
  // The workspace defaults ride along (A5/E4): the popover marks the option
  // equal to workspace_edit_default, and the editor's keep side follows
  // keep_reason_required. ackSummary cannot read them itself (the settings
  // module is server-only and imports lib/db).
  const [summary, settings] = await Promise.all([ackSummary(doc.id, { baseline }), getComplianceSettings()]);
  return NextResponse.json(
    {
      ...summary,
      workspace_edit_default: settings.ack_defaults.edit_default,
      keep_reason_required: settings.ack_defaults.keep_reason_required,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

// POST — the signed-in reader confirms they've read this document.
//
// Body: { version_id: number; reached_end?: boolean }. The reader declares the
// version they read; the row is recorded only when that is still the
// document's latest version and the marker has not moved past it (1.10.0).
// Otherwise 409 { stale: true } — the same shape as the editor's conflict —
// and the page reloads into what changed. The hash on the row comes from that
// version's text, never from the live document.
//
// Reading evidence (C3, 1.11.0): `reached_end` is the card's own report
// (use-reached-end.ts) and is stored as the JSON boolean true only; anything
// else, including a missing field, is false. The read time is never read
// from the body: the route sums this person's view heartbeats for the
// document since everyone was last asked (readSecondsSince) and stores that.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer", "document.ack_submit");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Read confirmations are not included in your license." },
      { status: 402 }
    );
  }

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (doc.status !== "published" || doc.ack_required !== 1) {
    return NextResponse.json({ error: "This document doesn't ask for a read confirmation." }, { status: 400 });
  }

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const versionId = Number(body?.version_id);
  if (body?.version_id === undefined || body?.version_id === null || !Number.isInteger(versionId)) {
    return NextResponse.json({ error: "version_id is required." }, { status: 400 });
  }

  // The evidence beside the version: the self-reported latch, parsed and
  // labelled as such, and the server-derived read time since the marker
  // (the last 30 days when a document somehow carries none).
  const reachedEnd = reachedEndFromBody(body);
  const readSeconds = await readSecondsSince(doc.id, user.id, doc.ack_revision_at ?? null);

  const { recorded, stale } = await recordAcknowledgement(doc.id, user.id, ipFrom(req) ?? "", versionId, {
    readSeconds,
    reachedEnd,
  });
  if (stale) {
    return NextResponse.json(
      { stale: true, error: "This document changed while you were reading it. Reload and read the changes." },
      { status: 409 }
    );
  }
  const ack = await getCurrentAck(doc.id, user.id);
  if (recorded) {
    // The attestation evidence (C1): the version and hash the row cites, and
    // the browser that sent it. signed_name / identity_proof arrive with C3.
    await auditAck("document.acknowledge", doc, {
      actor: actorFrom(user),
      ip: ipFrom(req),
      version_id: ack?.version_id ?? versionId,
      version: ack?.rev ?? null,
      content_sha256: ack?.content_sha256 ?? null,
      details: { user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300) },
    });
  }
  return NextResponse.json({
    ok: true,
    acknowledged_at: ack?.acknowledged_at ?? null,
    version_id: ack?.version_id ?? versionId,
    rev: ack?.rev ?? null,
  });
}

// PATCH — the shield popover's settings (A5, 1.10.1), for holders of
// document.ack_require on the space.
//
// Body: { required?: boolean; notify?: boolean; edit_default?: 'ask' | 'material' | 'reset' }.
// At least one of `required` / `edit_default` must be present, each with its
// type, else 400. `required: true` runs the same request sequence as the
// portal (requestAcknowledgement: the requirement switches on, the document
// receives the workspace edit default the first time, and with `notify` a
// 'request' notice is queued for everyone who can see it); `notify` is
// false when absent, so an API caller that says nothing tells nobody, as
// the 1.10.0 toggle did. The popover always sends it ("Require and notify"
// / "Require quietly"). Switching on a document that already requires
// confirmation changes nothing and queues nothing. `required: false` keeps
// the record and audits the standing at that moment. `edit_default` is the
// per-document answer to "when the text changes"; its audit row carries
// {from, to}. Every branch answers the same shape, { ok, ack_required,
// edit_default, queued, eligible }, read from the row after the writes (so
// a first switch-on that replaced an explicit 'ask' with the workspace
// default echoes what the document now holds, not what was sent).
//
// apiGuard admits a holder of the space-scoped document.ack_require from
// any space (it takes no space), so the key is checked again on the
// document's own space: a role granted it on one space must not switch
// the requirement on, queue a notice to or change the default of a
// document it can merely read in another.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("approver", "document.ack_require");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json(
      { error: "Read confirmations are not included in your license." },
      { status: 402 }
    );
  }

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!(await userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" }))) {
    return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const hasRequired = body?.required !== undefined;
  const hasEditDefault = body?.edit_default !== undefined;
  if (hasRequired && typeof body.required !== "boolean") {
    return NextResponse.json({ error: "'required' must be true or false." }, { status: 400 });
  }
  if (hasEditDefault && !isAckEditDefault(body.edit_default)) {
    return NextResponse.json({ error: "'edit_default' must be ask, material or reset." }, { status: 400 });
  }
  if (body?.notify !== undefined && typeof body.notify !== "boolean") {
    return NextResponse.json({ error: "'notify' must be true or false." }, { status: 400 });
  }
  if (!hasRequired && !hasEditDefault) {
    return NextResponse.json({ error: "Send 'required' and/or 'edit_default'." }, { status: 400 });
  }
  if (hasRequired && body.required && doc.status !== "published") {
    return NextResponse.json(
      { error: "Publish the document before requiring a read confirmation." },
      { status: 400 }
    );
  }

  const actor = actorFrom(user);
  const ip = ipFrom(req);
  let queued = 0;

  if (hasEditDefault) {
    const change = await setAckEditDefault(doc.id, body.edit_default);
    if (change && change.from !== change.to) {
      await auditAck("ack.edit_default_set", doc, {
        actor,
        ip,
        source: "manual",
        details: { from: change.from, to: change.to },
      });
    }
  }

  if (hasRequired) {
    // Counted before the flip, so "removed" says what standing the record
    // had at that moment (acked of required) and "required" names the
    // audience that was asked. Two literal calls, not a ternary, so each
    // key is greppable (C1).
    const summary = await ackSummary(doc.id);
    if (body.required) {
      if (doc.ack_required !== 1) {
        const notify = body.notify === true;
        // The flip is the claim: only the call that switched the
        // requirement on queues a notice and is on the record; a request
        // that lost that race changes nothing and answers queued 0.
        const r = await requestAcknowledgement(
          doc,
          { id: user.id, name: user.name || user.username },
          requestOrigin(req),
          { notify }
        );
        queued = r.queued;
        if (r.switched_on) {
          await auditAck("document.ack_required", doc, {
            actor,
            ip,
            version_id: summary.latest_version_id,
            version: summary.latest_rev,
            source: "manual",
            details: { notify, eligible: summary.eligible, queued },
          });
        }
      }
    } else if (doc.ack_required === 1) {
      await setAckRequired(doc.id, false);
      await auditAck("document.ack_removed", doc, {
        actor,
        ip,
        version_id: summary.version_id,
        version: summary.rev,
        source: "manual",
        details: { acked: summary.current, required: summary.eligible },
      });
    }
  }

  // One read after the writes, so every branch answers the documented
  // shape from what the document now holds.
  const after = await ackSummary(doc.id);
  return NextResponse.json({
    ok: true,
    ack_required: after.required,
    edit_default: after.edit_default,
    queued,
    eligible: after.eligible,
  });
}
