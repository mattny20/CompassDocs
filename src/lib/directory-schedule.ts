import "server-only";

// Scheduled directory syncs and their report.
//
// The sync itself lives in the enterprise overlay; core owns WHEN it runs
// and WHO hears about it. A schedule per provider (off / hourly / daily at
// an hour), checked from the hourly instrumentation tick under an advisory
// lock so one instance runs it; after each scheduled run an email goes to
// the configured recipients with what changed, what could not be resolved,
// and whether the brake held anything back — the same facts the Sync page
// shows, delivered instead of waited for.

import { getSetting, setSetting, pool } from "./db";
import { ee, featureEnabled } from "./ee";
import { sendMail } from "./mailer";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import type { DirectorySyncProvider, DirectorySyncSummary } from "@/ee-contract";
import { getSyncReport } from "./directory";
import { SYNC_FREQUENCIES, isSyncDue, parseRecipients, syncReportEmail, type SyncFrequency, type SyncSchedule } from "./directory-schedule-rules";

export { SYNC_FREQUENCIES, isSyncDue, parseRecipients, syncReportEmail };
export type { SyncFrequency, SyncSchedule };

const KEYS = {
  microsoft: "directory_sync_schedule_microsoft",
  google: "directory_sync_schedule_google",
  hour: "directory_sync_schedule_hour",
  report_to: "directory_sync_report_to",
  report_quiet: "directory_sync_report_quiet",
  last: "directory_sync_scheduled_last",
} as const;

const ADVISORY_LOCK = 728342;
const PROVIDERS: DirectorySyncProvider[] = ["microsoft", "google"];

function freq(v: string | null | undefined): SyncFrequency {
  return (SYNC_FREQUENCIES as readonly string[]).includes(String(v)) ? (v as SyncFrequency) : "off";
}

export async function getSyncSchedule(): Promise<SyncSchedule> {
  const [m, g, h, to, quiet, last] = await Promise.all([
    getSetting(KEYS.microsoft), getSetting(KEYS.google), getSetting(KEYS.hour), getSetting(KEYS.report_to), getSetting(KEYS.report_quiet), getSetting(KEYS.last),
  ]);
  let parsedLast: SyncSchedule["last"] = {};
  try {
    parsedLast = last ? JSON.parse(last) : {};
  } catch {}
  const hour = Number(h);
  return {
    microsoft: freq(m),
    google: freq(g),
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3,
    report_to: parseRecipients(to ?? ""),
    report_quiet: quiet === "1",
    last: parsedLast,
  };
}

export async function saveSyncSchedule(patch: Partial<Pick<SyncSchedule, "microsoft" | "google" | "hour" | "report_quiet">> & { report_to?: string | string[] }): Promise<SyncSchedule> {
  if (patch.microsoft !== undefined) await setSetting(KEYS.microsoft, freq(patch.microsoft));
  if (patch.google !== undefined) await setSetting(KEYS.google, freq(patch.google));
  if (patch.hour !== undefined) {
    const h = Number(patch.hour);
    await setSetting(KEYS.hour, String(Number.isInteger(h) && h >= 0 && h <= 23 ? h : 3));
  }
  if (patch.report_to !== undefined) {
    await setSetting(KEYS.report_to, parseRecipients(Array.isArray(patch.report_to) ? patch.report_to.join(",") : patch.report_to).join(","));
  }
  if (patch.report_quiet !== undefined) await setSetting(KEYS.report_quiet, patch.report_quiet ? "1" : "0");
  return getSyncSchedule();
}

/**
 * Run every scheduled sync that is due. Called hourly; one instance at a
 * time; each provider independently. Never throws — a failed provider is
 * recorded, reported and left for the next hour.
 */
export async function runScheduledDirectorySyncs(now: Date = new Date()): Promise<DirectorySyncProvider[]> {
  const ran: DirectorySyncProvider[] = [];
  const edition = ee();
  if (!edition.present || !edition.runDirectorySync) return ran;
  if (!(await featureEnabled("directory_sync"))) return ran;
  const schedule = await getSyncSchedule();
  if (schedule.microsoft === "off" && schedule.google === "off") return ran;

  const client = await pool().connect();
  try {
    const got = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [ADVISORY_LOCK]);
    if (!got.rows[0].ok) return ran;
    try {
      const domain = (await getSetting("custom_domain"))?.trim();
      const origin = domain ? `https://${domain}` : "";
      for (const provider of PROVIDERS) {
        if (!isSyncDue(schedule[provider], schedule.hour, schedule.last[provider]?.at, now)) continue;
        let summary: DirectorySyncSummary | undefined;
        let error: string | undefined;
        try {
          summary = await edition.runDirectorySync(provider, { allowRemovals: false });
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        const ok = !error;
        const p = summary?.preview;
        const quiet = ok && p && p.adds.length === 0 && p.changes.length === 0 && p.removals.length === 0 && p.adoptions.length === 0 && !summary?.blocked && !summary?.warning;
        schedule.last[provider] = {
          at: now.toISOString(),
          ok,
          summary: ok ? `${summary?.count ?? 0} people${p ? `, +${p.adds.length} ~${p.changes.length} −${summary?.deleted ?? 0}` : ""}` : error,
        };
        await setSetting(KEYS.last, JSON.stringify(schedule.last));
        ran.push(provider);
        if (schedule.report_to.length && (!quiet || schedule.report_quiet)) {
          try {
            const cfg = await getSmtpConfig();
            if (smtpConfigured(cfg)) {
              const report = await getSyncReport(provider === "microsoft" ? "graph" : "google");
              const mail = syncReportEmail({ provider, ok, error, summary, unresolved: report?.unresolved, adopted: report?.adopted, origin, at: now });
              await sendMail(schedule.report_to, mail.subject, mail.text, mail.html);
            }
          } catch (e) {
            console.error(`[directory] sync report email failed:`, e);
          }
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
  return ran;
}
