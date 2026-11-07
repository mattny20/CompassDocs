// Helpdesk 1.19.4 (area C2): API tokens and outgoing webhooks, client-safe.
// The names, labels, limits and view shapes Desk settings → API and webhooks
// and the server share. No server imports.

import type { HdRole } from "./roles-shared";

/** The token's visible prefix: "cdh_" + 32 random bytes in base64url (43 characters). */
export const HD_API_TOKEN_PREFIX = "cdh_";

/** The roles a token may act as. Admin is left out: no API route needs a configuration capability. */
export const HD_API_TOKEN_ROLES = ["newbie", "agent", "team_lead", "manager"] as const satisfies readonly HdRole[];
export type HdApiTokenRole = (typeof HD_API_TOKEN_ROLES)[number];

export function isApiTokenRole(v: unknown): v is HdApiTokenRole {
  return typeof v === "string" && (HD_API_TOKEN_ROLES as readonly string[]).includes(v);
}

export const HD_API_LIMITS = {
  /** Tokens and webhooks a workspace may hold (revoked tokens don't count). */
  tokens: 50,
  webhooks: 25,
  name: 80,
  url: 2000,
  /** API calls per token per minute. */
  perMinute: 120,
  /** Failed token checks per address per minute before 429. */
  authFailsPerMinute: 30,
  /** The delivery log keeps this many finished rows per webhook. */
  logPerHook: 50,
  /** Bytes of a receiver's answer kept in the log. */
  responseExcerpt: 2048,
  /** How long a delivery is retried before it fails. */
  retryHours: 24,
  /** One delivery attempt's time limit. */
  timeoutMs: 10_000,
} as const;

/** Expiry choices in the New token dialog (days; null = never). "custom" asks for a date. */
export const HD_API_EXPIRY_CHOICES = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "custom", label: "On a date…" },
  { value: "never", label: "Never" },
] as const;

// --- Webhook events ------------------------------------------------------------------

/**
 * Every event a webhook can hear. ticket.deleted and ticket.restored are the
 * recycle bin's (1.19.4 C7, lib/helpdesk/recycle-bin), sent through
 * emitHelpdeskWebhookEvent like the rest.
 */
export const HD_WEBHOOK_EVENTS = [
  "ticket.created",
  "ticket.updated",
  "ticket.solved",
  "message.created",
  "note.created",
  "approval.decided",
  "ticket.deleted",
  "ticket.restored",
] as const;
export type HdWebhookEvent = (typeof HD_WEBHOOK_EVENTS)[number];

export function isWebhookEvent(v: unknown): v is HdWebhookEvent {
  return typeof v === "string" && (HD_WEBHOOK_EVENTS as readonly string[]).includes(v);
}

export const HD_WEBHOOK_EVENT_HINT: Record<HdWebhookEvent, string> = {
  "ticket.created": "A new ticket or request",
  "ticket.updated": "Status, priority, team, owner, tags or subject changed",
  "ticket.solved": "A ticket is solved or closed",
  "message.created": "A public reply from the desk or the requester (held replies only once approved)",
  "note.created": "An internal note (only sent when the webhook includes internal notes)",
  "approval.decided": "An approval step is approved or declined",
  "ticket.deleted": "A ticket is moved to the recycle bin",
  "ticket.restored": "A ticket is restored from the recycle bin",
};

/** The events a new webhook starts with. */
export const HD_WEBHOOK_DEFAULT_EVENTS: readonly HdWebhookEvent[] = ["ticket.created", "ticket.updated", "ticket.solved"];

/** The header carrying the signature: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export const HD_WEBHOOK_SIGNATURE_HEADER = "X-CompassDocs-Signature";

// --- Views ----------------------------------------------------------------------------

export interface HdApiTokenView {
  id: number;
  name: string;
  /** "cdh_…a91f". */
  hint: string;
  role: HdApiTokenRole;
  role_label: string;
  team_ids: number[];
  team_names: string[];
  /** The name its notes and changes carry ("Shown as"). */
  shown_as: string;
  /** What the role lets it do through the API, as one line ("Read tickets · update status and tags · add notes"). */
  can: string;
  expires_at: string | null;
  expired: boolean;
  last_used_at: string | null;
  created_at: string;
  created_by_name: string;
  revoked_at: string | null;
}

export type HdWebhookHealth = "ok" | "failing" | "off" | "new";

export interface HdWebhookView {
  id: number;
  name: string;
  url: string;
  events: HdWebhookEvent[];
  team_ids: number[];
  team_names: string[];
  include_notes: boolean;
  enabled: boolean;
  disabled_reason: string;
  /** "whsec_…9f2c". */
  secret_hint: string;
  health: HdWebhookHealth;
  last_delivery: { at: string; status: number | null; state: HdDeliveryState } | null;
  pending: number;
  created_at: string;
  created_by_name: string;
}

export type HdDeliveryState = "queued" | "sending" | "delivered" | "failed";

export interface HdDeliveryView {
  id: number;
  event: string;
  ticket_number: number | null;
  test: boolean;
  state: HdDeliveryState;
  attempts: number;
  response_status: number | null;
  response_excerpt: string;
  error: string;
  duration_ms: number | null;
  created_at: string;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  finished_at: string | null;
}

/** The New token / New webhook dialogs' team choices and the roles this admin may hand out. */
export interface HdApiOptions {
  teams: { id: number; name: string }[];
  /** Every team may be chosen (the admin sees every team). */
  all_teams: boolean;
  roles: { value: HdApiTokenRole; label: string; can: string }[];
  /** The /api/helpdesk/v1 base for the docs line, without the origin. */
  base_path: string;
}

/** "200 · 2m ago" / "Failing · retrying" / "Off" chips' tone. */
export const HD_WEBHOOK_HEALTH_TONE: Record<HdWebhookHealth, "ok" | "error" | "neutral" | "info"> = {
  ok: "ok",
  failing: "error",
  off: "neutral",
  new: "info",
};
