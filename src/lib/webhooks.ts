// Outgoing notification webhooks: post approval-workflow events, and since
// 1.14.0 (H3) the read-confirmation programme's channel notices
// (lib/compliance-webhooks builds those), to chat platforms. Formats: Webex
// incoming webhooks, Microsoft Teams (Workflows / Adaptive Cards), Slack
// incoming webhooks, and a generic JSON envelope for anything else.
// Deliveries are fire-and-forget with a short timeout — a slow or dead
// endpoint never blocks a save — and per-hook delivery status is recorded
// for the admin UI. Server-only.

import "server-only";
import { listWebhooks, markWebhookResult, type Webhook } from "./db";
import { sendMail } from "./mailer";
import { renderEmail } from "./email-templates";

export const WEBHOOK_EVENTS = [
  "change_request.submitted",
  "change_request.approved",
  "change_request.rejected",
  "document.published",
  "suggestion.created",
  "announcement.posted",
  // Read confirmations (H3, 1.14.0): what a #compliance channel hears.
  // Counts and policy titles only, never the names of the people who owe a
  // confirmation (those reach owners and leads through the outbox).
  "policy.requested",
  "policy.deadline_approaching",
  "policy.escalated",
  "policy.weekly_summary",
  "policy.retired",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * Events about the workspace as a whole rather than one space's document:
 * delivered only to hooks with no space filter, since a scoped hook asked
 * for one space's news and a workspace total would leak the others' numbers.
 */
const WORKSPACE_EVENTS: ReadonlySet<WebhookEvent> = new Set<WebhookEvent>(["policy.weekly_summary"]);

export const WEBHOOK_FORMATS = ["webex", "teams", "slack", "generic", "email"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/**
 * The policy a read-confirmation event is about (H3): what the sentence
 * names and what a generic receiver gets verbatim. Counts, never people.
 */
export interface WebhookPolicyInfo {
  id: number;
  title: string;
  /** ISO: the deadline the sentence names (the one a request set, or the one approaching); null when the policy has none. */
  due_at: string | null;
  /** due_at written the workspace's way ("29 Oct 2026"), the same text the Due chips show; null without a date. */
  due_label: string | null;
  counts: { required: number; acked: number; overdue: number };
  /** The number the sentence names: people asked (requested), still to confirm (deadline_approaching) or escalated (escalated). */
  people: number;
  /** deadline_approaching: whole days until due_at in the workspace's zone; escalated: days past due the escalation fires at. */
  days?: number;
  /** requested from an annual re-confirmation cycle (G1). */
  cycle?: "annual";
  /** retired: the policy that replaced it, when one was named. */
  superseded_by?: { id: number; title: string } | null;
}

/** The weekly summary's numbers (H3): the portal's tiles over the live policies, plus the month's evidence hash when one was taken. */
export interface WebhookSummaryInfo {
  /** The ISO week the summary covers ("2026-W43"). */
  week: string;
  pct: number;
  policies: number;
  overdue: number;
  /** The live policy with the lowest compliance; null when nothing is asked. */
  lowest: { id: number; title: string; pct: number } | null;
  /** The monthly compliance snapshot's SHA-256 for this month (F2), anchoring it outside the database; null when none was taken yet. */
  snapshot_sha256: string | null;
  snapshot_period: string | null;
}

export interface WebhookInfo {
  /** Document / change-request title. */
  title: string;
  /** "edit" or "publish" for submissions. */
  kind?: string;
  /** Who triggered the event (author or reviewer name). */
  actor: string;
  /** Optional reviewer note. */
  note?: string;
  /** Absolute link target (review queue or document). */
  url?: string;
  /** Space the document lives in (drives per-space hook filtering). */
  spaceId?: number;
  /** Space name for the message body. */
  spaceName?: string;
  /** A policy event (H3): passed through by the generic envelope; the chat formatters read only the sentence. */
  policy?: WebhookPolicyInfo;
  /** policy.weekly_summary (H3): passed through by the generic envelope. */
  summary?: WebhookSummaryInfo;
}

const EVENT_LABEL: Record<WebhookEvent, { title: string; emoji: string }> = {
  "change_request.submitted": { title: "Change awaiting review", emoji: "📝" },
  "change_request.approved": { title: "Change approved", emoji: "✅" },
  "change_request.rejected": { title: "Change rejected", emoji: "❌" },
  "document.published": { title: "Document published", emoji: "📣" },
  "suggestion.created": { title: "New suggestion", emoji: "💡" },
  "announcement.posted": { title: "Announcement", emoji: "📢" },
  "policy.requested": { title: "Read confirmation requested", emoji: "📋" },
  "policy.deadline_approaching": { title: "Confirmation deadline approaching", emoji: "⏰" },
  "policy.escalated": { title: "Confirmations overdue", emoji: "⚠️" },
  "policy.weekly_summary": { title: "Compliance summary", emoji: "📊" },
  "policy.retired": { title: "Policy retired", emoji: "🗄️" },
};

/** "a week" / "two weeks" / "10 days": how far past due the escalation fires. */
function overdueSpan(days: number): string {
  if (days === 7) return "a week";
  if (days === 14) return "two weeks";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** The policy sentences never name a person; `people` is always a count. */
function describePolicy(event: WebhookEvent, info: WebhookInfo): string {
  const p = info.policy;
  const title = p?.title ?? info.title;
  switch (event) {
    case "policy.requested": {
      const n = p?.people ?? 0;
      if (p?.cycle === "annual") {
        return `Annual re-confirmation of **“${title}”** started: ${n} ${n === 1 ? "person" : "people"} to confirm.`;
      }
      const by = p?.due_label ? ` by ${p.due_label}` : "";
      return `**${info.actor}** asked ${n} ${n === 1 ? "person" : "people"} to confirm **“${title}”**${by}.`;
    }
    case "policy.deadline_approaching": {
      const n = p?.people ?? 0;
      const days = p?.days ?? 0;
      const when = days <= 0 ? "is due today" : days === 1 ? "is due tomorrow" : `is due in ${days} days`;
      return `**“${title}”** ${when}: ${n} ${n === 1 ? "person" : "people"} still to confirm.`;
    }
    case "policy.escalated": {
      const n = p?.people ?? 0;
      return `${n} ${n === 1 ? "person is" : "people are"} more than ${overdueSpan(p?.days ?? 7)} overdue on **“${title}”**.`;
    }
    case "policy.weekly_summary": {
      const s = info.summary;
      if (!s) return `Policy compliance this week.`;
      const lowest = s.lowest ? ` · lowest: ${s.lowest.title} ${s.lowest.pct}%` : "";
      const line = `Policy compliance this week: ${s.pct}% · ${s.overdue} overdue across ${s.policies} ${s.policies === 1 ? "policy" : "policies"}${lowest}.`;
      return s.snapshot_sha256 ? `${line}\n\nMonthly snapshot sha256 ${s.snapshot_sha256.slice(0, 12)}…` : line;
    }
    case "policy.retired": {
      const replaced = p?.superseded_by ? `; replaced by **“${p.superseded_by.title}”**` : "";
      return `**“${title}”** was retired by ${info.actor}${replaced}.`;
    }
    default:
      return "";
  }
}

function describe(event: WebhookEvent, info: WebhookInfo): string {
  switch (event) {
    case "change_request.submitted":
      return `**${info.actor}** submitted ${info.kind === "publish" ? "a publish request" : "an edit"} for **“${info.title}”** — it's waiting in the review queue.`;
    case "change_request.approved":
      return `**${info.actor}** approved the change to **“${info.title}”** — it's now live.`;
    case "change_request.rejected":
      return `**${info.actor}** rejected the change to **“${info.title}”**${info.note ? ` — “${info.note}”` : "."}`;
    case "document.published": {
      const where = info.spaceName ? ` in **${info.spaceName}**` : "";
      return `**${info.actor}** published **“${info.title}”**${where}.`;
    }
    case "suggestion.created":
      return `**${info.actor}** left a suggestion${info.title ? ` on **“${info.title}”**` : ""}${info.note ? `: “${info.note}”` : "."}`;
    case "announcement.posted":
      // note carries the announcement body.
      return `**${info.title}**${info.note ? `\n\n${info.note}` : ""}\n\n— ${info.actor}`;
    case "policy.requested":
    case "policy.deadline_approaching":
    case "policy.escalated":
    case "policy.weekly_summary":
    case "policy.retired":
      return describePolicy(event, info);
  }
}

/** Render the platform-specific request body for one delivery. */
export function buildPayload(format: string, event: WebhookEvent, info: WebhookInfo): unknown {
  const label = EVENT_LABEL[event];
  const md = `${label.emoji} **CompassDocs — ${label.title}**\n\n${describe(event, info)}${info.url ? `\n\n[Open in CompassDocs](${info.url})` : ""}`;

  switch (format) {
    case "webex":
      return { markdown: md };
    case "slack":
      return { text: md.replace(/\*\*/g, "*") };
    case "teams": {
      // Adaptive Card via a Teams Workflows incoming webhook.
      const body: unknown[] = [
        {
          type: "TextBlock",
          text: `${label.emoji} CompassDocs — ${label.title}`,
          weight: "Bolder",
          size: "Medium",
          wrap: true,
        },
        { type: "TextBlock", text: describe(event, info).replace(/\*\*/g, "**"), wrap: true },
      ];
      const card: Record<string, unknown> = {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body,
      };
      if (info.url) {
        card.actions = [{ type: "Action.OpenUrl", title: "Open in CompassDocs", url: info.url }];
      }
      return {
        type: "message",
        attachments: [
          { contentType: "application/vnd.microsoft.card.adaptive", content: card },
        ],
      };
    }
    default:
      // Generic JSON envelope for custom receivers. A policy event (H3)
      // carries its `policy` (and the weekly summary its `summary`) as the
      // emitter built it; the six older events' envelopes are unchanged.
      return {
        source: "compassdocs",
        event,
        title: info.title,
        kind: info.kind ?? null,
        actor: info.actor,
        note: info.note ?? null,
        url: info.url ?? null,
        at: new Date().toISOString(),
        ...(info.policy ? { policy: info.policy } : {}),
        ...(info.summary ? { summary: info.summary } : {}),
      };
  }
}

/**
 * The HTTP transport for JSON deliveries: SSRF-guarded (metadata, link-local,
 * loopback and private ranges refused, every redirect re-validated), eight
 * seconds at most. An object with one method so a test can swap `post` and
 * read what would have been sent (test/ack-webhooks.test.ts); production
 * never touches it.
 */
export const webhookTransport = {
  async post(url: string, body: string): Promise<{ ok: boolean; status: number }> {
    const { safeFetch } = await import("./safe-fetch");
    const res = await safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  },
};

async function deliver(hook: Webhook, event: WebhookEvent, info: WebhookInfo): Promise<void> {
  // "email" channels store a recipient list in the url column and go via SMTP.
  if (hook.format === "email") {
    try {
      const label = EVENT_LABEL[event];
      const plain = describe(event, info).replace(/\*\*/g, "");
      const recipients = hook.url.split(",").map((a) => a.trim()).filter(Boolean);
      const mail = await renderEmail(
        "workflow_event",
        { event: label.title, summary: plain, title: info.title, url: info.url ?? "" },
        ""
      );
      await sendMail(recipients, mail.subject, mail.text, mail.html);
      await markWebhookResult(hook.id, `ok (sent to ${recipients.length})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "send failed";
      await markWebhookResult(hook.id, `failed (${msg.slice(0, 120)})`).catch(() => {});
      console.warn(`[webhooks] ${hook.name || hook.id}:`, msg);
    }
    return;
  }
  try {
    const res = await webhookTransport.post(hook.url, JSON.stringify(buildPayload(hook.format, event, info)));
    await markWebhookResult(hook.id, res.ok ? `ok (${res.status})` : `failed (HTTP ${res.status})`);
    if (!res.ok) console.warn(`[webhooks] ${hook.name || hook.id}: HTTP ${res.status}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "delivery failed";
    await markWebhookResult(hook.id, `failed (${msg.slice(0, 120)})`).catch(() => {});
    console.warn(`[webhooks] ${hook.name || hook.id}:`, msg);
  }
}

/**
 * Send an event to every enabled webhook subscribed to it. Callers should NOT
 * await this in a request path — invoke as `void notifyWebhooks(...)`.
 */
export async function notifyWebhooks(event: WebhookEvent, info: WebhookInfo): Promise<void> {
  let hooks: Webhook[];
  try {
    hooks = await listWebhooks();
  } catch {
    return;
  }
  const targets = hooks.filter((h) => {
    if (h.enabled !== 1 || !(h.events ?? []).includes(event)) return false;
    // Space scoping: an empty list means every space; events without a
    // space (e.g. workspace-level) only skip hooks that ARE scoped. A
    // workspace-wide event (the weekly compliance summary, H3) goes only to
    // hooks with no space filter, whatever space the info names.
    const scoped = h.space_ids ?? [];
    if (scoped.length === 0) return true;
    if (WORKSPACE_EVENTS.has(event)) return false;
    return info.spaceId !== undefined && scoped.includes(info.spaceId);
  });
  await Promise.allSettled(targets.map((h) => deliver(h, event, info)));
}

/** One test delivery for the admin UI's Test button. Returns the outcome. */
export async function testWebhook(hook: Webhook): Promise<string> {
  await deliver(hook, "change_request.submitted", {
    title: "Test notification",
    kind: "edit",
    actor: "CompassDocs",
    note: "",
    url: undefined,
  });
  return (await import("./db").then((m) => m.getWebhook(hook.id)))?.last_status ?? "unknown";
}
