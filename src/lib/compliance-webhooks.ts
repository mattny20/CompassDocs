// Chat channel notices for the read-confirmation programme (H3, 1.14.0):
// the five policy events of lib/webhooks, built here and sent through the
// org-level outgoing webhooks with their per-space filter. Every emit is one
// event per policy (never one per recipient), fired AFTER the outbox row
// that tells the people themselves has been queued, and never awaited on a
// request path (`void emitPolicyRequested(...)`): a slow channel never slows
// a save. The sweeps' own emits (the deadline pass, the weekly summary) are
// awaited by the tick that runs them.
//
// Privacy rule: a channel hears counts and policy titles, never the names of
// the people who owe a confirmation. The one name a sentence carries is the
// actor's (the manager who asked, the manager who retired). A hook with no
// space filter receives the titles of private-space policies too, exactly
// as document.published does; the docs tell admins to scope such hooks.
//
// Everything is gated on the policy_ack entitlement and answers quietly
// (false / a skipped reason) when it is off, when the policy is gone, or
// when no hook subscribes: nothing here throws into a caller.

import "server-only";
import { pool, listWebhooks, claimPeriod, complianceDocs, listComplianceSnapshots } from "./db";
import type { AckActor, AckSweepDefaults } from "./db";
import { PA_OPEN } from "./audience";
import { notifyWebhooks } from "./webhooks";
import type { WebhookEvent, WebhookInfo, WebhookPolicyInfo, WebhookSummaryInfo } from "./webhooks";
import { featureEnabled } from "./ee";
import { getAppSettings } from "./settings-store";
import { getComplianceSettings } from "./compliance-settings";
import { formatDate } from "./format";
import { DUE_NUMBER_KEYS, daysLeft, resolveDefaults } from "./ack-due";
import type { PolicyDefaultsLayer } from "./ack-due";
import { isoWeekId, monthId } from "./periodic";
import type { AppSettings } from "./settings";

/** The settings-table claim of the weekly summary (one message per hook per ISO week, across instances). */
export const WEEKLY_HOOK_CLAIM_KEY = "ack_weekly_hook";
/** The per-policy claim of the deadline notice: `${prefix}${docId}`, keyed on the due date's calendar day. */
export const DEADLINE_HOOK_CLAIM_PREFIX = "ack_deadline_hook_";
/** The envelope's actor for events nobody clicked (the sweeps, the weekly summary). */
export const SYSTEM_ACTOR_NAME = "CompassDocs";

/** The portal's row for the policy. */
const POLICY_LINK = (id: number) => `/compliance/policies?policy=${id}`;

// --- One policy's standing ---------------------------------------------------------

/** A live policy (alias d): required, published, not trashed, not a branch, not retired. */
const LIVE_SQL = `d.ack_required = 1 AND d.status = 'published' AND d.deleted_at IS NULL AND d.branch_of IS NULL AND d.ack_retired_at IS NULL`;

interface PolicyStanding {
  id: number;
  title: string;
  space_id: number;
  live: boolean;
  required: number;
  acked: number;
  overdue: number;
  /** The latest deadline among the open, unconfirmed rows: the one a request (or a cycle) just set. */
  latest_due: string | null;
  /** The soonest deadline still ahead among them: the one approaching. */
  next_due: string | null;
}

/**
 * The counts the portal's tiles would show for one policy (open rows of
 * active accounts; a confirmation on or after the later of the marker and
 * the row's cycle start; overdue past the due date plus the space's or the
 * workspace's grace), with the two deadlines the sentences name. Null when
 * the document is gone.
 */
async function policyStanding(docId: number, graceDays: number): Promise<PolicyStanding | null> {
  const r = await pool().query<PolicyStanding>(
    `SELECT d.id, d.title, d.space_id, (${LIVE_SQL}) AS live,
            COUNT(u.id)::int AS required,
            COUNT(u.id) FILTER (WHERE a.acknowledged_at IS NOT NULL)::int AS acked,
            COUNT(u.id) FILTER (WHERE a.acknowledged_at IS NULL AND pa.due_at IS NOT NULL
              AND pa.due_at + make_interval(days => COALESCE((s.policy_defaults->>'overdue_grace_days')::int, $2::int, 0)) < now())::int AS overdue,
            MAX(pa.due_at) FILTER (WHERE u.id IS NOT NULL AND a.acknowledged_at IS NULL) AS latest_due,
            MIN(pa.due_at) FILTER (WHERE u.id IS NOT NULL AND a.acknowledged_at IS NULL AND pa.due_at > now()) AS next_due
     FROM documents d
     JOIN spaces s ON s.id = d.space_id
     LEFT JOIN policy_assignments pa ON pa.document_id = d.id AND ${PA_OPEN}
     LEFT JOIN users u ON u.id = pa.user_id AND u.status = 'active'
     LEFT JOIN LATERAL (
       SELECT a.acknowledged_at FROM acknowledgements a
       WHERE a.document_id = d.id AND a.user_id = u.id
         AND a.acknowledged_at >= GREATEST(d.ack_revision_at, pa.cycle_started_at)
       ORDER BY a.acknowledged_at DESC LIMIT 1
     ) a ON true
     WHERE d.id = $1
     GROUP BY d.id, d.title, d.space_id, d.ack_required, d.status, d.deleted_at, d.branch_of, d.ack_retired_at`,
    [docId, graceDays]
  );
  return r.rows[0] ?? null;
}

/** The workspace layer of the deadline cascade (ack_defaults' numbers an admin set), as lib/compliance reads it. */
async function workspaceLayer(): Promise<PolicyDefaultsLayer> {
  const { ack_defaults } = await getComplianceSettings();
  const out: PolicyDefaultsLayer = {};
  for (const key of DUE_NUMBER_KEYS) if (ack_defaults[key] != null) out[key] = ack_defaults[key];
  return out;
}

/** The sweeps' five numbers, resolved over the built-ins (the same shape complianceHourly passes in). */
async function workspaceNumbers(): Promise<AckSweepDefaults> {
  const v = resolveDefaults({ workspace: await workspaceLayer() }).values;
  return {
    remind_before_days: v.remind_before_days,
    remind_every_days: v.remind_every_days,
    escalate_after_days: v.escalate_after_days,
    nudge_every_days: v.nudge_every_days,
    overdue_grace_days: v.overdue_grace_days,
  };
}

/** The links' origin: the custom_domain setting when there is one, else the request's (a sweep has none: no link). */
function originFor(settings: AppSettings, requestOrigin?: string): string {
  if (settings.custom_domain) return `https://${settings.custom_domain}`;
  return requestOrigin ?? "";
}

/** "2026-10-29": the calendar day of an instant in the workspace's zone (UTC when the zone is unusable). */
export function calendarDay(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: timeZone || "UTC" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: "UTC" }).format(d);
  }
}

function policyInfo(
  s: PolicyStanding,
  settings: AppSettings,
  fields: { due_at: string | null; people: number; days?: number; cycle?: "annual"; superseded_by?: { id: number; title: string } | null },
  counts: { required: number; acked: number; overdue: number } = { required: s.required, acked: s.acked, overdue: s.overdue }
): WebhookPolicyInfo {
  const info: WebhookPolicyInfo = {
    id: s.id,
    title: s.title,
    due_at: fields.due_at,
    due_label: fields.due_at ? formatDate(fields.due_at, settings) || null : null,
    counts,
    people: fields.people,
  };
  if (fields.days !== undefined) info.days = fields.days;
  if (fields.cycle) info.cycle = fields.cycle;
  if (fields.superseded_by !== undefined) info.superseded_by = fields.superseded_by;
  return info;
}

/** Every enabled hook subscribed to the event. */
async function hooksFor(event: WebhookEvent): Promise<{ scoped: number; unscoped: number }> {
  const hooks = await listWebhooks();
  let scoped = 0;
  let unscoped = 0;
  for (const h of hooks) {
    if (h.enabled !== 1 || !(h.events ?? []).includes(event)) continue;
    if ((h.space_ids ?? []).length > 0) scoped++;
    else unscoped++;
  }
  return { scoped, unscoped };
}

/** Runs one emit to completion and logs instead of throwing: every caller may `void` it. */
async function guarded(name: string, run: () => Promise<boolean>): Promise<boolean> {
  try {
    return await run();
  } catch (e) {
    console.error(`[webhooks] ${name}:`, e);
    return false;
  }
}

// --- The emits ----------------------------------------------------------------------

export interface PolicyRequestedOptions {
  /** The name the sentence carries: the manager who asked, or the cycle's actor. */
  actor: string;
  /** People asked; read from the policy's pending rows when the caller has no count. */
  people?: number;
  /** The deadline named; the latest one the policy's open rows carry when absent; null for none. */
  due_at?: string | null;
  /** The sending request's origin for the link; a sweep passes nothing. */
  origin?: string;
  /** An annual re-confirmation cycle (G1): "Annual re-confirmation of … started". */
  cycle?: "annual";
}

/**
 * policy.requested: a policy started asking people (the portal's or the
 * shield's Request with notice, a whole-audience re-ask, a set assignment,
 * an annual cycle). One event per policy, after the outbox row. Answers
 * whether an event was sent (false: unlicensed, the policy is gone, or the
 * emit failed and was logged).
 */
export function emitPolicyRequested(docId: number, opts: PolicyRequestedOptions): Promise<boolean> {
  return guarded("policy.requested", async () => {
    if (!(await featureEnabled("policy_ack"))) return false;
    const [settings, numbers] = await Promise.all([getAppSettings(), workspaceNumbers()]);
    const s = await policyStanding(docId, numbers.overdue_grace_days);
    if (!s) return false;
    const people = opts.people ?? Math.max(0, s.required - s.acked);
    const due_at = opts.due_at === undefined ? s.latest_due : opts.due_at;
    const origin = originFor(settings, opts.origin);
    await notifyWebhooks("policy.requested", {
      title: s.title,
      actor: opts.actor || SYSTEM_ACTOR_NAME,
      url: origin ? `${origin}${POLICY_LINK(s.id)}` : undefined,
      spaceId: s.space_id,
      policy: policyInfo(s, settings, { due_at, people, cycle: opts.cycle }),
    });
    return true;
  });
}

/**
 * policy.escalated: the escalation sweep stamped `people` rows of this
 * policy as more than `days` days past due (escalateOverdueAcks, once per
 * policy per sweep that escalated someone). The count is the people
 * escalated this sweep; the policy's whole overdue number rides in counts.
 */
export function emitPolicyEscalated(docId: number, people: number, opts: { days?: number } = {}): Promise<boolean> {
  return guarded("policy.escalated", async () => {
    if (!(await featureEnabled("policy_ack"))) return false;
    const [settings, numbers] = await Promise.all([getAppSettings(), workspaceNumbers()]);
    const s = await policyStanding(docId, numbers.overdue_grace_days);
    if (!s) return false;
    const days = opts.days ?? numbers.overdue_grace_days + numbers.escalate_after_days;
    const origin = originFor(settings);
    await notifyWebhooks("policy.escalated", {
      title: s.title,
      actor: SYSTEM_ACTOR_NAME,
      url: origin ? `${origin}${POLICY_LINK(s.id)}` : undefined,
      spaceId: s.space_id,
      policy: policyInfo(s, settings, { due_at: s.next_due, people, days }),
    });
    return true;
  });
}

/**
 * policy.retired: "retired by, replaced by" (retirePolicy's commit path, G3).
 * `counts` are the ones frozen on the 'retired' ledger row when the caller
 * has them (after retirement the rows still stand, so the live read agrees).
 */
export function emitPolicyRetired(
  docId: number,
  actor: AckActor,
  supersededBy: number | null,
  opts: { counts?: { acked: number; required: number } } = {}
): Promise<boolean> {
  return guarded("policy.retired", async () => {
    if (!(await featureEnabled("policy_ack"))) return false;
    const [settings, numbers] = await Promise.all([getAppSettings(), workspaceNumbers()]);
    const s = await policyStanding(docId, numbers.overdue_grace_days);
    if (!s) return false;
    let superseded: { id: number; title: string } | null = null;
    if (supersededBy) {
      const r = await pool().query<{ id: number; title: string }>(
        "SELECT id, title FROM documents WHERE id = $1 AND deleted_at IS NULL",
        [supersededBy]
      );
      superseded = r.rows[0] ?? null;
    }
    const counts = opts.counts
      ? { required: opts.counts.required, acked: opts.counts.acked, overdue: s.overdue }
      : { required: s.required, acked: s.acked, overdue: s.overdue };
    const origin = originFor(settings);
    await notifyWebhooks("policy.retired", {
      title: s.title,
      actor: actor.name || SYSTEM_ACTOR_NAME,
      url: origin ? `${origin}${POLICY_LINK(s.id)}` : undefined,
      spaceId: s.space_id,
      policy: policyInfo(s, settings, { due_at: null, people: counts.required, superseded_by: superseded }, counts),
    });
    return true;
  });
}

export interface DeadlineSweepOptions {
  /** Limit the pass to these policies (tests sharing a database; the tick passes nothing). */
  documentIds?: number[];
  /** The workspace-resolved numbers; read from the settings when absent. */
  defaults?: AckSweepDefaults;
  now?: Date;
}

export interface DeadlineSweepResult {
  /** Live policies whose soonest deadline is inside their remind_before_days window. */
  policies: number;
  /** Events sent this pass (a deadline is announced once: the claim). */
  announced: number;
  /** Why nothing was done at all, else null. */
  skipped: "unlicensed" | "no_hooks" | null;
}

interface DeadlineRow {
  id: number;
  title: string;
  space_id: number;
  required: number;
  acked: number;
  overdue: number;
  next_due: string;
}

/**
 * policy.deadline_approaching, from complianceHourly after remindDueAcks:
 * for every live policy whose soonest upcoming deadline (over open,
 * unconfirmed rows of active accounts) falls within its remind_before_days
 * (policy_settings, else the space's policy_defaults, else the workspace's),
 * one event with the pending count, once per policy per due date: the
 * settings-table claim `ack_deadline_hook_{docId}` keyed on the deadline's
 * calendar day (the workspace's zone), so the people asked on one day share
 * one notice however their timestamps differ, and a later deadline (a new
 * cohort, an extension) is announced in its turn. Nothing is claimed when
 * no hook subscribes, so a hook added later still hears a deadline that is
 * still ahead.
 */
export async function emitPolicyDeadlines(opts: DeadlineSweepOptions = {}): Promise<DeadlineSweepResult> {
  const none: DeadlineSweepResult = { policies: 0, announced: 0, skipped: null };
  if (!(await featureEnabled("policy_ack"))) return { ...none, skipped: "unlicensed" };
  const hooks = await hooksFor("policy.deadline_approaching");
  if (hooks.scoped + hooks.unscoped === 0) return { ...none, skipped: "no_hooks" };
  const [settings, numbers] = await Promise.all([getAppSettings(), opts.defaults ? Promise.resolve(opts.defaults) : workspaceNumbers()]);
  const now = opts.now ?? new Date();
  const r = await pool().query<DeadlineRow>(
    `WITH rows AS (
       SELECT d.id, d.title, d.space_id, pa.due_at, a.acknowledged_at,
              COALESCE(ps.remind_before_days, (s.policy_defaults->>'remind_before_days')::int, $1::int) AS before_days,
              COALESCE((s.policy_defaults->>'overdue_grace_days')::int, $2::int, 0) AS grace_days
       FROM documents d
       JOIN spaces s ON s.id = d.space_id
       LEFT JOIN policy_settings ps ON ps.document_id = d.id
       JOIN policy_assignments pa ON pa.document_id = d.id AND ${PA_OPEN}
       JOIN users u ON u.id = pa.user_id AND u.status = 'active'
       LEFT JOIN LATERAL (
         SELECT a.acknowledged_at FROM acknowledgements a
         WHERE a.document_id = d.id AND a.user_id = u.id
           AND a.acknowledged_at >= GREATEST(d.ack_revision_at, pa.cycle_started_at)
         ORDER BY a.acknowledged_at DESC LIMIT 1
       ) a ON true
       WHERE ${LIVE_SQL} AND ($3::int[] IS NULL OR d.id = ANY($3::int[]))
     )
     SELECT id, title, space_id,
            COUNT(*)::int AS required,
            COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acked,
            COUNT(*) FILTER (WHERE acknowledged_at IS NULL AND due_at IS NOT NULL
              AND due_at + make_interval(days => grace_days) < $4::timestamptz)::int AS overdue,
            MIN(due_at) FILTER (WHERE acknowledged_at IS NULL AND due_at > $4::timestamptz) AS next_due
     FROM rows
     GROUP BY id, title, space_id
     HAVING MIN(due_at) FILTER (WHERE acknowledged_at IS NULL AND due_at > $4::timestamptz)
            <= $4::timestamptz + make_interval(days => MIN(before_days))
     ORDER BY id`,
    [numbers.remind_before_days, numbers.overdue_grace_days, opts.documentIds ?? null, now.toISOString()]
  );
  const result: DeadlineSweepResult = { policies: r.rows.length, announced: 0, skipped: null };
  const origin = originFor(settings);
  // The claims run one by one; the deliveries run together, so a dead
  // endpoint costs the tick one timeout, not one per policy.
  const sends: Promise<boolean>[] = [];
  for (const row of r.rows) {
    const period = calendarDay(row.next_due, settings.timezone);
    if (!(await claimPeriod(`${DEADLINE_HOOK_CLAIM_PREFIX}${row.id}`, period))) continue;
    const people = Math.max(0, row.required - row.acked);
    const days = Math.max(0, daysLeft(row.next_due, now, settings.timezone || "UTC"));
    sends.push(
      guarded("policy.deadline_approaching", async () => {
        await notifyWebhooks("policy.deadline_approaching", {
          title: row.title,
          actor: SYSTEM_ACTOR_NAME,
          url: origin ? `${origin}${POLICY_LINK(row.id)}` : undefined,
          spaceId: row.space_id,
          policy: policyInfo({ ...row, live: true, latest_due: row.next_due }, settings, { due_at: row.next_due, people, days }),
        });
        return true;
      })
    );
    result.announced++;
  }
  await Promise.all(sends);
  return result;
}

export interface WeeklySummaryOptions {
  now?: Date;
  /** The claim's period; isoWeekId(now) when absent (tests pick their own). */
  period?: string;
}

export interface WeeklySummaryResult {
  /** Hooks the summary went to (unscoped, enabled, subscribed). */
  sent: number;
  period: string;
  summary: WebhookSummaryInfo | null;
  skipped: "unlicensed" | "no_hooks" | "claimed" | null;
}

/**
 * policy.weekly_summary, from the neutral orchestrator (lib/periodic): once
 * per ISO week across instances (claimPeriod 'ack_weekly_hook'), one message
 * per hook with no space filter: the portal's compliance percentage, the
 * overdue count across the live policies, the lowest-compliance policy, and
 * the month's evidence snapshot hash (F2) when one was taken. The hooks are
 * checked before the claim, so a week with nobody listening is not burned.
 */
export async function weeklyPolicyChannelSummary(opts: WeeklySummaryOptions = {}): Promise<WeeklySummaryResult> {
  const now = opts.now ?? new Date();
  const period = opts.period ?? isoWeekId(now);
  const none: WeeklySummaryResult = { sent: 0, period, summary: null, skipped: null };
  if (!(await featureEnabled("policy_ack"))) return { ...none, skipped: "unlicensed" };
  const hooks = await hooksFor("policy.weekly_summary");
  if (hooks.unscoped === 0) return { ...none, skipped: "no_hooks" };
  if (!(await claimPeriod(WEEKLY_HOOK_CLAIM_KEY, period))) return { ...none, skipped: "claimed" };

  const [docs, snapshots, settings] = await Promise.all([complianceDocs(), listComplianceSnapshots(100), getAppSettings()]);
  // The tiles' rule (GET /api/admin/compliance): published, unretired
  // policies only; a paused or retired one is outside every sum.
  const live = docs.filter((d) => d.status === "published" && d.ack_retired_at === null);
  const required = live.reduce((n, d) => n + d.required, 0);
  const acked = live.reduce((n, d) => n + d.acked, 0);
  const pctOf = (d: { required: number; acked: number }) => (d.required ? Math.round((d.acked / d.required) * 100) : 100);
  const asked = live.filter((d) => d.required > 0);
  const lowest = asked.length
    ? asked.reduce((low, d) => (pctOf(d) < pctOf(low) ? d : low), asked[0])
    : null;
  const month = monthId(now);
  const snapshot = snapshots.find((s) => s.kind === "monthly" && s.period === month) ?? null;
  const summary: WebhookSummaryInfo = {
    week: period,
    pct: required ? Math.round((acked / required) * 100) : 100,
    policies: live.length,
    overdue: live.reduce((n, d) => n + d.overdue, 0),
    lowest: lowest ? { id: lowest.id, title: lowest.title, pct: pctOf(lowest) } : null,
    snapshot_sha256: snapshot?.sha256 ?? null,
    snapshot_period: snapshot ? month : null,
  };
  const origin = originFor(settings);
  const info: WebhookInfo = {
    title: "Policy compliance this week",
    actor: SYSTEM_ACTOR_NAME,
    url: origin ? `${origin}/compliance` : undefined,
    summary,
  };
  await guarded("policy.weekly_summary", async () => {
    await notifyWebhooks("policy.weekly_summary", info);
    return true;
  });
  return { sent: hooks.unscoped, period, summary, skipped: null };
}
