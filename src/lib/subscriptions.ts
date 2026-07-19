// Subscriber emails: when a document is published or updated in a space,
// everyone subscribed to that space (directly, or via an admin-assigned
// group) gets a short email. Fire-and-forget — called with `void` from the
// write paths, silently a no-op when SMTP isn't configured. Server-only.

import "server-only";
import { listSubscriberRecipients } from "./db";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";
import { renderEmail } from "./email-templates";

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
    const origin = ev.origin ?? "";
    const { subject, text, html } = await renderEmail(
      "doc_update",
      {
        doc_title: ev.title,
        space_name: ev.spaceName,
        actor_name: ev.actorName,
        action: verb,
        doc_url: `${origin}/doc/${ev.docId}`,
        manage_url: `${origin}/account/notifications`,
      },
      origin
    );

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
