import "server-only";

// Presets that email themselves: every hour the tick looks for a preset
// whose schedule is due, renders it exactly as the Export button would (one
// file, or a zip per office), and sends it to the recipients as an
// attachment. One instance runs it; a run is recorded per preset so a
// restart in the same period does not send twice.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSetting, pool, setSetting } from "./db";
import { listFields, listPeople } from "./directory";
import { listExportPresets } from "./directory-export-config";
import { describeSchedule, isExportDue } from "./directory-export-schedule-rules";
import { renderExportFile } from "./directory-export-run";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";
import { getAppSettings } from "./settings-store";

const LAST_KEY = "directory_export_schedule_last";
const ADVISORY_LOCK = 728343;

export type ExportRunLog = Record<string, { at: string; ok: boolean; detail?: string }>;

export async function getExportRunLog(): Promise<ExportRunLog> {
  try {
    const raw = await getSetting(LAST_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Send every preset whose schedule is due. Never throws; each preset is on its own. */
export async function runScheduledDirectoryExports(now: Date = new Date()): Promise<string[]> {
  const sent: string[] = [];
  const presets = (await listExportPresets()).filter((p) => p.schedule.frequency !== "off" && p.schedule.recipients.length);
  if (!presets.length) return sent;
  const log = await getExportRunLog();
  const due = presets.filter((p) => isExportDue(p.schedule, log[p.id]?.at, now));
  if (!due.length) return sent;

  const client = await pool().connect();
  try {
    const got = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [ADVISORY_LOCK]);
    if (!got.rows[0].ok) return sent;
    try {
      const smtp = await getSmtpConfig();
      const [fields, people, settings, domain] = await Promise.all([listFields(), listPeople(), getAppSettings(), getSetting("custom_domain")]);
      const company = settings.company_name || "CompassDocs";
      const origin = domain?.trim() ? `https://${domain.trim()}` : "";
      for (const preset of due) {
        let ok = true;
        let detail = "";
        try {
          if (!smtpConfigured(smtp)) throw new Error("SMTP is not configured (Settings → Notifications).");
          const file = await renderExportFile({ preset, format: preset.schedule.format, people, fields });
          const tmp = path.join(os.tmpdir(), `compassdocs-export-${preset.id}-${Date.now()}-${file.filename}`);
          await fs.writeFile(tmp, file.body);
          try {
            const when = describeSchedule(preset.schedule).replace(/^Every |^On the /, "");
            const subject = `${preset.title || `${company} directory`} — ${preset.name}`;
            const text = [
              `Attached: ${file.filename}${file.parts > 1 ? ` (${file.parts} files)` : ""}, the "${preset.name}" directory export, sent ${when.toLowerCase()}.`,
              `${people.filter((p) => !p.hidden).length} people in the directory.`,
              origin ? `Change the schedule under ${origin}/admin/directory/export.` : "",
            ].filter(Boolean).join("\n\n");
            await sendMail(preset.schedule.recipients, subject, text, undefined, undefined, [{ filename: file.filename, path: tmp }]);
          } finally {
            await fs.unlink(tmp).catch(() => {});
          }
          detail = `${file.filename} to ${preset.schedule.recipients.length} ${preset.schedule.recipients.length === 1 ? "recipient" : "recipients"}`;
          sent.push(preset.id);
        } catch (e) {
          ok = false;
          detail = e instanceof Error ? e.message : String(e);
          console.error(`[directory] scheduled export "${preset.name}" failed:`, e);
        }
        log[preset.id] = { at: now.toISOString(), ok, detail };
        await setSetting(LAST_KEY, JSON.stringify(log));
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
  return sent;
}
