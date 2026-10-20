// Auditor-grade evidence for the read confirmation programme (enterprise
// "policy_ack", F2, 1.14.0), mirroring lib/training-audit: point-in-time
// snapshots serialised once to stable JSON text and hashed with SHA-256
// (manual, monthly through the orchestrator, and one per policy when it is
// retired), the streamed audit package (a ZIP with per-policy folders, the
// policy texts and a hash manifest, the ledger written from a cursor in
// pages and never built in memory), the scheduled programme report, and the
// monthly / weekly entry points lib/periodic calls. Server-only.
//
// The snapshot text is byte-stable for the same data: keys in a fixed order,
// arrays by id, dates ISO, `generated_at` the one input that varies. The
// SHA-256 is computed over exactly that text, which is stored verbatim and
// downloaded verbatim, so `sha256sum` on the file reproduces the hash. The
// full ledger is not embedded (it grows without bound): the snapshot carries
// its row count and the hash of the ledger CSV as the package writes it, so
// the monthly hash and the package's acknowledgements.csv can be checked
// against each other.

import "server-only";
import JSZip from "jszip";
import { Readable, Transform } from "node:stream";
import {
  insertComplianceSnapshot,
  listComplianceSnapshots,
  getComplianceSnapshot,
  complianceSnapshotTaken,
  snapshotPolicyRows,
  snapshotMatrixRows,
  snapshotDecisionRows,
  snapshotNoticeRows,
  ackLedgerBatch,
  ackNoticesBatch,
  auditExtractBatch,
  complianceSettingsChangedAt,
  attestedTextsFor,
  complianceReportCounts,
  getDocument,
  listUsers,
  claimPeriod,
} from "@/lib/db";
import type {
  ComplianceSnapshotKind,
  ComplianceSnapshotMeta,
  SnapshotPolicyRow,
  SnapshotMatrixRow,
  SnapshotDecisionRow,
  SnapshotNoticeRow,
  AuditExtractRow,
} from "@/lib/db";
import type { AckNotice } from "@/lib/types";
import type { AppSettings } from "@/lib/settings";
import { sha256Hex, csvLine, manifestFor, addStreamed, addStreamedCsv, hashCsv, collectZip } from "@/lib/evidence";
import type { StreamedFile } from "@/lib/evidence";
import { LEDGER_CSV_HEADER, ledgerCsvCells } from "@/lib/read-evidence";
import { getAppSettings } from "@/lib/settings-store";
import { currentVersion } from "@/lib/version";
import { readComplianceSettings } from "@/lib/compliance-settings";
import type { ComplianceSettings } from "@/lib/compliance-settings";
import { audit } from "@/lib/audit";
import type { AuditActor } from "@/lib/audit";
import { featureEnabled } from "@/lib/ee";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { sendMail } from "@/lib/mailer";
import { renderEmail } from "@/lib/email-templates";
import { formatDate } from "@/lib/format";

export const SNAPSHOT_FORMAT = "compassdocs-compliance-snapshot/1";

/** The actor of everything the orchestrator does here. */
const SYSTEM: { id: null; name: string } = { id: null, name: "system" };

// --- Periods ------------------------------------------------------------------
//
// lib/periodic (F4) exports isoWeekId and monthId for the orchestrator; the
// two below are private copies so this module stands on its own (no import
// cycle through the orchestrator, and the tests drive the entry points with
// a date of their choosing).

/** 'YYYY-MM' of an instant, UTC. */
function monthId(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** 'YYYY-Www' of an instant, ISO week, UTC. */
function isoWeekId(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The window a report period names: a calendar month for 'YYYY-MM', the
 * ISO week (Monday to the next Monday, UTC) for 'YYYY-Www'; null for
 * anything else (the caller falls back to the last seven days).
 */
export function periodWindow(period: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return { from: new Date(Date.UTC(y, mo - 1, 1)), to: new Date(Date.UTC(y, mo, 1)) };
  }
  const w = /^(\d{4})-W(\d{2})$/.exec(period);
  if (w) {
    const y = Number(w[1]);
    const week = Number(w[2]);
    if (week < 1 || week > 53) return null;
    // ISO week 1 holds 4 January; its Monday is the start.
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000);
    const from = new Date(monday.getTime() + (week - 1) * 7 * 86400000);
    return { from, to: new Date(from.getTime() + 7 * 86400000) };
  }
  return null;
}

// --- The dataset --------------------------------------------------------------

/** A timestamp as the snapshot writes it: ISO, whether the driver handed back a string or a Date; null stays null. */
function iso(v: string | Date | null | undefined): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return String(v);
}

/** What one matrix cell says about the person on the policy. */
export type MatrixStatus = "confirmed" | "pending" | "overdue" | "exempt" | "removed";

/** The status of an assignment row: closed, excused, confirmed, late, or still to confirm. */
export function matrixStatus(r: Pick<SnapshotMatrixRow, "removed_at" | "exempt_at" | "acknowledged_at" | "overdue">): MatrixStatus {
  if (r.removed_at) return "removed";
  if (r.exempt_at) return "exempt";
  if (r.acknowledged_at) return "confirmed";
  if (r.overdue) return "overdue";
  return "pending";
}

interface PolicyCounts {
  required: number;
  confirmed: number;
  pending: number;
  overdue: number;
  exempt: number;
}

/** Live policy or not: the counts the portal shows (open rows of active accounts; exempt rows beside, never inside, the denominator). */
function countRows(rows: SnapshotMatrixRow[]): PolicyCounts {
  const c: PolicyCounts = { required: 0, confirmed: 0, pending: 0, overdue: 0, exempt: 0 };
  for (const r of rows) {
    if (r.account_status !== "active" || r.removed_at) continue;
    if (r.exempt_at) {
      c.exempt += 1;
      continue;
    }
    c.required += 1;
    if (r.acknowledged_at) c.confirmed += 1;
    else if (r.overdue) c.overdue += 1;
  }
  c.pending = c.required - c.confirmed;
  return c;
}

interface SnapshotDataset {
  app: AppSettings;
  settings: ComplianceSettings;
  settings_changed_at: string | null;
  policies: SnapshotPolicyRow[];
  matrix: SnapshotMatrixRow[];
  decisions: SnapshotDecisionRow[];
  notices: SnapshotNoticeRow[];
  /** The matrix rows per policy id, in row order. */
  byPolicy: Map<number, SnapshotMatrixRow[]>;
}

async function loadDataset(documentId: number | null): Promise<SnapshotDataset> {
  const [app, settings, settings_changed_at, policies, matrix, decisions, notices] = await Promise.all([
    getAppSettings(),
    readComplianceSettings(),
    complianceSettingsChangedAt(),
    snapshotPolicyRows(documentId),
    snapshotMatrixRows(documentId),
    snapshotDecisionRows(documentId),
    snapshotNoticeRows(documentId),
  ]);
  const byPolicy = new Map<number, SnapshotMatrixRow[]>();
  for (const r of matrix) {
    const list = byPolicy.get(r.document_id);
    if (list) list.push(r);
    else byPolicy.set(r.document_id, [r]);
  }
  return { app, settings, settings_changed_at, policies, matrix, decisions, notices, byPolicy };
}

const policyStatus = (p: SnapshotPolicyRow): "live" | "paused" | "retired" =>
  p.ack_retired_at ? "retired" : p.status === "published" && p.ack_required === 1 ? "live" : "paused";

/** The policy's settings as the snapshot records them (settings_in_effect.policies and policy.json). */
function policySettingsEntry(p: SnapshotPolicyRow) {
  return {
    id: p.id,
    edit_default: p.ack_edit_default,
    statement: p.ack_statement,
    signature: p.signature,
    due_rule: { due_days: p.due_days, due_at: p.due_at, resolved_days: p.due_days_resolved },
    recert_months: p.ack_recert_months,
    next_recert_at: iso(p.ack_next_recert_at),
    effective_at: p.ack_effective_at,
    audience_mode: p.audience_mode ?? "space",
    assign_new_members: p.assign_new_members == null ? true : p.assign_new_members === 1,
    exclude_stewards: p.exclude_stewards === 1,
    rules: p.rules.map((r) => ({ kind: r.kind, ref: r.ref, effect: r.effect })),
    owner_user_id: p.owner_user_id,
    reminders: {
      remind_before_days: p.remind_before_days,
      remind_every_days: p.remind_every_days,
      escalate_after_days: p.escalate_after_days,
      nudge_every_days: p.nudge_every_days,
    },
    requested_by: p.requested_by,
    requested_at: iso(p.requested_at),
    retired: p.ack_retired_at
      ? {
          at: iso(p.ack_retired_at),
          by_name: p.ack_retired_by_name,
          reason: p.ack_retired_reason,
          superseded_by: p.ack_superseded_by,
        }
      : null,
  };
}

/** The policy's standing as the snapshot records it (policies[] and policy.json). */
function policyEntry(p: SnapshotPolicyRow, rows: SnapshotMatrixRow[]) {
  const c = countRows(rows);
  return {
    id: p.id,
    title: p.title,
    space: p.space_name,
    space_id: p.space_id,
    set: p.set_names,
    status: policyStatus(p),
    version: p.ack_rev,
    version_id: p.ack_version_id,
    content_sha256: p.content_sha256,
    published_by: p.published_by,
    approved_by: p.approved_by,
    marker_at: iso(p.ack_revision_at),
    updated_at: iso(p.updated_at),
    due: { due_days: p.due_days, due_at: p.due_at, resolved_days: p.due_days_resolved },
    recert: { months: p.ack_recert_months, next_at: iso(p.ack_next_recert_at), effective_at: p.ack_effective_at },
    owner: p.owner_name,
    required: c.required,
    confirmed: c.confirmed,
    pending: c.pending,
    overdue: c.overdue,
    exempt: c.exempt,
  };
}

function matrixEntry(r: SnapshotMatrixRow) {
  return {
    policy_id: r.document_id,
    assignment_id: r.assignment_id,
    user_id: r.user_id,
    name: r.name,
    username: r.username,
    email: r.email,
    role: r.role,
    account_status: r.account_status,
    status: matrixStatus(r),
    source: r.source,
    assigned_at: iso(r.assigned_at),
    cycle_started_at: iso(r.cycle_started_at),
    due_at: iso(r.due_at),
    snoozed_until: iso(r.snoozed_until),
    reminded_at: iso(r.reminded_at),
    reminder_count: r.reminder_count,
    escalated_at: iso(r.escalated_at),
    exempt: r.exempt_at
      ? { at: iso(r.exempt_at), by_name: r.exempt_by_name, reason: r.exempt_reason, until: iso(r.exempt_until) }
      : null,
    removed_at: iso(r.removed_at),
    removed_reason: r.removed_reason,
    acknowledged_at: iso(r.acknowledged_at),
  };
}

function currentAckEntry(r: SnapshotMatrixRow) {
  return {
    id: r.ack_id,
    policy_id: r.document_id,
    user_id: r.user_id,
    name: r.name,
    email: r.email,
    status: matrixStatus(r),
    acknowledged_at: iso(r.acknowledged_at),
    version_id: r.version_id,
    version: r.rev,
    content_sha256: r.content_sha256,
    version_source: r.version_source,
    signed_name: r.signed_name,
    identity_proof: r.identity_proof ?? "",
    statement_text: r.statement_text ?? "",
    ip: r.ip ?? "",
    user_agent: r.user_agent ?? "",
    read_seconds: r.read_seconds,
    reached_end_self_reported: r.reached_end,
  };
}

function decisionEntry(d: SnapshotDecisionRow) {
  return {
    id: d.id,
    policy_id: d.document_id,
    policy: d.document_title,
    outcome: d.outcome,
    source: d.source,
    scope: d.scope,
    decided_at: iso(d.decided_at),
    decided_by: d.decided_by,
    decided_by_name: d.decided_by_name,
    submitted_policy: d.submitted_policy,
    submitted_by: d.submitted_by,
    submitted_by_name: d.submitted_by_name,
    reason: d.reason,
    suggested: d.suggested,
    overrode_suggestion: d.overrode_suggestion,
    change_pct: d.change_pct,
    confirmations_affected: d.confirmations_affected,
    eligible: d.eligible,
    version_id: d.version_id,
    version: d.rev,
    notified_at: iso(d.notified_at),
  };
}

/** The notice log folded per person: first, last and a count per kind, by user id (removed accounts last, by name). */
function noticesSummary(rows: SnapshotNoticeRow[]) {
  const out = new Map<string, { user_id: number | null; name: string; first: string; last: string; count: number; by_kind: Record<string, number> }>();
  for (const r of rows) {
    const key = r.user_id == null ? `gone:${r.user_name}` : `id:${r.user_id}`;
    const first = iso(r.first) ?? "";
    const last = iso(r.last) ?? "";
    const e = out.get(key);
    if (!e) {
      out.set(key, { user_id: r.user_id, name: r.user_name, first, last, count: r.n, by_kind: { [r.kind]: r.n } });
      continue;
    }
    if (first < e.first) e.first = first;
    if (last > e.last) e.last = last;
    e.count += r.n;
    e.by_kind[r.kind] = (e.by_kind[r.kind] ?? 0) + r.n;
  }
  return [...out.values()].map((e) => ({
    ...e,
    by_kind: Object.fromEntries(Object.entries(e.by_kind).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  }));
}

/** The totals over the live policies (what the Overview's tiles sum). */
function totalsOf(ds: SnapshotDataset) {
  const t = { policies: 0, required: 0, confirmed: 0, pending: 0, overdue: 0, exempt: 0, people_compliant: 0, people_total: 0 };
  const people = new Map<number, { required: number; confirmed: number }>();
  for (const p of ds.policies) {
    if (policyStatus(p) !== "live") continue;
    t.policies += 1;
    const rows = ds.byPolicy.get(p.id) ?? [];
    const c = countRows(rows);
    t.required += c.required;
    t.confirmed += c.confirmed;
    t.pending += c.pending;
    t.overdue += c.overdue;
    t.exempt += c.exempt;
    for (const r of rows) {
      if (r.account_status !== "active" || r.removed_at || r.exempt_at) continue;
      const e = people.get(r.user_id) ?? { required: 0, confirmed: 0 };
      e.required += 1;
      if (r.acknowledged_at) e.confirmed += 1;
      people.set(r.user_id, e);
    }
  }
  t.people_total = people.size;
  t.people_compliant = [...people.values()].filter((e) => e.confirmed === e.required).length;
  return t;
}

/** The snapshot body, key order fixed, arrays by id. */
function snapshotBody(ds: SnapshotDataset, ledger: { rows: number; sha256: string }, at: Date, documentId: number | null) {
  return {
    format: SNAPSHOT_FORMAT,
    app_version: currentVersion(),
    workspace: ds.app.company_name,
    generated_at: at.toISOString(),
    scope: { document_id: documentId },
    settings_in_effect: {
      program: {
        ack_defaults: ds.settings.ack_defaults,
        compliance_statement_default: ds.settings.compliance_statement_default,
        settings_changed_at: iso(ds.settings_changed_at),
      },
      policies: ds.policies.map(policySettingsEntry),
    },
    totals: totalsOf(ds),
    policies: ds.policies.map((p) => policyEntry(p, ds.byPolicy.get(p.id) ?? [])),
    matrix: ds.matrix.map(matrixEntry),
    current_acks: ds.matrix.filter((r) => r.ack_id != null).map(currentAckEntry),
    decisions: ds.decisions.map(decisionEntry),
    notices_summary: noticesSummary(ds.notices),
    ledger_rows: ledger.rows,
    ledger_sha256: ledger.sha256,
  };
}

const ledgerCursor = (documentId: number | null) => (after: number | string, limit: number) => ackLedgerBatch(after, limit, documentId);
const ledgerCells = (r: Parameters<typeof ledgerCsvCells>[0]) => ledgerCsvCells(r, true);

/**
 * The canonical snapshot text and its SHA-256: the settings in effect, the
 * totals, every policy, the matrix, the current confirmations, the
 * decisions, the notice summary, and the row count and hash of the ledger
 * (over the ledger CSV as the package writes it, in id order). Scoped to
 * one policy when `documentId` is given (the retirement snapshot and the
 * per-policy package). `at` is the one varying input: the same data at the
 * same instant serialises to the same bytes.
 */
export async function buildComplianceSnapshot(
  scope: { documentId?: number | null; at?: Date } = {}
): Promise<{ text: string; sha256: string }> {
  const documentId = scope.documentId ?? null;
  const [ds, ledger] = await Promise.all([
    loadDataset(documentId),
    hashCsv(LEDGER_CSV_HEADER, ledgerCursor(documentId), ledgerCells),
  ]);
  const text = JSON.stringify(snapshotBody(ds, ledger, scope.at ?? new Date(), documentId), null, 2) + "\n";
  return { text, sha256: sha256Hex(text) };
}

/**
 * Take and store a snapshot. A monthly one claims its 'YYYY-MM' through the
 * partial unique index: when the period is already taken the answer is
 * null and nothing is stored (so across instances one wins). `by` is the
 * person who asked, or SYSTEM for the orchestrator and the retire path.
 */
export async function takeComplianceSnapshot(
  kind: ComplianceSnapshotKind,
  opts: { by: { id: number | null; name: string }; period?: string; documentId?: number | null }
): Promise<{ id: number; sha256: string } | null> {
  if (kind === "monthly" && !opts.period) throw new Error("A monthly snapshot needs its period.");
  const { text, sha256 } = await buildComplianceSnapshot({ documentId: opts.documentId ?? null });
  const id = await insertComplianceSnapshot({
    kind,
    period: kind === "monthly" ? opts.period : "",
    documentId: kind === "retirement" ? (opts.documentId ?? null) : (opts.documentId ?? null),
    takenBy: opts.by,
    sha256,
    data: text,
  });
  return id === null ? null : { id, sha256 };
}

export { listComplianceSnapshots, getComplianceSnapshot };
export type { ComplianceSnapshotMeta };

/** Recompute the hash over the stored text: `ok` when it matches the stored one. Null when there is no such snapshot. */
export async function verifyComplianceSnapshot(id: number): Promise<{ ok: boolean; stored: string; computed: string } | null> {
  const snap = await getComplianceSnapshot(id);
  if (!snap) return null;
  const computed = sha256Hex(snap.data);
  return { ok: computed === snap.sha256, stored: snap.sha256, computed };
}

/** The download name of a snapshot: the period for a monthly one, else its kind and id. */
export function snapshotFileLabel(s: Pick<ComplianceSnapshotMeta, "id" | "kind" | "period" | "document_id">): string {
  if (s.kind === "monthly" && s.period) return s.period;
  if (s.kind === "retirement") return `retirement-${s.document_id ?? "doc"}-${s.id}`;
  return `${s.kind}-${s.id}`;
}

/**
 * The snapshot a retire writes (kind 'retirement', scoped to the policy),
 * called by retirePolicy after its commit. Never throws: a failure is
 * logged and audited as ack.snapshot_failed, and the retire stands.
 */
export async function retirementSnapshot(
  docId: number,
  by: { id: number | null; name: string }
): Promise<{ id: number; sha256: string } | null> {
  const actor: AuditActor = { id: by.id, name: by.name };
  let title = `Document #${docId}`;
  try {
    title = (await getDocument(docId))?.title ?? title;
    const snap = await takeComplianceSnapshot("retirement", { by, documentId: docId });
    if (!snap) return null;
    await audit({
      actor,
      action: "ack.snapshot",
      targetType: "document",
      targetId: docId,
      targetLabel: title,
      details: { snapshot_id: snap.id, kind: "retirement", sha256: snap.sha256, document_id: docId },
    });
    return snap;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[ack] retirement snapshot of document ${docId} failed:`, e);
    await audit({
      actor,
      action: "ack.snapshot_failed",
      targetType: "document",
      targetId: docId,
      targetLabel: title,
      details: { kind: "retirement", document_id: docId, error },
    });
    return null;
  }
}

// --- The audit package --------------------------------------------------------

/** matrix.csv: one line per assignment row of every policy in scope. roster.csv (per policy) is the same without the first three columns. */
export const MATRIX_PACKAGE_HEADER =
  "policy,policy_id,space,name,username,email,role,account_status,status,source,assigned_at,cycle_started_at,due_at,snoozed_until,acknowledged_at,version,version_id,content_sha256,version_source,signed_name,identity_proof,statement,read_seconds,reached_end_self_reported,ip,user_agent,exempt_at,exempt_by,exempt_reason,exempt_until,removed_at,removed_reason";
export const ROSTER_PACKAGE_HEADER = MATRIX_PACKAGE_HEADER.split(",").slice(3).join(",");

export function rosterPackageCells(r: SnapshotMatrixRow): unknown[] {
  return [
    r.name,
    r.username,
    r.email,
    r.role,
    r.account_status,
    matrixStatus(r),
    r.source,
    iso(r.assigned_at) ?? "",
    iso(r.cycle_started_at) ?? "",
    iso(r.due_at) ?? "",
    iso(r.snoozed_until) ?? "",
    iso(r.acknowledged_at) ?? "",
    r.rev ? `v${r.rev}` : "",
    r.version_id ?? "",
    r.content_sha256 ?? "",
    r.version_source ?? "",
    r.signed_name ?? "",
    r.identity_proof ?? "",
    r.statement_text ?? "",
    r.acknowledged_at ? (r.read_seconds ?? "") : "",
    r.acknowledged_at ? (r.reached_end ? "yes" : "no") : "",
    r.ip ?? "",
    r.user_agent ?? "",
    iso(r.exempt_at) ?? "",
    r.exempt_at ? r.exempt_by_name : "",
    r.exempt_at ? r.exempt_reason : "",
    r.exempt_at ? (iso(r.exempt_until) ?? "") : "",
    iso(r.removed_at) ?? "",
    r.removed_reason,
  ];
}

export function matrixPackageCells(p: SnapshotPolicyRow, r: SnapshotMatrixRow): unknown[] {
  return [p.title, p.id, p.space_name, ...rosterPackageCells(r)];
}

/** waivers.csv: the exempt rows (standing and dated exemptions as they are now). */
export const WAIVERS_HEADER = "policy,policy_id,name,username,email,status,exempt_at,exempt_by,exempt_reason,exempt_until";
export function waiverCells(p: SnapshotPolicyRow, r: SnapshotMatrixRow): unknown[] {
  return [p.title, p.id, r.name, r.username, r.email, matrixStatus(r), iso(r.exempt_at) ?? "", r.exempt_by_name, r.exempt_reason, iso(r.exempt_until) ?? ""];
}

/** decisions.csv: the decision ledger (C1), every outcome. */
export const DECISIONS_HEADER =
  "id,policy,policy_id,outcome,source,scope,decided_at,decided_by,reason,submitted_policy,submitted_by,suggested,overrode_suggestion,change_pct,confirmations_affected,eligible,version,version_id,notified_at";
export function decisionCells(d: SnapshotDecisionRow): unknown[] {
  return [
    d.id,
    d.document_title,
    d.document_id ?? "",
    d.outcome,
    d.source,
    d.scope,
    iso(d.decided_at) ?? "",
    d.decided_by_name,
    d.reason,
    d.submitted_policy,
    d.submitted_by_name,
    d.suggested,
    d.overrode_suggestion ? "yes" : "no",
    d.change_pct ?? "",
    d.confirmations_affected ?? "",
    d.eligible ?? "",
    d.rev ? `v${d.rev}` : "",
    d.version_id ?? "",
    iso(d.notified_at) ?? "",
  ];
}

/** notices.csv: the per-person notice log (E3), one line per delivery. */
export const NOTICES_HEADER = "id,sent_at,kind,name,email,policy,policy_id,channels,by,outbox_id";
export function noticeCells(n: AckNotice): unknown[] {
  return [
    n.id,
    iso(n.sent_at) ?? "",
    n.kind,
    n.user_name,
    n.user_email,
    n.document_title,
    n.document_id ?? "",
    (n.channels ?? []).join(" "),
    n.by_name,
    n.outbox_id ?? "",
  ];
}

/** audit-extract.csv: every ack.* audit row and the three legacy document.* keys. */
export const AUDIT_EXTRACT_HEADER = "id,at,action,actor_id,actor_name,actor_role,target_type,target_id,target_label,details,ip";
export function auditExtractCells(a: AuditExtractRow): unknown[] {
  return [
    a.id,
    iso(a.at) ?? "",
    a.action,
    a.actor_id ?? "",
    a.actor_name,
    a.actor_role ?? "",
    a.target_type ?? "",
    a.target_id ?? "",
    a.target_label ?? "",
    a.details ? JSON.stringify(a.details) : "",
    a.ip ?? "",
  ];
}

const csvText = (header: string, lines: unknown[][]): string =>
  `${header}\n${lines.map((cells) => `${csvLine(cells)}\n`).join("")}`;

export interface CompliancePackage {
  /** The ZIP bytes, for `new Response(stream)`. */
  stream: ReadableStream<Uint8Array>;
  /** The same bytes as a Node stream, for a caller that pipes or collects. */
  node: Readable;
  /** Settles once the archive has been written in full: its size and the policies it covers. Rejects when a source failed or the reader went away. */
  done: Promise<{ bytes: number; policies: number }>;
  filename: string;
  /** How many policies the package covers (known before the first byte). */
  policies: number;
}

/**
 * The audit package as a stream: summary.json (a snapshot of the same
 * instant), matrix.csv, acknowledgements.csv (the full ledger, from a
 * cursor in pages), decisions.csv, waivers.csv, notices.csv,
 * audit-extract.csv, one folder per policy (policy.json, roster.csv,
 * history.csv, waivers.csv, decisions.csv and versions/v{N}.md for every
 * version a current confirmation or a decision cites, read from
 * doc_versions or the archive so a hash stays checkable), every stored
 * snapshot in scope under snapshots/, and manifest.json last with the
 * SHA-256 of every file. With `documentId` the whole package is scoped to
 * that one policy. Nothing large is held in memory: the streamed files are
 * pulled by the archive as it reaches them, and every lazy entry is read
 * then. The caller audits once `done` settles.
 */
export async function buildCompliancePackage(opts: { documentId?: number | null; by?: string } = {}): Promise<CompliancePackage> {
  const documentId = opts.documentId ?? null;
  const at = new Date();
  const ds = await loadDataset(documentId);
  const zip = new JSZip();
  type Entry = { name: string; sha256?: string; pending?: Promise<StreamedFile> };
  const entries: Entry[] = [];
  const text = (name: string, content: string) => {
    zip.file(name, content);
    entries.push({ name, sha256: sha256Hex(content) });
  };
  const lazy = (name: string, source: () => AsyncIterable<string | Buffer>) => {
    entries.push({ name, pending: addStreamed(zip, name, source) });
  };
  const titleOf = new Map(ds.policies.map((p) => [p.id, p]));

  // 1. The ledger, streamed; 2. the summary, which carries the ledger's
  // hash and so waits for it (the archive reads entries in order).
  const ledger = addStreamedCsv(zip, "acknowledgements.csv", LEDGER_CSV_HEADER, ledgerCursor(documentId), ledgerCells);
  entries.push({ name: "acknowledgements.csv", pending: ledger });
  lazy("summary.json", async function* () {
    const l = await ledger;
    yield JSON.stringify(snapshotBody(ds, { rows: l.rows, sha256: l.sha256 }, at, documentId), null, 2) + "\n";
  });

  text(
    "matrix.csv",
    csvText(
      MATRIX_PACKAGE_HEADER,
      ds.matrix.map((r) => matrixPackageCells(titleOf.get(r.document_id)!, r))
    )
  );
  text("decisions.csv", csvText(DECISIONS_HEADER, ds.decisions.map(decisionCells)));
  text(
    "waivers.csv",
    csvText(
      WAIVERS_HEADER,
      ds.matrix.filter((r) => r.exempt_at).map((r) => waiverCells(titleOf.get(r.document_id)!, r))
    )
  );
  entries.push({
    name: "notices.csv",
    pending: addStreamedCsv(zip, "notices.csv", NOTICES_HEADER, (after, limit) => ackNoticesBatch(after, limit, documentId), noticeCells),
  });
  entries.push({
    name: "audit-extract.csv",
    pending: addStreamedCsv(zip, "audit-extract.csv", AUDIT_EXTRACT_HEADER, (after, limit) => auditExtractBatch(after, limit, documentId), auditExtractCells),
  });

  for (const p of ds.policies) {
    const dir = `policies/${p.id}`;
    const rows = ds.byPolicy.get(p.id) ?? [];
    text(`${dir}/policy.json`, JSON.stringify({ ...policyEntry(p, rows), settings: policySettingsEntry(p) }, null, 2) + "\n");
    text(`${dir}/roster.csv`, csvText(ROSTER_PACKAGE_HEADER, rows.map(rosterPackageCells)));
    entries.push({
      name: `${dir}/history.csv`,
      pending: addStreamedCsv(zip, `${dir}/history.csv`, LEDGER_CSV_HEADER, ledgerCursor(p.id), ledgerCells),
    });
    text(`${dir}/waivers.csv`, csvText(WAIVERS_HEADER, rows.filter((r) => r.exempt_at).map((r) => waiverCells(p, r))));
    text(`${dir}/decisions.csv`, csvText(DECISIONS_HEADER, ds.decisions.filter((d) => d.document_id === p.id).map(decisionCells)));
    // Every version a current confirmation or a decision on this policy
    // cites, named by its Version-history number; the text is read when the
    // archive reaches the entry, and its hash in the manifest is the
    // rows' content_sha256 (the hash is over exactly this text).
    const versions = new Map<number, number | null>();
    for (const r of rows) if (r.ack_id != null && r.version_id != null && !versions.has(r.version_id)) versions.set(r.version_id, r.rev);
    for (const d of ds.decisions) if (d.document_id === p.id && d.version_id != null && !versions.has(d.version_id)) versions.set(d.version_id, d.rev);
    for (const [versionId, rev] of [...versions.entries()].sort((a, b) => a[0] - b[0])) {
      const name = rev ? `${dir}/versions/v${rev}.md` : `${dir}/versions/version-${versionId}.md`;
      lazy(name, async function* () {
        const [row] = await attestedTextsFor([versionId]);
        if (!row) {
          console.error(`[ack] audit package: version ${versionId} of document ${p.id} has no text on record`);
          return;
        }
        yield row.content;
      });
    }
  }

  // Every stored snapshot in scope: the workspace's for the whole package,
  // the policy's own (its retirement) for one policy.
  const snapshots = await listComplianceSnapshots(500, documentId == null ? {} : { documentId });
  const seen = new Set<string>();
  for (const s of [...snapshots].sort((a, b) => a.id - b.id)) {
    let name = `snapshots/${snapshotFileLabel(s)}.json`;
    if (seen.has(name)) name = `snapshots/${snapshotFileLabel(s)}-${s.id}.json`;
    seen.add(name);
    lazy(name, async function* () {
      const full = await getComplianceSnapshot(s.id);
      if (full) yield full.data;
    });
  }

  const [app] = [ds.app];
  lazy("manifest.json", async function* () {
    const files = await Promise.all(
      entries.map(async (e) => ({ name: e.name, sha256: e.sha256 ?? (await e.pending!).sha256 }))
    );
    const manifest = manifestFor(files, {
      app_version: currentVersion(),
      workspace: app.company_name,
      generated_at: at.toISOString(),
      generated_by: opts.by,
    });
    yield JSON.stringify(manifest, null, 2) + "\n";
  });

  // The archive, counted on its way out so the caller can audit the size.
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  const done = new Promise<{ bytes: number; policies: number }>((resolve, reject) => {
    let settled = false;
    counter.on("end", () => {
      settled = true;
      resolve({ bytes, policies: ds.policies.length });
    });
    counter.on("error", (e) => {
      settled = true;
      reject(e);
    });
    counter.on("close", () => {
      if (!settled) reject(new Error("The audit package stream closed before it was written in full."));
    });
  });
  // A rejection nobody awaits yet (a client that never reads) must not be an
  // unhandled rejection; the caller that awaits `done` still sees it.
  done.catch(() => {});
  const out = zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE" });
  out.on("error", (e: Error) => counter.destroy(e));
  out.pipe(counter);
  const stamp = at.toISOString().slice(0, 10);
  return {
    stream: Readable.toWeb(counter) as unknown as ReadableStream<Uint8Array>,
    node: counter,
    done,
    filename: documentId == null ? `compliance-audit-package-${stamp}.zip` : `compliance-audit-package-doc-${documentId}-${stamp}.zip`,
    policies: ds.policies.length,
  };
}

/** The package collected into one Buffer (tests and one-shot callers). */
export async function buildCompliancePackageBuffer(opts: { documentId?: number | null; by?: string } = {}): Promise<{ buffer: Buffer; policies: number; bytes: number }> {
  const pkg = await buildCompliancePackage(opts);
  const buffer = await collectZip(pkg.node);
  const { bytes, policies } = await pkg.done;
  return { buffer, policies, bytes };
}

// --- The programme report ------------------------------------------------------

export interface ReportCounts {
  policies: number;
  pct: number;
  confirmed: number;
  pending: number;
  overdue: number;
  exempt: number;
  people_overdue: number;
  escalations: number;
  new_joiners: number;
  exemptions_granted: number;
  standing_exemptions_old: number;
  lowest: { id: number; title: string; pct: number; overdue: number }[];
  deadlines: { id: number; title: string; people: number; due_at: string }[];
}

const n = (v: number) => v.toLocaleString("en-US");
const people = (v: number) => `${n(v)} ${v === 1 ? "person" : "people"}`;

/**
 * The bullets of the programme report for `period` ('YYYY-MM' or
 * 'YYYY-Www'; anything else reads as the last seven days): the standing of
 * the live policies, the period's escalations, enrolments and exemptions,
 * the five policies with the lowest compliance, and the deadlines falling
 * in the next 14 days. Markdown, for the ack_program_report template.
 */
export async function complianceReportSummary(period: string, opts: { now?: Date } = {}): Promise<{ markdown: string; counts: ReportCounts }> {
  const now = opts.now ?? new Date();
  const window = periodWindow(period) ?? { from: new Date(now.getTime() - 7 * 86400000), to: now };
  const [ds, rc] = await Promise.all([loadDataset(null), complianceReportCounts(window.from.toISOString(), window.to.toISOString())]);
  const totals = totalsOf(ds);
  const pct = totals.required ? Math.round((totals.confirmed / totals.required) * 100) : 100;
  const live = ds.policies.filter((p) => policyStatus(p) === "live");
  const overduePeople = new Set<number>();
  const deadlines = new Map<number, { id: number; title: string; people: number; due_at: string }>();
  const horizon = now.getTime() + 14 * 86400000;
  for (const p of live) {
    for (const r of ds.byPolicy.get(p.id) ?? []) {
      if (r.account_status !== "active" || r.removed_at || r.exempt_at || r.acknowledged_at) continue;
      if (r.overdue) overduePeople.add(r.user_id);
      const due = r.due_at ? new Date(r.due_at).getTime() : NaN;
      if (Number.isFinite(due) && due >= now.getTime() && due <= horizon) {
        const e = deadlines.get(p.id) ?? { id: p.id, title: p.title, people: 0, due_at: r.due_at! };
        e.people += 1;
        if (r.due_at! < e.due_at) e.due_at = r.due_at!;
        deadlines.set(p.id, e);
      }
    }
  }
  const lowest = live
    .map((p) => {
      const c = countRows(ds.byPolicy.get(p.id) ?? []);
      return { id: p.id, title: p.title, pct: c.required ? Math.round((c.confirmed / c.required) * 100) : 100, overdue: c.overdue, required: c.required };
    })
    .filter((p) => p.required > 0)
    .sort((a, b) => a.pct - b.pct || b.overdue - a.overdue || a.title.localeCompare(b.title))
    .slice(0, 5)
    .map(({ id, title, pct, overdue }) => ({ id, title, pct, overdue }));
  const counts: ReportCounts = {
    policies: totals.policies,
    pct,
    confirmed: totals.confirmed,
    pending: totals.pending,
    overdue: totals.overdue,
    exempt: totals.exempt,
    people_overdue: overduePeople.size,
    escalations: rc.escalations,
    new_joiners: rc.new_joiners,
    exemptions_granted: rc.exemptions_granted,
    standing_exemptions_old: rc.standing_exemptions_old,
    lowest,
    deadlines: [...deadlines.values()].sort((a, b) => a.due_at.localeCompare(b.due_at) || a.title.localeCompare(b.title)),
  };
  const lines = [
    `- **${n(counts.policies)}** policies · **${counts.pct}%** compliance (${n(counts.confirmed)} confirmed, ${n(counts.pending)} pending, ${n(counts.overdue)} overdue, ${n(counts.exempt)} exempt)`,
    `- **${n(counts.people_overdue)}** people overdue · **${n(counts.escalations)}** escalations this period · **${n(counts.new_joiners)}** new joiners enrolled · **${n(counts.exemptions_granted)}** exemptions granted · **${n(counts.standing_exemptions_old)}** standing exemptions older than a year`,
  ];
  if (lowest.length) {
    lines.push("", "Lowest compliance:");
    for (const p of lowest) lines.push(`- ${p.title}: ${p.pct}% (${n(p.overdue)} overdue)`);
  }
  if (counts.deadlines.length) {
    lines.push("", "Deadlines in the next 14 days:");
    for (const d of counts.deadlines) lines.push(`- ${d.title}: ${people(d.people)} due by ${formatDate(d.due_at, ds.app)}`);
  }
  return { markdown: lines.join("\n"), counts };
}

/**
 * Send the report to the configured recipients (active accounts with an
 * address) when the report is enabled and SMTP is configured; answers how
 * many were mailed (0 when nothing went out). Audited as ack.report_sent.
 */
async function sendComplianceReport(input: {
  period: string;
  cadence: "weekly" | "monthly";
  snapshotSha256: string;
  snapshotLabel?: string;
  now?: Date;
}): Promise<number> {
  const { ack_report } = await readComplianceSettings();
  if (!ack_report.enabled || ack_report.recipients.length === 0) return 0;
  if (!smtpConfigured(await getSmtpConfig())) {
    console.error("[periodic] compliance report: SMTP is not configured, nothing sent");
    return 0;
  }
  const wanted = new Set(ack_report.recipients);
  const recipients = (await listUsers()).filter((u) => wanted.has(u.id) && u.status === "active" && u.email);
  if (recipients.length === 0) return 0;
  const settings = await getAppSettings();
  const origin = settings.custom_domain ? `https://${settings.custom_domain}` : "";
  const { markdown } = await complianceReportSummary(input.period, { now: input.now });
  const vars = {
    period: input.period,
    summary: markdown,
    snapshot_sha256: input.snapshotSha256,
    snapshot_label: input.snapshotLabel ?? "",
    portal_url: `${origin}/compliance/evidence`,
    org_name: settings.company_name,
  };
  let sent = 0;
  for (const u of recipients) {
    const { subject, text, html } = await renderEmail("ack_program_report", vars, origin);
    try {
      await sendMail([u.email], subject, text, html);
      sent += 1;
    } catch (e) {
      console.error(`[periodic] compliance report to user #${u.id} failed:`, e);
    }
  }
  await audit({
    actor: SYSTEM,
    action: "ack.report_sent",
    targetType: "compliance",
    targetId: null,
    targetLabel: input.period,
    details: {
      period: input.period,
      cadence: input.cadence,
      recipients: recipients.map((u) => u.id),
      sent,
      snapshot_sha256: input.snapshotSha256,
    },
  });
  return sent;
}

// --- The orchestrator's entry points (lib/periodic runPeriodic) ------------------

/**
 * Monthly: take this month's snapshot (claimed through the unique index, so
 * one instance wins and the others find the period taken), audit it, and
 * send the monthly report when the report is on a monthly cadence, with
 * the snapshot's hash in the body. Idempotent: a tick that finds the month
 * taken does nothing. `now` is for the tests.
 */
export async function monthlyComplianceEvidence(now: Date = new Date()): Promise<void> {
  if (!(await featureEnabled("policy_ack"))) return;
  const period = monthId(now);
  // The cheap look before the expensive build: every tick of every
  // instance asks all month long.
  if (await complianceSnapshotTaken(period)) return;
  const snap = await takeComplianceSnapshot("monthly", { by: SYSTEM, period });
  if (!snap) return;
  await audit({
    actor: SYSTEM,
    action: "ack.snapshot",
    targetType: "compliance",
    targetId: null,
    targetLabel: period,
    details: { snapshot_id: snap.id, kind: "monthly", sha256: snap.sha256, period },
  });
  const { ack_report } = await readComplianceSettings();
  if (ack_report.enabled && ack_report.cadence === "monthly") {
    await sendComplianceReport({ period, cadence: "monthly", snapshotSha256: snap.sha256, snapshotLabel: period, now }).catch((e) =>
      console.error("[periodic] monthly compliance report:", e)
    );
  }
}

/**
 * Weekly: when the report is enabled on a weekly cadence with recipients
 * and SMTP is configured, claim the ISO week ('ack_report_week') and send,
 * with the latest monthly snapshot's hash in the body. SMTP is checked
 * before the claim, so an unconfigured workspace does not burn the week.
 */
export async function weeklyComplianceReport(now: Date = new Date()): Promise<void> {
  if (!(await featureEnabled("policy_ack"))) return;
  const { ack_report } = await readComplianceSettings();
  if (!ack_report.enabled || ack_report.cadence !== "weekly" || ack_report.recipients.length === 0) return;
  if (!smtpConfigured(await getSmtpConfig())) return;
  const period = isoWeekId(now);
  if (!(await claimPeriod("ack_report_week", period))) return;
  const latest = (await listComplianceSnapshots(100)).find((s) => s.kind === "monthly");
  await sendComplianceReport({
    period,
    cadence: "weekly",
    snapshotSha256: latest?.sha256 ?? "",
    snapshotLabel: latest?.period,
    now,
  });
}
