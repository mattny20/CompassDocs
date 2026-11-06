// Helpdesk 1.19.0, machine intake (agent P): automated email senders.
// lib/helpdesk/inbound asks this first, after its own loop guard: when the
// From address is listed on an enabled email integration, the mail is an
// alert even though it looks auto-generated (that is what monitoring mail
// is), and it goes through the intake (subject = title, the subject pattern
// = dedup key, [RESOLVED]-style tags = resolution). Everything else returns
// null and the inbound rules apply as before.
//
// A From header is easy to forge, so the mail provider's own verdict must
// show the From domain authenticated (DMARC pass, or SPF / DKIM pass
// aligned with it; lib/helpdesk/intake/email-rules authVerdict). A failing
// verdict is refused; so is mail with no verdict at all, unless the
// integration's "Accept mail without SPF or DKIM results" is on. Refusals
// are logged, audited, and shown in the deliveries log (once a minute per
// reason, so a flood cannot push real deliveries out). Server-only.

import "server-only";
import { logEvent } from "../../log";
import { cleanSubject, htmlToText, type InboundEmail } from "../inbound-parse";
import { emailIntegrationsFor, recordDelivery } from "./integrations";
import { auditRejection, intakeLimited, processAlerts } from "./intake";
import { emailAuthVerdict, emailDedupKey, emailStatus } from "./email-rules";

export interface MachineMailResult {
  status: number;
  body: { ok: boolean; outcome: "alert_created" | "alert_updated" | "alert_reopened" | "alert_resolved" | "alert_ignored" | "alert_rejected"; ticket?: number; error?: string };
}

/** Null when the sender is not an automated sender of any enabled email integration. */
export async function intakeFromEmail(email: InboundEmail, opts: { origin?: string; ip?: string | null } = {}): Promise<MachineMailResult | null> {
  const from = email.from.email.toLowerCase();
  const matches = await emailIntegrationsFor(from);
  if (!matches.length) return null;
  const integration = matches[0];

  const verdict = emailAuthVerdict(email);
  const accepted = verdict.ok || (verdict.state === "none" && integration.allow_unverified_mail === 1);
  if (!accepted) {
    logEvent("warn", "helpdesk.intake_rejected", { reason: "email_auth", integration: integration.id, from, verdict: verdict.reason });
    if (!intakeLimited(`delivery-reject:${integration.id}:email_auth:${verdict.state}`, 1)) {
      await recordDelivery({ integration_id: integration.id, status_code: 200, outcome: "rejected", reason: `Sender check failed (${verdict.reason}).` });
    }
    await auditRejection(integration, integration.id, "email_auth", { from, verdict: verdict.reason, state: verdict.state, provider: email.provider }, opts.ip ?? null);
    return { status: 200, body: { ok: true, outcome: "alert_rejected" } };
  }
  if (intakeLimited(`intake:${integration.id}`, integration.rate_limit_per_minute)) {
    if (!intakeLimited(`delivery-reject:${integration.id}:rate_limited`, 1)) {
      await recordDelivery({ integration_id: integration.id, status_code: 429, outcome: "rejected", reason: "Rate limit reached." });
    }
    return { status: 429, body: { ok: false, outcome: "alert_rejected", error: "Too many messages. Try again shortly." } };
  }

  const subject = email.subject.slice(0, 500);
  const text = email.text.trim() ? email.text : email.html.trim() ? htmlToText(email.html) : "";
  const r = await processAlerts(
    integration,
    [
      {
        title: cleanSubject(subject) || "(no subject)",
        description: text,
        description_format: "plain",
        severity: "",
        status: emailStatus(subject),
        dedup_key: emailDedupKey(subject, integration.subject_dedup_pattern),
        source: from,
        links: [],
        fields: { From: from, ...(email.messageId ? { "Message-ID": email.messageId.slice(0, 300) } : {}) },
      },
    ],
    // A provider's retry carries the same Message-ID.
    { requestKeys: email.messageId ? [`m:${email.messageId.slice(0, 300)}`] : undefined, origin: opts.origin, ip: opts.ip ?? null }
  );
  const outcome = r.body.outcome ?? "ignored";
  return {
    status: r.status,
    body: { ok: r.body.ok, outcome: r.body.duplicate ? "alert_ignored" : (`alert_${outcome}` as MachineMailResult["body"]["outcome"]), ...(r.body.ticket ? { ticket: r.body.ticket } : {}) },
  };
}
