// Outgoing notification webhooks: post approval-workflow events to chat
// platforms. Formats: Webex incoming webhooks, Microsoft Teams (Workflows /
// Adaptive Cards), Slack incoming webhooks, and a generic JSON envelope for
// anything else. Deliveries are fire-and-forget with a short timeout — a slow
// or dead endpoint never blocks a save — and per-hook delivery status is
// recorded for the admin UI. Server-only.

import "server-only";
import { listWebhooks, markWebhookResult, type Webhook } from "./db";

export const WEBHOOK_EVENTS = [
  "change_request.submitted",
  "change_request.approved",
  "change_request.rejected",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_FORMATS = ["webex", "teams", "slack", "generic"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

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
}

const EVENT_LABEL: Record<WebhookEvent, { title: string; emoji: string }> = {
  "change_request.submitted": { title: "Change awaiting review", emoji: "📝" },
  "change_request.approved": { title: "Change approved", emoji: "✅" },
  "change_request.rejected": { title: "Change rejected", emoji: "❌" },
};

function describe(event: WebhookEvent, info: WebhookInfo): string {
  switch (event) {
    case "change_request.submitted":
      return `**${info.actor}** submitted ${info.kind === "publish" ? "a publish request" : "an edit"} for **“${info.title}”** — it's waiting in the review queue.`;
    case "change_request.approved":
      return `**${info.actor}** approved the change to **“${info.title}”** — it's now live.`;
    case "change_request.rejected":
      return `**${info.actor}** rejected the change to **“${info.title}”**${info.note ? ` — “${info.note}”` : "."}`;
  }
}

/** Render the platform-specific request body for one delivery. */
export function buildPayload(format: string, event: WebhookEvent, info: WebhookInfo): unknown {
  const label = EVENT_LABEL[event];
  const md = `${label.emoji} **CompassDocs — ${label.title}**\n\n${describe(event, info)}${info.url ? `\n\n[Open review queue](${info.url})` : ""}`;

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
        card.actions = [{ type: "Action.OpenUrl", title: "Open review queue", url: info.url }];
      }
      return {
        type: "message",
        attachments: [
          { contentType: "application/vnd.microsoft.card.adaptive", content: card },
        ],
      };
    }
    default:
      // Generic JSON envelope for custom receivers.
      return {
        source: "compassdocs",
        event,
        title: info.title,
        kind: info.kind ?? null,
        actor: info.actor,
        note: info.note ?? null,
        url: info.url ?? null,
        at: new Date().toISOString(),
      };
  }
}

async function deliver(hook: Webhook, event: WebhookEvent, info: WebhookInfo): Promise<void> {
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPayload(hook.format, event, info)),
      signal: AbortSignal.timeout(8000),
    });
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
  const targets = hooks.filter((h) => h.enabled === 1 && (h.events ?? []).includes(event));
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
