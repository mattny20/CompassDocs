// Training decks (enterprise "training" entitlement). A published document
// becomes a slide deck: slides split on `---` lines, and an optional
// `:::compliance` block at the end supplies the wording for the final
// confirmation gate. Assignment, progress, and completion live in db.ts;
// this module owns slide parsing and the notification/reminder flows.

import {
  claimTrainingReminders,
  getNotifyPrefsFor,
  listUsers,
} from "@/lib/db";
import { notify, notifyPrefAllows } from "@/lib/notifications";
import { renderEmail } from "@/lib/email-templates";
import { sendMail } from "@/lib/mailer";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { getAppSettings } from "@/lib/settings-store";
import { featureEnabled } from "@/lib/ee";
import { formatDate } from "@/lib/format";

export interface DeckSlides {
  slides: string[];
  /** Markdown body of the trailing :::compliance block, or null for the default wording. */
  complianceText: string | null;
}

const DEFAULT_COMPLIANCE =
  "I confirm that I have completed this training and understood the material.";

export function defaultComplianceText(): string {
  return DEFAULT_COMPLIANCE;
}

/**
 * Split deck content into slides on `---` lines, ignoring `---` inside
 * fenced code blocks, and extract a trailing :::compliance block. Pure.
 */
export function splitSlides(content: string): DeckSlides {
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  // Walk once, tracking code-fence state so a `---` inside ``` or ~~~ fences
  // (or a compliance marker pasted into a code sample) never splits a slide.
  const slides: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let compliance: string[] | null = null;
  let inCompliance = false;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const mark = fenceMatch[1][0].repeat(3);
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
    }

    if (!fence && !inCompliance && /^:::compliance\s*$/.test(line.trim())) {
      inCompliance = true;
      compliance = [];
      continue;
    }
    if (inCompliance) {
      if (/^:::\s*$/.test(line.trim())) {
        inCompliance = false;
        continue;
      }
      compliance!.push(line);
      continue;
    }

    if (!fence && /^\s*---+\s*$/.test(line) && !/^\s*----/.test(line)) {
      slides.push(current.join("\n").trim());
      current = [];
      continue;
    }
    current.push(line);
  }
  slides.push(current.join("\n").trim());

  const nonEmpty = slides.filter((s) => s.length > 0);
  return {
    slides: nonEmpty.length ? nonEmpty : [""],
    complianceText: compliance ? compliance.join("\n").trim() || null : null,
  };
}

export function slideCount(content: string): number {
  return splitSlides(content).slides.length;
}

/** In-app + (pref-gated) email fan-out when a deck is assigned. */
export async function notifyTrainingAssigned(input: {
  userIds: number[];
  deckTitle: string;
  dueAt: string | null;
  assignerName: string;
  origin: string;
}): Promise<void> {
  if (!input.userIds.length) return;
  const settings = await getAppSettings();
  void notify(input.userIds, {
    kind: "training_assigned",
    title: `Training assigned: ${input.deckTitle}`,
    body: input.dueAt ? `Due by ${formatDate(input.dueAt, settings)}.` : "",
    link: "/training",
    actorName: input.assignerName,
  });

  const smtp = await getSmtpConfig();
  if (!smtpConfigured(smtp)) return;
  const users = (await listUsers()).filter(
    (u) => input.userIds.includes(u.id) && u.email && u.status === "active"
  );
  if (!users.length) return;
  const prefs = await getNotifyPrefsFor(users.map((u) => u.id));
  const origin = input.origin || (settings.custom_domain ? `https://${settings.custom_domain}` : "");
  const { subject, text, html } = await renderEmail(
    "training_assigned",
    {
      assigner_name: input.assignerName,
      deck_title: input.deckTitle,
      due_line: input.dueAt ? ` It's due by ${formatDate(input.dueAt, settings)}.` : "",
      training_url: `${origin}/training`,
    },
    origin
  );
  for (const u of users) {
    if (!notifyPrefAllows(prefs.get(u.id), "training_assigned", "email")) continue;
    await sendMail([u.email], subject, text, html).catch(() => {});
  }
}

/**
 * Hourly sweep entry (instrumentation.ts): remind assignees whose training
 * is due within 3 days or overdue — at most once per 3 days per assignment,
 * claimed atomically so restarts can't double-send.
 */
export async function remindDueTraining(): Promise<void> {
  if (!(await featureEnabled("training"))) return;
  const due = await claimTrainingReminders();
  if (!due.length) return;

  const settings = await getAppSettings();
  const origin = settings.custom_domain ? `https://${settings.custom_domain}` : "";

  for (const r of due) {
    void notify([r.user_id], {
      kind: "training_due",
      title: `Training due: ${r.title}`,
      body: `Due by ${formatDate(r.due_at, settings)}.`,
      link: "/training",
    });
  }

  const smtp = await getSmtpConfig();
  if (!smtpConfigured(smtp)) return;
  for (const r of due) {
    if (!r.email) continue;
    if (!notifyPrefAllows(r.notify_prefs, "training_due", "email")) continue;
    const { subject, text, html } = await renderEmail(
      "training_due",
      {
        deck_title: r.title,
        due_date: formatDate(r.due_at, settings),
        training_url: `${origin}/training`,
      },
      origin
    );
    await sendMail([r.email], subject, text, html).catch(() => {});
  }
}
