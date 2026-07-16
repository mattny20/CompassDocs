// Subscriber emails: when a document is published or updated in a space,
// everyone subscribed to that space (directly, or via an admin-assigned
// group) gets a short email. Fire-and-forget — called with `void` from the
// write paths, silently a no-op when SMTP isn't configured. Server-only.

import "server-only";
import { listSubscriberRecipients } from "./db";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";

const MAX_RECIPIENTS = 200;

export interface SubscriberEvent {
  spaceId: number;
  spaceName: string;
  docId: number;
  title: string;
  kind: "published" | "updated";
  actorUserId: number;
  actorName: string;
  /** Absolute origin (https://host) for links; empty = relative link text. */
  origin?: string;
}

export async function notifySpaceSubscribers(ev: SubscriberEvent): Promise<void> {
  try {
    if (!smtpConfigured(await getSmtpConfig())) return;
    const recipients = (await listSubscriberRecipients(ev.spaceId, ev.actorUserId)).slice(
      0,
      MAX_RECIPIENTS
    );
    if (recipients.length === 0) return;

    const verb = ev.kind === "published" ? "published" : "updated";
    const url = `${ev.origin ?? ""}/doc/${ev.docId}`;
    const subject = `[${ev.spaceName}] ${ev.title} was ${verb}`;
    const text =
      `"${ev.title}" was ${verb} in ${ev.spaceName} by ${ev.actorName}.\n\n` +
      `Read it: ${url}\n\n` +
      `You're getting this because you subscribe to the ${ev.spaceName} space. ` +
      `Manage subscriptions: ${ev.origin ?? ""}/account/notifications`;
    const html =
      `<p><strong>${escapeHtml(ev.title)}</strong> was ${verb} in ` +
      `<strong>${escapeHtml(ev.spaceName)}</strong> by ${escapeHtml(ev.actorName)}.</p>` +
      `<p><a href="${url}">Read the document</a></p>` +
      `<p style="color:#64748b;font-size:13px">You subscribe to the ${escapeHtml(ev.spaceName)} space · ` +
      `<a href="${ev.origin ?? ""}/account/notifications">manage subscriptions</a></p>`;

    // Individual sends (no shared To/CC): fine at this scale, keeps addresses private.
    for (const r of recipients) {
      try {
        await sendMail([r.email], subject, text, html);
      } catch (e) {
        console.error(`Subscriber email to ${r.email} failed:`, e);
      }
    }
  } catch (e) {
    console.error("notifySpaceSubscribers failed:", e);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
