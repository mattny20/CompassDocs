import { NextResponse } from "next/server";
import { getDocument, getAckSettings, updateAckSettings, getAckRecert, setAckRecert, setSupersededBy } from "@/lib/db";
import type { AckSettingsPatch } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { validateRecertPatch } from "@/lib/ack-recert";
import type { RecertPatch } from "@/lib/ack-recert";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The per-policy settings the Read confirmation page's Settings tab edits
// (C2, 1.12.0): the confirmation statement (null = the workspace default,
// which GET also serves as statement_default so the form can show it as the
// placeholder) and whether readers sign with a typed name; the
// re-confirmation interval, its next date and the effective date (G1); and
// the policy that replaces this one (G3). Each field is one row of FIELDS
// below; the handler applies the validated patch through the setter that
// owns each column (updateAckSettings, setAckRecert, setSupersededBy).
//
// GET  → { statement, statement_default, signature,
//          recert_months, next_recert_at, effective_at, marker, recert_default,
//          superseded_by, superseded_by_title }
// PATCH { any subset of the settable fields } → the same shape, read after
//       the write; 400 naming the first problem; one ack.settings_changed
//       audit row per PATCH that changed something, with the fields it moved.
//
// Guards: apiGuard('approver', 'document.ack_require') admits a holder of
// the space-scoped key from any space, so the key is checked again on the
// document's own space, or compliance.program_manage (the Settings tab's
// own gate): 403 otherwise. The document must be in the caller's scope
// (404) and the feature licensed (402).

/** The longest per-policy statement; the card renders it through MarkdownView. */
const STATEMENT_MAX = 500;

type Check<V> = (v: unknown) => { ok: true; value: V } | { ok: false; error: string };

/** Everything a PATCH may carry: the two C2 columns, the three G1 fields and the G3 replacement. */
type SettingsPatch = AckSettingsPatch & RecertPatch & { superseded_by?: number | null };

/** One G1 field through validateRecertPatch, which judges only the keys it is handed. */
function recertField<K extends keyof RecertPatch>(key: K): Check<RecertPatch[K]> {
  return (v) => {
    const r = validateRecertPatch({ [key]: v });
    return r.ok ? { ok: true, value: r.patch[key] as RecertPatch[K] } : r;
  };
}

/**
 * One validator per settable field. The handler walks the body through this
 * table, so a new field is one row here and one line in apply() below.
 */
const FIELDS: { [K in keyof SettingsPatch]-?: Check<SettingsPatch[K]> } = {
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
  recert_months: recertField("recert_months"),
  next_recert_at: recertField("next_recert_at"),
  effective_at: recertField("effective_at"),
  // The target itself is judged by setSupersededBy (published, live, in the
  // caller's scope); here only the shape.
  superseded_by: (v) =>
    v === null || (typeof v === "number" && Number.isInteger(v) && v > 0)
      ? { ok: true, value: v as number | null }
      : { ok: false, error: "'superseded_by' must be a document id or null." },
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

/** The replacement's title, for the form's chip; null when none is set or it was moved to the Trash. */
async function supersededTitle(id: number | null): Promise<string | null> {
  if (id === null) return null;
  return (await getDocument(id))?.title ?? null;
}

/** The document's settings as the form reads them: every settable field plus what it needs to show them. */
async function answer(docId: number) {
  const [settings, recert, doc, program] = await Promise.all([
    getAckSettings(docId),
    getAckRecert(docId),
    getDocument(docId),
    getComplianceSettings(),
  ]);
  const supersededBy = doc?.ack_superseded_by ?? null;
  return {
    statement: settings?.statement ?? null,
    statement_default: program.compliance_statement_default,
    signature: settings?.signature ?? false,
    recert_months: recert?.ack_recert_months ?? null,
    next_recert_at: recert?.ack_next_recert_at ?? null,
    effective_at: recert?.ack_effective_at ?? null,
    /** The marker (ack_revision_at): the first cycle is dated from it. */
    marker: recert?.ack_revision_at ?? null,
    /** The workspace's interval (Program settings): the Select suffixes it "(workspace default)". */
    recert_default: program.ack_defaults.recert_months,
    superseded_by: supersededBy,
    superseded_by_title: await supersededTitle(supersededBy),
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
  const patch: SettingsPatch = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(FIELDS, key)) {
      return NextResponse.json({ error: `Unknown setting "${key}".` }, { status: 400 });
    }
    const field = key as keyof SettingsPatch;
    const checked = FIELDS[field](value);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
    (patch as Record<string, unknown>)[field] = checked.value;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: `Send one of: ${Object.keys(FIELDS).join(", ")}.` }, { status: 400 });
  }

  // The audit row names what moved: every field is compared before and
  // after, and a PATCH that changes nothing writes no row.
  const details: Record<string, unknown> = {};
  let changed = false;

  const { statement, signature, recert_months, next_recert_at, effective_at, superseded_by } = patch;
  if (statement !== undefined || signature !== undefined) {
    const before = (await getAckSettings(doc.id)) ?? { statement: null, signature: false };
    const after = (await updateAckSettings(doc.id, { statement, signature })) ?? before;
    const statementChanged = before.statement !== after.statement;
    const signatureChanged = before.signature !== after.signature;
    details.statement_changed = statementChanged;
    details.signature = after.signature;
    details.signature_changed = signatureChanged;
    changed = changed || statementChanged || signatureChanged;
  }

  const recert: RecertPatch = {};
  if (recert_months !== undefined) recert.recert_months = recert_months;
  if (next_recert_at !== undefined) recert.next_recert_at = next_recert_at;
  if (effective_at !== undefined) recert.effective_at = effective_at;
  if (Object.keys(recert).length > 0) {
    const before = await getAckRecert(doc.id);
    const after = (await setAckRecert(doc.id, recert)) ?? before;
    if (after) {
      details.recert_months = after.ack_recert_months;
      details.next_recert_at = after.ack_next_recert_at;
      details.effective_at = after.ack_effective_at;
    }
    changed =
      changed ||
      before?.ack_recert_months !== after?.ack_recert_months ||
      before?.ack_next_recert_at !== after?.ack_next_recert_at ||
      before?.ack_effective_at !== after?.ack_effective_at;
  }

  if (superseded_by !== undefined) {
    // The target must be a published, live document in the caller's own
    // scope: a manager cannot point readers at a document they may not see.
    const r = await setSupersededBy(doc.id, superseded_by, await spaceScopeFor(user));
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    const supersededChanged = r.from !== r.to;
    details.superseded_by_changed = supersededChanged;
    details.superseded_by_from = r.from;
    details.superseded_by_to = r.to;
    changed = changed || supersededChanged;
  }

  if (changed) {
    await auditAck("ack.settings_changed", doc, {
      actor: actorFrom(user),
      ip: ipFrom(req),
      source: "manual",
      details,
    });
  }
  return NextResponse.json({ ok: true, ...(await answer(doc.id)) });
}
