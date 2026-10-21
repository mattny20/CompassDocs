// The neutral periodic orchestrator (F4, 1.14.0): the weekly and monthly
// work that belongs to no one programme, run from the hourly tick of
// src/instrumentation.ts after complianceHourly, under one try/catch tagged
// [periodic]. Each step runs in its own catch, so one failing step never
// stops the others, and each is idempotent across instances: a settings-table
// claim (claimPeriod) or a unique index is the only gate, so every instance
// may run this at once and a week or a month is sent exactly once.
//
// The steps, in order:
//   weeklyTeamDigest           lib/team-digest      claims 'team_digest_week'
//   monthlyComplianceEvidence  lib/compliance-audit claims the month through
//                                                   the snapshots' unique index
//   weeklyComplianceReport     lib/compliance-audit claims 'ack_report_week'
//   weeklyPolicyChannelSummary lib/compliance-webhooks (H3, wave 3)
//                                                   claims 'ack_weekly_hook'
//
// Each module is loaded behind `await import()` inside its step's catch, so
// a module that fails to load only logs ("[periodic] <name>: …") instead of
// taking the tick down. The training sweeps stay in
// trainingHourly (lib/training), which returns before anything when training
// is not licensed; the digest left it in 1.14.0 precisely because a
// policy_ack-only workspace must still get its weekly summary.

import { claimPeriod } from "./db";
import type { TeamDigestOptions } from "./team-digest";

export { claimPeriod };

/** "2026-W31": the ISO week (UTC) a weekly claim is keyed on. */
export function isoWeekId(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** "2026-10": the calendar month (UTC) a monthly claim is keyed on. */
export function monthId(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type PeriodicStep = "team_digest" | "monthly_evidence" | "weekly_report" | "policy_channel_summary";

export const PERIODIC_STEPS: readonly PeriodicStep[] = [
  "team_digest",
  "monthly_evidence",
  "weekly_report",
  "policy_channel_summary",
];

export interface PeriodicOptions {
  /** Run these steps only (tests sharing a database; the tick passes nothing = every step). */
  only?: PeriodicStep[];
  /** Passed through to weeklyTeamDigest (an injected mailer, a period, the leads to consider). */
  digest?: TeamDigestOptions;
  /** A step's body in place of its module (tests: a step that throws proves the next still runs). The tick passes nothing. */
  steps?: Partial<Record<PeriodicStep, () => Promise<unknown>>>;
}

export interface PeriodicResult {
  /** The steps that ran to completion. */
  ran: PeriodicStep[];
  /** The steps that threw, with the message that was logged. */
  failed: { step: PeriodicStep; error: string }[];
}

/**
 * One tick's worth of periodic work. Never throws: every step has its own
 * catch and the result says which ones failed. The order is fixed (the
 * digest first, then the evidence the report summarises, then the report,
 * then the channel summary).
 */
export async function runPeriodic(opts: PeriodicOptions = {}): Promise<PeriodicResult> {
  const only = opts.only ? new Set<PeriodicStep>(opts.only) : null;
  const result: PeriodicResult = { ran: [], failed: [] };
  const step = async (name: PeriodicStep, run: () => Promise<unknown>) => {
    if (only && !only.has(name)) return;
    try {
      await (opts.steps?.[name] ?? run)();
      result.ran.push(name);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      result.failed.push({ step: name, error });
      console.error(`[periodic] ${name}:`, e);
    }
  };

  await step("team_digest", async () => {
    const { weeklyTeamDigest } = await import("./team-digest");
    await weeklyTeamDigest(opts.digest);
  });
  await step("monthly_evidence", async () => {
    const mod = await import("./compliance-audit");
    await mod.monthlyComplianceEvidence();
  });
  await step("weekly_report", async () => {
    const mod = await import("./compliance-audit");
    await mod.weeklyComplianceReport();
  });
  await step("policy_channel_summary", async () => {
    // H3 (1.14.0): the weekly channel summary checks its hooks and the
    // licence before claiming 'ack_weekly_hook', so a week nobody listens
    // to is not burned.
    const mod = await import("./compliance-webhooks");
    await mod.weeklyPolicyChannelSummary();
  });
  return result;
}
