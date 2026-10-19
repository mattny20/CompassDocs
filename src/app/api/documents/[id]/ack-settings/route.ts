import { NextResponse } from "next/server";
import { getDocument, getAckSettings, updateAckSettings } from "@/lib/db";
import type { AckSettingsPatch } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import { getComplianceSettings } from "@/lib/compliance-settings";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The per-policy settings the Read confirmation page's Settings tab edits
// (C2, 1.12.0): the confirmation statement (null = the workspace default,
// which GET also serves as statement_default so the form can show it as the
// placeholder) and whether readers sign with a typed name. Wave 2 adds the
// re-confirmation interval and the lifecycle fields as rows of FIELDS below.
//
// GET  → { statement, statement_default, signature }
// PATCH { statement?, signature? } → the same shape, read after the write;
//       400 naming the first problem; one ack.settings_changed audit row
//       { statement_changed, signature } when something changed.
//
// Guards: apiGuard('approver', 'document.ack_require') admits a holder of
// the space-scoped key from any space, so the key is checked again on the
// document's own space, or compliance.program_manage (the Settings tab's
// own gate): 403 otherwise. The document must be in the caller's scope
// (404) and the feature licensed (402).

/** The longest per-policy statement; the card renders it through MarkdownView. */
const STATEMENT_MAX = 500;

type Check<V> = (v: unknown) => { ok: true; value: V } | { ok: false; error: string };

/**
 * One validator per settable field. The handler walks the body through this
 * table, so a new field is one row here and one column in updateAckSettings.
 */
const FIELDS: { [K in keyof AckSettingsPatch]-?: Check<AckSettingsPatch[K]> } = {
  statement: (v) => {
    if (v === null) return { ok: true, value: null };
    if (typeof v !== "string") return { ok: false, error: "'statement' must be text." };
    const text = v.trim();
    if (text.length > STATEMENT_MAX) {
      return { ok: false, error: `Keep the statement under ${STATEMENT_MAX} characters.` };
    }
    return { ok: true, value: text || null };
  },
  signature: (v) =>
    typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: "'signature' must be true or false." },
};

async function gated(params: Promise<{ id: string }>) {
  const gate = await apiGuard("approver", "document.ack_require");
  if (gate instanceof NextResponse) return { denied: gate };
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return { denied: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  }
  if (!(await featureEnabled("policy_ack"))) {
    return {
      denied: NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 }),
    };
  }
  const allowed =
    (await userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" })) ||
    (await userHolds(user, "compliance.program_manage", { legacyMin: "admin" }));
  if (!allowed) {
    return { denied: NextResponse.json({ error: "You don't have permission for that." }, { status: 403 }) };
  }
  return { user, doc };
}

async function answer(docId: number) {
  const [settings, program] = await Promise.all([getAckSettings(docId), getComplianceSettings()]);
  return {
    statement: settings?.statement ?? null,
    statement_default: program.compliance_statement_default,
    signature: settings?.signature ?? false,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { denied, doc } = await gated(params);
  if (denied || !doc) return denied!;
  return NextResponse.json(await answer(doc.id), { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { denied, user, doc } = await gated(params);
  if (denied || !user || !doc) return denied!;

  const raw: unknown = await req.json().catch(() => undefined);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const patch: AckSettingsPatch = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(FIELDS, key)) {
      return NextResponse.json({ error: `Unknown setting "${key}".` }, { status: 400 });
    }
    const field = key as keyof AckSettingsPatch;
    const checked = FIELDS[field](value);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
    (patch as Record<string, unknown>)[field] = checked.value;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: `Send one of: ${Object.keys(FIELDS).join(", ")}.` }, { status: 400 });
  }

  const before = (await getAckSettings(doc.id)) ?? { statement: null, signature: false };
  const after = (await updateAckSettings(doc.id, patch)) ?? before;
  const statementChanged = before.statement !== after.statement;
  const signatureChanged = before.signature !== after.signature;
  if (statementChanged || signatureChanged) {
    await auditAck("ack.settings_changed", doc, {
      actor: actorFrom(user),
      ip: ipFrom(req),
      source: "manual",
      details: { statement_changed: statementChanged, signature: after.signature, signature_changed: signatureChanged },
    });
  }
  return NextResponse.json({ ok: true, ...(await answer(doc.id)) });
}
