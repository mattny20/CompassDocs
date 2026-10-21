import "server-only";
import { claimPeriod, getSetting, setSetting, listTrainingDigestLeads, teamTrainingRows, teamPolicyRows } from "./db";
import type { TeamPolicyRow, TeamTrainingRow } from "./db";
import { renderEmail } from "./email-templates";
import { sendMail } from "./mailer";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { getAppSettings } from "./settings-store";
import { featureEnabled } from "./ee";
import { formatDate } from "./format";
import { getComplianceSettings } from "./compliance-settings";
import { recordNotices } from "./compliance";
import type { Mailer } from "./compliance";
import { isoWeekId } from "./periodic";

// The weekly team digest for group leads (F4, 1.14.0). Moved here from
// lib/training so a workspace licensed for read confirmations alone still
// gets it: trainingHourly returns before anything when training is not
// licensed, and the neutral orchestrator (lib/periodic) calls this instead,
// from the hourly tick.
//
// One email per lead (template training_team_digest, so an override saved
// before 1.14.0 survives; it must add {{policy_summary}} to show the new
// section): a Training section when training is licensed, a Policies
// section when policy_ack is licensed and Program settings let leads see
// policy standing (ack_defaults.leads_see_policies). Each section is the
// lead's groups within the lead's own space scope (teamTrainingRows,
// teamPolicyRows): a lead of a broad group reads a count, never a
// private-space title. Claimed once per ISO week (UTC) through the settings
// table (claimPeriod 'team_digest_week'), AFTER the checks that could make
// the tick send nothing (a licence, leads with email, SMTP), so a week is
// never burnt by a tick that had nothing to send; the claim is the only
// gate, so every instance may run this at once. 1.13.0's trainingHourly
// claimed the same week under 'training_team_digest_week': that key is read
// before the claim (a week it holds was sent by the old sweep, so the
// upgrade week goes out once) and written after a won one (a 1.13.0
// instance still running beside this one, or restored by a rollback, finds
// its own key taken). Each digest that carried the Policies section writes
// one ack_notices row per lead (kind 'digest').

/** The settings-table key the weekly claim is stored under. */
export const TEAM_DIGEST_CLAIM_KEY = "team_digest_week";
/** The key 1.13.0's training sweep claimed the same week under: read before the claim, written after a won one. */
export const LEGACY_TEAM_DIGEST_CLAIM_KEY = "training_team_digest_week";
/** How many overdue people the Policies section names after the group lines. */
export const DIGEST_MOST_OVERDUE = 3;
/** A digest names no policy (its notice row carries a NULL document_id). */
const DIGEST_DOCUMENT_TITLE = "Weekly team digest";

const DAY = 86_400_000;

export interface TeamDigestOptions {
  /** Omit for the SMTP settings; null for no mail at all (nothing is sent and the week is not claimed); a function to inject one (tests). */
  mailer?: Mailer | null;
  /** Only these leads (tests sharing a database; the tick passes nothing = every lead). */
  leadIds?: number[];
  /** The claim's period; isoWeekId(now) when absent. */
  period?: string;
  now?: Date;
}

export type TeamDigestSkip = "unlicensed" | "nothing_to_say" | "no_leads" | "no_smtp" | "claimed";

export interface TeamDigestResult {
  /** Mails the server accepted. */
  sent: number;
  /** Leads considered (with an email, in `leadIds` when given). */
  leads: number;
  period: string;
  sections: { training: boolean; policies: boolean };
  /** Why nothing was sent, or null when the digest ran. */
  skipped: TeamDigestSkip | null;
}

// --- The numbers behind the lines (shared with GET /api/compliance/team) -------

export interface TeamGroupSummary {
  id: number;
  name: string;
  /** Active members of the group. */
  members: number;
  /** Rows with a current confirmation. */
  confirmed: number;
  /** Rows still to confirm: pending and overdue. Exempt rows count nowhere. */
  open: number;
  overdue: number;
}

/**
 * Per group, the counts the team page's header and the digest line carry,
 * from teamPolicyRows' rows (a member with nothing to confirm counts as a
 * member and nothing else; an exempt row counts as a member only). Groups
 * with no rows at all (no active members) still appear with zeros.
 */
export function teamGroupSummaries(groups: { id: number; name: string }[], rows: TeamPolicyRow[]): TeamGroupSummary[] {
  const by = new Map<number, TeamGroupSummary & { seen: Set<number> }>();
  for (const g of groups) by.set(g.id, { id: g.id, name: g.name, members: 0, confirmed: 0, open: 0, overdue: 0, seen: new Set() });
  for (const r of rows) {
    const g = by.get(r.group_id);
    if (!g) continue;
    if (!g.seen.has(r.user_id)) {
      g.seen.add(r.user_id);
      g.members += 1;
    }
    if (r.assignment_id === null) continue;
    if (r.status === "confirmed") g.confirmed += 1;
    else if (r.status === "pending") g.open += 1;
    else if (r.status === "overdue") {
      g.open += 1;
      g.overdue += 1;
    }
  }
  return [...by.values()].map(({ seen: _seen, ...g }) => g);
}

/** "Ana Ruiz was reminded 3 days ago." (the route's 429 inside the cadence). */
export function remindedAgoSentence(name: string, days: number): string {
  if (days <= 0) return `${name} was reminded earlier today.`;
  return `${name} was reminded ${days} ${days === 1 ? "day" : "days"} ago.`;
}

/** Whole days since `iso`, never negative. */
export function daysSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY));
}

// --- The sections ------------------------------------------------------------

/**
 * The Training section's lines, as 1.13.0's digest wrote them: one per
 * group, "- **Support**: 14 done · 3 open · **2 overdue**" (the overdue
 * part only when there is one). Pure.
 */
export function trainingSummaryLines(rows: TeamTrainingRow[], now = Date.now()): string {
  const byGroup = new Map<string, { open: number; overdue: number; done: number }>();
  for (const r of rows) {
    const g = byGroup.get(r.group_name) ?? { open: 0, overdue: 0, done: 0 };
    if (r.deck) {
      if (r.completed_at) g.done += 1;
      else {
        g.open += 1;
        if (r.due_at && new Date(r.due_at).getTime() < now) g.overdue += 1;
      }
    }
    byGroup.set(r.group_name, g);
  }
  const lines = [...byGroup.entries()].map(
    ([name, g]) => `- **${name}**: ${g.done} done · ${g.open} open${g.overdue ? ` · **${g.overdue} overdue**` : ""}`
  );
  return lines.join("\n") || "- No training activity this week.";
}

/**
 * The Policies section: a heading, one line per group ("- **Engineering**:
 * 38 confirmed · 6 open · **2 overdue**", the overdue part only when there
 * is one), then the three most overdue people within the lead's scope
 * ("- Ana Ruiz · Code of conduct · due 3 Oct 2026"). A member in two led
 * groups is counted in each but named once. Pure; `fmtDate` is the
 * workspace's date format.
 */
export function policySummaryLines(
  groups: { id: number; name: string }[],
  rows: TeamPolicyRow[],
  fmtDate: (iso: string) => string
): string {
  const lines: string[] = ["**Policies**"];
  const summaries = teamGroupSummaries(groups, rows);
  if (summaries.length === 0) lines.push("- No policies to confirm.");
  for (const g of summaries) {
    lines.push(`- **${g.name}**: ${g.confirmed} confirmed · ${g.open} open${g.overdue ? ` · **${g.overdue} overdue**` : ""}`);
  }
  const seen = new Set<number>();
  const overdue = rows
    .filter((r) => r.status === "overdue" && r.assignment_id !== null)
    .filter((r) => (seen.has(r.assignment_id!) ? false : (seen.add(r.assignment_id!), true)))
    .sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""))
    .slice(0, DIGEST_MOST_OVERDUE);
  if (overdue.length) {
    lines.push("", "Most overdue:");
    for (const r of overdue) lines.push(`- ${r.user_name} · ${r.title} · due ${r.due_at ? fmtDate(r.due_at) : "no date"}`);
  }
  return lines.join("\n");
}

// --- The sweep ---------------------------------------------------------------

async function defaultMailer(): Promise<Mailer | null> {
  return smtpConfigured(await getSmtpConfig()) ? sendMail : null;
}

/**
 * The weekly sweep (lib/periodic runPeriodic): one email per lead with the
 * sections the licences and the setting allow, claimed once per ISO week
 * after every check that could leave nothing to send. Never throws for one
 * lead's sake: a mail the server refused is counted out of `sent` and the
 * loop goes on.
 */
export async function weeklyTeamDigest(opts: TeamDigestOptions = {}): Promise<TeamDigestResult> {
  const now = opts.now ?? new Date();
  const period = opts.period ?? isoWeekId(now);
  const skip = (skipped: TeamDigestSkip, sections = { training: false, policies: false }, leads = 0): TeamDigestResult => ({
    sent: 0,
    leads,
    period,
    sections,
    skipped,
  });

  const [training, policyAck] = await Promise.all([featureEnabled("training"), featureEnabled("policy_ack")]);
  if (!training && !policyAck) return skip("unlicensed");
  const policies = policyAck && (await getComplianceSettings()).ack_defaults.leads_see_policies;
  const sections = { training, policies };
  if (!training && !policies) return skip("nothing_to_say", sections);

  const wanted = opts.leadIds ? new Set(opts.leadIds) : null;
  const leads = (await listTrainingDigestLeads()).filter((l) => !wanted || wanted.has(l.user_id));
  if (!leads.length) return skip("no_leads", sections);

  // SMTP before the claim: a tick that can send nothing must not burn the week.
  const mailer = opts.mailer === undefined ? await defaultMailer() : opts.mailer;
  if (!mailer) return skip("no_smtp", sections, leads.length);
  // A week 1.13.0's sweep already sent (its key still holds the period
  // after the upgrade) is not sent again.
  if ((await getSetting(LEGACY_TEAM_DIGEST_CLAIM_KEY)) === period) return skip("claimed", sections, leads.length);
  if (!(await claimPeriod(TEAM_DIGEST_CLAIM_KEY, period))) return skip("claimed", sections, leads.length);
  // And a 1.13.0 instance (a rolling deploy, a rollback) finds the week
  // taken under the key it reads.
  await setSetting(LEGACY_TEAM_DIGEST_CLAIM_KEY, period);

  const settings = await getAppSettings();
  const origin = settings.custom_domain ? `https://${settings.custom_domain}` : "";
  const fmtDate = (iso: string) => formatDate(iso, settings);
  // The policies page is the one the digest's newest section describes; a
  // training-only workspace keeps its 1.13.0 link.
  const teamUrl = `${origin}${policies ? "/compliance/team" : "/training/team"}`;

  let sent = 0;
  for (const lead of leads) {
    const groups = lead.group_ids;
    let summary = "";
    let policySummary = "";
    if (training) {
      summary = trainingSummaryLines(await teamTrainingRows(groups), now.getTime());
      // Headed only beside a Policies section: a training-only digest reads as it did.
      if (policies) summary = `**Training**\n${summary}`;
    }
    if (policies) {
      const rows = await teamPolicyRows(groups, lead.user_id);
      const named = new Map<number, string>();
      for (const r of rows) named.set(r.group_id, r.group_name);
      policySummary = policySummaryLines(
        groups.map((id) => ({ id, name: named.get(id) ?? `Group ${id}` })),
        rows,
        fmtDate
      );
    }
    const { subject, text, html } = await renderEmail(
      "training_team_digest",
      {
        lead_name: lead.name,
        summary,
        policy_summary: policySummary,
        team_url: teamUrl,
        org_name: settings.company_name,
      },
      origin
    );
    const accepted = await mailer([lead.email], subject, text, html).then(
      () => true,
      () => false
    );
    if (!accepted) continue;
    sent += 1;
    if (policies) {
      await recordNotices([
        {
          user_id: lead.user_id,
          user_name: lead.name,
          user_email: lead.email,
          document_id: null,
          document_title: DIGEST_DOCUMENT_TITLE,
          kind: "digest",
          channels: ["email"],
          by_user_id: null,
          by_name: "system",
        },
      ]).catch((e) => console.error("[periodic] team_digest notice record:", e));
    }
  }
  return { sent, leads: leads.length, period, sections, skipped: null };
}
