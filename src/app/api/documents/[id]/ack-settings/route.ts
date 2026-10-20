import { NextResponse } from "next/server";
import {
  getDocument,
  getAckSettings,
  updateAckSettings,
  getAckRecert,
  setAckRecert,
  setSupersededBy,
  getPolicyAudience,
  getPolicySettings,
  saveAudienceRules,
  previewAudience,
  updatePolicySettings,
  policyDefaultLayers,
  getUserById,
  canSeeSpace,
} from "@/lib/db";
import type { AckSettingsPatch, PolicySettingsNumbersPatch } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, canSeeDrafts, userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { audit, auditAck, actorFrom, ipFrom } from "@/lib/audit";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { movePolicyDeadlines, resolvePolicyDefaults, workspaceDueDefaults } from "@/lib/compliance";
import { requestOrigin } from "@/lib/oauth";
import { validateRecertPatch } from "@/lib/ack-recert";
import type { RecertPatch } from "@/lib/ack-recert";
import { isAudienceMode, sanitizeRules } from "@/lib/audience";
import { DUE_RANGES, isDueNumber, parseYmd, resolveDefaults } from "@/lib/ack-due";
import type { DueNumberKey, DueRule } from "@/lib/ack-due";
import type { AudienceMode, AudienceRule, SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The per-policy settings the Read confirmation page's Settings tab edits.
// C2 (1.12.0): the confirmation statement (null = the workspace default,
// which GET also serves as statement_default so the form can show it as the
// placeholder) and whether readers sign with a typed name; G1: the
// re-confirmation interval, its next date and the effective date; G3: the
// policy that replaces this one. 1.13.0: who must confirm (D1: the audience
// mode, its rules, the two switches), the deadline rule (E1: days after
// assignment or a fixed date, and "Also move existing deadlines") and the
// reminder cadence with the policy owner (E2). Each field is one row of
// FIELDS below; the handler applies the validated patch through the setter
// that owns each column (updateAckSettings, setAckRecert, setSupersededBy,
// saveAudienceRules, updatePolicySettings).
//
// GET  → { statement, statement_default, signature,
//          recert_months, next_recert_at, effective_at, marker, recert_default,
//          superseded_by, superseded_by_title,
//          audience_mode, rules, exclude_stewards, assign_new_members,
//          due_days, due_at,
//          remind_before_days, remind_every_days, escalate_after_days, nudge_every_days,
//          owner_user_id, owner_name, requested_by,
//          defaults: { values, origin, space }, inherited: { values, origin } }
//       `defaults` is the cascade resolved with the policy's own layer;
//       `inherited` is the same cascade without it (what a blank field
//       falls back to, for "Inherit (14 days, from Security)" and
//       "Inherited from workspace (3)").
// GET ?preview=1&audience_mode=targeted&exclude_stewards=1&rules=<JSON>
//       → { count, no_access, sample } from previewAudience, nothing written.
// PATCH { any subset of the settable fields } → the same shape as GET, read
//       after the write, plus `moved` (deadlines moved by this PATCH) and
//       `added` / `closed` / `reopened` when the audience was saved; 400
//       naming the first problem, before anything is written. Audit rows:
//       ack.settings_changed for the C2/G1/G3 fields (one per PATCH that
//       moved any), ack.audience_set {mode, rules, added, closed, reopened},
//       ack.due_set {due_days, due_at, from_rule, moved_existing, moved} (the
//       move itself is ack.due_moved, written by movePolicyDeadlines) and
//       ack.defaults_set {scope: 'policy', space_id, key, from, to} per
//       reminder number or owner that changed, as the space and workspace
//       layers audit theirs.
//
// Guards, in the order of the sibling routes (retire, unretire, reconfirm):
// session and CSRF (apiGuard('viewer')), the caller's space scope (404, so
// a hidden document stays hidden), the draft rule (404 for a draft the
// caller may not read), the licence (402), then document.ack_require on
// the document's own space OR compliance.program_manage (403; the Settings
// tab's own gate, and apiGuard takes one permission, so the OR is written
// out). The replacement's title is answered under the same scope and draft
// rule, so a title never crosses space scope.

/** The longest per-policy statement; the card renders it through MarkdownView. */
const STATEMENT_MAX = 500;

// Module-private (a route file may only export handlers and config); the
// panel carries the same two sentences for its inline validation.
/** A targeted audience with no include rule asks nobody; the card refuses it inline with the same sentence. */
const AUDIENCE_EMPTY = "Name at least one group, person or role.";
/** The card's date input has min=today; a stored fixed date that has passed is never re-sent by a save that did not touch it. */
const DUE_DATE_PAST = "The deadline cannot be in the past.";
/** An owner is told about overdue people by name, so they must be able to open the policy (the spaces route refuses the space layer's owner with the same sentence). */
const OWNER_OUT_OF_SCOPE = "The owner must be an active account that can see this space.";

type Check<V> = (v: unknown) => { ok: true; value: V } | { ok: false; error: string };

/** Everything a PATCH may carry: the two C2 columns, the three G1 fields, the G3 replacement, the D1 audience, the E1 rule and the E2 cadence. */
type SettingsPatch = AckSettingsPatch &
  RecertPatch & {
    superseded_by?: number | null;
    audience_mode?: AudienceMode;
    rules?: AudienceRule[];
    exclude_stewards?: boolean;
    assign_new_members?: boolean;
    /** Not stored: recompute every open row's due date from the rule as it now stands. */
    move_existing?: boolean;
  } & PolicySettingsNumbersPatch;

/** One G1 field through validateRecertPatch, which judges only the keys it is handed. */
function recertField<K extends keyof RecertPatch>(key: K): Check<RecertPatch[K]> {
  return (v) => {
    const r = validateRecertPatch({ [key]: v });
    return r.ok ? { ok: true, value: r.patch[key] as RecertPatch[K] } : r;
  };
}

function boolField(key: string): Check<boolean> {
  return (v) => (typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: `'${key}' must be true or false.` });
}

/** One of the policy's own numbers: null = inherit from the space, the workspace or the built-in; else the key's range (lib/ack-due). */
function dueNumber(key: DueNumberKey): Check<number | null> {
  return (v) => {
    if (v === null) return { ok: true, value: null };
    if (isDueNumber(key, v)) return { ok: true, value: v };
    const r = DUE_RANGES[key];
    return { ok: false, error: `'${key}' must be a whole number from ${r.min} to ${r.max}, or null to inherit.` };
  };
}

/** 'YYYY-MM-DD' of today in UTC: the floor the next-re-confirmation rule uses too (today counts, yesterday does not). */
const todayYmd = () => new Date().toISOString().slice(0, 10);

/**
 * One validator per settable field. The handler walks the body through this
 * table, so a new field is one row here and one block in PATCH below.
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
  signature: boolField("signature"),
  recert_months: recertField("recert_months"),
  next_recert_at: recertField("next_recert_at"),
  effective_at: recertField("effective_at"),
  // The target itself is judged by setSupersededBy (published, live, in the
  // caller's scope); here only the shape.
  superseded_by: (v) =>
    v === null || (typeof v === "number" && Number.isInteger(v) && v > 0)
      ? { ok: true, value: v as number | null }
      : { ok: false, error: "'superseded_by' must be a document id or null." },
  audience_mode: (v) =>
    isAudienceMode(v) ? { ok: true, value: v } : { ok: false, error: "'audience_mode' must be space or targeted." },
  // sanitizeRules drops junk and duplicates and caps the list; the only
  // refusal is a body that is not a list at all.
  rules: (v) => (Array.isArray(v) ? { ok: true, value: sanitizeRules(v) } : { ok: false, error: "'rules' must be a list of rules." }),
  exclude_stewards: boolField("exclude_stewards"),
  assign_new_members: boolField("assign_new_members"),
  due_days: dueNumber("due_days"),
  due_at: (v) => {
    if (v === null || v === "") return { ok: true, value: null };
    if (typeof v !== "string" || !parseYmd(v)) return { ok: false, error: "'due_at' must be a date (YYYY-MM-DD), or null." };
    const ymd = v.trim().slice(0, 10);
    if (ymd < todayYmd()) return { ok: false, error: DUE_DATE_PAST };
    return { ok: true, value: ymd };
  },
  move_existing: boolField("move_existing"),
  remind_before_days: dueNumber("remind_before_days"),
  remind_every_days: dueNumber("remind_every_days"),
  escalate_after_days: dueNumber("escalate_after_days"),
  nudge_every_days: dueNumber("nudge_every_days"),
  // The account is judged in PATCH before anything is written: it must exist
  // ("Owner not found.") and be an active account that can see the policy's
  // space (the escalation never reaches anyone else).
  owner_user_id: (v) =>
    v === null || (typeof v === "number" && Number.isInteger(v) && v > 0)
      ? { ok: true, value: v as number | null }
      : { ok: false, error: "'owner_user_id' must be a user id, or null for nobody." },
};

/** The reminder numbers and the owner: the keys that audit as ack.defaults_set at the policy layer. */
type CadenceKey = Exclude<keyof PolicySettingsNumbersPatch, "due_days" | "due_at">;
const CADENCE_KEYS: readonly CadenceKey[] = [
  "remind_before_days",
  "remind_every_days",
  "escalate_after_days",
  "nudge_every_days",
  "owner_user_id",
];

async function gated(params: Promise<{ id: string }>) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return { denied: gate };
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return { denied: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  }
  if (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id))) {
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

/**
 * The replacement's title for the form's chip, under the caller's own scope
 * and draft rule (the id is answered as the row holds it, so the chip falls
 * back to "Document #id"): null when none is set, when it was moved to the
 * Trash, or when the caller may not see it. setSupersededBy judged the
 * target against the scope of whoever set it, not of whoever reads it.
 */
async function supersededTitle(id: number | null, user: SessionUser): Promise<string | null> {
  if (id === null) return null;
  const replacement = await getDocument(id);
  if (!replacement || !scopeAllows(await spaceScopeFor(user), replacement.space_id)) return null;
  if (replacement.status === "draft" && !(await canSeeDrafts(user, replacement.space_id))) return null;
  return replacement.title;
}

/** A person's display name for the owner chip and the requester placeholder; null once the account is gone. */
async function personName(id: number | null): Promise<{ id: number; name: string } | null> {
  if (id === null) return null;
  const u = await getUserById(id);
  return u ? { id, name: u.name || u.username } : null;
}

/** The audience as stored, or what a policy without a settings row is in: space mode with the defaults. */
const DEFAULT_AUDIENCE = { audience_mode: "space" as AudienceMode, rules: [] as AudienceRule[], exclude_stewards: false, assign_new_members: true };

/** The document's settings as the form reads them: every settable field plus what it needs to show them. */
async function answer(docId: number, user: SessionUser) {
  const [settings, recert, doc, program, audience, policy, defaults, layers, workspace] = await Promise.all([
    getAckSettings(docId),
    getAckRecert(docId),
    getDocument(docId),
    getComplianceSettings(),
    getPolicyAudience(docId),
    getPolicySettings(docId),
    resolvePolicyDefaults(docId),
    policyDefaultLayers(docId),
    workspaceDueDefaults(),
  ]);
  const supersededBy = doc?.ack_superseded_by ?? null;
  const [superseded_by_title, owner, requested_by] = await Promise.all([
    supersededTitle(supersededBy, user),
    personName(policy?.owner_user_id ?? null),
    personName(policy?.requested_by ?? null),
  ]);
  // The cascade without the policy's own layer: what a blank field inherits.
  const inherited = resolveDefaults({ space: layers?.space.defaults, workspace });
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
    superseded_by_title,
    ...(audience ?? DEFAULT_AUDIENCE),
    due_days: policy?.due_days ?? null,
    due_at: policy?.due_at ?? null,
    remind_before_days: policy?.remind_before_days ?? null,
    remind_every_days: policy?.remind_every_days ?? null,
    escalate_after_days: policy?.escalate_after_days ?? null,
    nudge_every_days: policy?.nudge_every_days ?? null,
    owner_user_id: policy?.owner_user_id ?? null,
    owner_name: owner?.name ?? null,
    /** Whoever switched the requirement on: the owner picker's placeholder and the escalation's first stand-in. */
    requested_by,
    defaults: { values: defaults.values, origin: defaults.origin, space: defaults.space },
    inherited: { values: inherited.values, origin: inherited.origin },
  };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { denied, user, doc } = await gated(params);
  if (denied || !user || !doc) return denied!;

  // The live line on the card ("Applies to 412 people · 3 without access"):
  // the rules as the form holds them, counted and never written.
  const url = new URL(req.url);
  if (url.searchParams.get("preview") === "1") {
    const mode = url.searchParams.get("audience_mode") ?? "space";
    if (!isAudienceMode(mode)) {
      return NextResponse.json({ error: "'audience_mode' must be space or targeted." }, { status: 400 });
    }
    const exclude = ["1", "true"].includes(url.searchParams.get("exclude_stewards") ?? "");
    let rules: unknown = [];
    const raw = url.searchParams.get("rules");
    if (raw) {
      try {
        rules = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "'rules' must be a list of rules." }, { status: 400 });
      }
    }
    if (!Array.isArray(rules)) return NextResponse.json({ error: "'rules' must be a list of rules." }, { status: 400 });
    const preview = await previewAudience(doc.id, { audience_mode: mode, rules: sanitizeRules(rules), exclude_stewards: exclude });
    return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(await answer(doc.id, user), { headers: { "Cache-Control": "no-store" } });
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

  const {
    statement,
    signature,
    recert_months,
    next_recert_at,
    effective_at,
    superseded_by,
    audience_mode,
    rules,
    exclude_stewards,
    assign_new_members,
    due_days,
    due_at,
    move_existing,
    owner_user_id,
  } = patch;
  const actor = actorFrom(user);
  /** The same person as the deadline writers name them (AckActor: an id that is never undefined). */
  const ackActor = { id: user.id, name: user.name || user.username };
  const ip = ipFrom(req);

  // Everything that can still be refused is judged before anything is
  // written, so a 400 means nothing changed: a next date on a policy that
  // has no interval (and is given none here) has nothing to fire; a
  // targeted audience with no include rule asks nobody; an owner must be an
  // active account that can see the space (E2: an escalation never reaches
  // a person who cannot open the policy); and the replacement is judged by
  // setSupersededBy itself, which
  // writes only when the target passes (published, live, in the caller's
  // scope). Past this point no setter refuses, so every write below reaches
  // its audit row.
  if (typeof next_recert_at === "string") {
    const months =
      recert_months !== undefined ? recert_months : ((await getAckRecert(doc.id))?.ack_recert_months ?? null);
    if (months === null) {
      return NextResponse.json({ error: "Set an interval before a next re-confirmation date." }, { status: 400 });
    }
  }
  const audienceTouched =
    audience_mode !== undefined || rules !== undefined || exclude_stewards !== undefined || assign_new_members !== undefined;
  if (audienceTouched) {
    const stored = (await getPolicyAudience(doc.id)) ?? DEFAULT_AUDIENCE;
    const mode = audience_mode ?? stored.audience_mode;
    const list = rules ?? stored.rules;
    if (mode === "targeted" && !list.some((r) => r.effect === "include")) {
      return NextResponse.json({ error: AUDIENCE_EMPTY }, { status: 400 });
    }
  }
  if (typeof owner_user_id === "number") {
    if (!(await getUserById(owner_user_id))) {
      return NextResponse.json({ error: "Owner not found." }, { status: 400 });
    }
    if (!(await canSeeSpace(owner_user_id, doc.space_id))) {
      return NextResponse.json({ error: OWNER_OUT_OF_SCOPE }, { status: 400 });
    }
  }

  // The audit row names what moved: every field is compared before and
  // after, and a PATCH that changes nothing writes no row.
  const details: Record<string, unknown> = {};
  let changed = false;
  /** What the answer carries beyond the settings: the move's count and the audience's counts. */
  const extras: Record<string, unknown> = {};

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

  if (changed) {
    await auditAck("ack.settings_changed", doc, { actor, ip, source: "manual", details });
  }

  // The deadline (E1): the rule is written before the audience, so the rows
  // a save of the audience opens in the same PATCH already take it (the
  // reconcile reads the stored rule); the open rows are moved after both,
  // when asked (move_existing) or when a fixed date was set or changed (a
  // fixed date is a promise to the audience, so it moves them; a change to
  // the days applies to future assignments only unless asked). The stored
  // rule is read directly, never through the per-request cache that
  // resolvePolicyDefaults keeps, so the "from" rule is what the row held and
  // the move resolves the cascade after the write.
  let due: { fromRule: DueRule; toRule: DueRule; ruleChanged: boolean; shouldMove: boolean } | null = null;
  if (due_days !== undefined || due_at !== undefined || move_existing !== undefined) {
    const before = await getPolicySettings(doc.id);
    const fromRule: DueRule = { due_days: before?.due_days ?? null, due_at: before?.due_at ?? null };
    const rulePatch: PolicySettingsNumbersPatch = {};
    if (due_days !== undefined) rulePatch.due_days = due_days;
    if (due_at !== undefined) rulePatch.due_at = due_at;
    const after = Object.keys(rulePatch).length > 0 ? await updatePolicySettings(doc.id, rulePatch) : before;
    const toRule: DueRule = { due_days: after?.due_days ?? null, due_at: after?.due_at ?? null };
    const ruleChanged = fromRule.due_days !== toRule.due_days || fromRule.due_at !== toRule.due_at;
    const fixedChanged = toRule.due_at !== null && toRule.due_at !== fromRule.due_at;
    due = { fromRule, toRule, ruleChanged, shouldMove: move_existing === true || fixedChanged };
  }

  // Who must confirm (D1): one save writes the mode, the rules and the two
  // switches and reconciles the rows in the same transaction, so the toast's
  // counts are what the save did; the people it adds are told through the
  // outbox (one 'request' row limited to them, worded per recipient).
  if (audienceTouched) {
    const saved = await saveAudienceRules(
      doc.id,
      { audience_mode, rules, exclude_stewards, assign_new_members },
      { actor: ackActor, origin: requestOrigin(req) }
    );
    if (!saved) return NextResponse.json({ error: "Not found." }, { status: 404 });
    extras.added = saved.added;
    extras.closed = saved.closed;
    extras.reopened = saved.reopened;
    await audit({
      actor,
      action: "ack.audience_set",
      targetType: "document",
      targetId: doc.id,
      targetLabel: doc.title,
      details: {
        doc_id: doc.id,
        mode: saved.audience_mode,
        rules: saved.rules,
        exclude_stewards: saved.exclude_stewards,
        assign_new_members: saved.assign_new_members,
        added: saved.added,
        closed: saved.closed,
        reopened: saved.reopened,
      },
      ip,
    });
  }

  // The move (E1), after the audience: the rows the save opened are among
  // the open rows it dates, and the audit row names what the PATCH did.
  if (due) {
    const { fromRule, toRule, ruleChanged, shouldMove } = due;
    let moved = 0;
    if (shouldMove) {
      moved = (await movePolicyDeadlines(doc, toRule, { fromRule, actor: ackActor, ip })).moved;
    }
    extras.moved = moved;
    if (ruleChanged || shouldMove) {
      await auditAck("ack.due_set", doc, {
        actor,
        ip,
        source: "manual",
        details: { due_days: toRule.due_days, due_at: toRule.due_at, from_rule: fromRule, moved_existing: shouldMove, moved },
      });
    }
  }

  // The reminder cadence and the owner (E2): the policy layer of the same
  // cascade the space and the workspace audit per key, so these do too.
  const cadence: PolicySettingsNumbersPatch = {};
  for (const key of CADENCE_KEYS) if (patch[key] !== undefined) cadence[key] = patch[key];
  if (Object.keys(cadence).length > 0) {
    const before = await getPolicySettings(doc.id);
    const after = await updatePolicySettings(doc.id, cadence);
    for (const key of CADENCE_KEYS) {
      if (cadence[key] === undefined) continue;
      const from = before?.[key] ?? null;
      const to = after?.[key] ?? null;
      if (from === to) continue;
      await auditAck("ack.defaults_set", doc, {
        actor,
        ip,
        source: "manual",
        details: { scope: "policy", space_id: doc.space_id, key, from, to },
      });
    }
  }

  return NextResponse.json({ ok: true, ...(await answer(doc.id, user)), ...extras });
}
