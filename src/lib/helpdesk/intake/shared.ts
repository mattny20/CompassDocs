// Helpdesk 1.19.0, machine intake (agent P): the vocabulary the server and
// the desk share. Plain module (no server imports), so the admin pages, the
// AlertDetails panel and the pure adapters can all read it.

import type { HdPriority } from "../types";

export const HD_INTEGRATION_KINDS = [
  "prometheus",
  "grafana",
  "datadog",
  "azure_monitor",
  "pagerduty_like",
  "webhook_generic",
  "api",
  "email",
] as const;
export type HdIntegrationKind = (typeof HD_INTEGRATION_KINDS)[number];

export const HD_INTEGRATION_KIND_LABEL: Record<HdIntegrationKind, string> = {
  prometheus: "Prometheus Alertmanager",
  grafana: "Grafana",
  datadog: "Datadog",
  azure_monitor: "Azure Monitor",
  pagerduty_like: "PagerDuty-style events",
  webhook_generic: "Generic webhook",
  api: "API or bot",
  email: "Automated email",
};

/** The short name in "Automated · Grafana" and "Monitoring (Grafana)". */
export const HD_INTEGRATION_KIND_SHORT: Record<HdIntegrationKind, string> = {
  prometheus: "Prometheus",
  grafana: "Grafana",
  datadog: "Datadog",
  azure_monitor: "Azure Monitor",
  pagerduty_like: "Events API",
  webhook_generic: "Webhook",
  api: "API",
  email: "Email",
};

export function isIntegrationKind(v: unknown): v is HdIntegrationKind {
  return typeof v === "string" && (HD_INTEGRATION_KINDS as readonly string[]).includes(v);
}

/** Kinds that post to the HTTP endpoint (everything but email). */
export const isWebhookKind = (k: HdIntegrationKind) => k !== "email";

/** The ticket source an integration's tickets carry. */
export function sourceForKind(kind: HdIntegrationKind): "alert" | "api" {
  return kind === "api" ? "api" : "alert";
}

// --- Severities -------------------------------------------------------------------

export const HD_ALERT_SEVERITIES = ["critical", "high", "warning", "info"] as const;
export type HdAlertSeverity = (typeof HD_ALERT_SEVERITIES)[number];
export const HD_ALERT_SEVERITY_LABEL: Record<HdAlertSeverity, string> = {
  critical: "Critical",
  high: "High",
  warning: "Warning",
  info: "Info",
};

export type HdSeverityMap = Partial<Record<HdAlertSeverity, HdPriority>>;
export const HD_DEFAULT_SEVERITY_MAP: Required<HdSeverityMap> = {
  critical: "urgent",
  high: "high",
  warning: "normal",
  info: "low",
};

const SEVERITY_WORDS: Record<HdAlertSeverity, string[]> = {
  critical: ["critical", "crit", "fatal", "emergency", "emerg", "disaster", "page", "sev0", "sev 0", "p1", "p0", "alert"],
  high: ["error", "err", "high", "major", "severe", "sev1", "sev 1", "p2"],
  warning: ["warning", "warn", "minor", "medium", "moderate", "average", "sev2", "sev 2", "p3"],
  info: ["info", "informational", "information", "low", "notice", "ok", "verbose", "debug", "sev3", "sev 3", "sev4", "sev 4", "p4", "p5", "none"],
};

/** A tool's severity word ("Sev1", "CRITICAL", "warn", "P2") as one of ours; null when unknown. */
export function normalizeSeverity(raw: unknown): HdAlertSeverity | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Numeric scales: 0/1 = most severe (Azure's Sev0, syslog's emergencies), 4+ = info.
    if (raw <= 0) return "critical";
    if (raw === 1) return "high";
    if (raw === 2) return "warning";
    return "info";
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  for (const sev of HD_ALERT_SEVERITIES) if (SEVERITY_WORDS[sev].includes(s)) return sev;
  return null;
}

// --- Normalised alerts (every adapter's output) -----------------------------------

export interface HdAlertLink {
  label: string;
  url: string;
}

export type HdAlertStatus = "firing" | "resolved";

/** The generic shape: what a generic webhook posts, and what each adapter maps a tool's payload into. */
export interface HdNormalizedAlert {
  title: string;
  /** Markdown or plain text from the tool; sanitised before it is stored. */
  description: string;
  /** "plain" text is escaped as is; "markdown" keeps its formatting, minus HTML and unsafe links. */
  description_format?: "markdown" | "plain";
  /** The tool's own word; mapped through the integration's severity map. */
  severity: string;
  status: HdAlertStatus;
  /** '' = derived from the title and source. */
  dedup_key: string;
  /** Free text: the host, service or tool that raised it. */
  source: string;
  links: HdAlertLink[];
  fields: Record<string, string>;
  /** A workspace member the ticket is for (API integrations opening tickets on someone's behalf). */
  requester_email?: string;
}

// --- Deliveries and the admin views -------------------------------------------------

export const HD_INTAKE_OUTCOMES = ["created", "updated", "reopened", "resolved", "ignored", "rejected"] as const;
export type HdIntakeOutcome = (typeof HD_INTAKE_OUTCOMES)[number];
export const HD_INTAKE_OUTCOME_LABEL: Record<HdIntakeOutcome, string> = {
  created: "Created",
  updated: "Updated",
  reopened: "Reopened",
  resolved: "Resolved",
  ignored: "Ignored",
  rejected: "Rejected",
};

export interface HdIntegrationView {
  id: number;
  name: string;
  kind: HdIntegrationKind;
  /** The key's first characters, for recognising it ("cdhk_3fa9c1…"). */
  token_prefix: string;
  sender_addresses: string[];
  subject_dedup_pattern: string;
  default_team_id: number | null;
  team_name: string | null;
  default_priority: HdPriority;
  severity_map: HdSeverityMap;
  dedup_window_minutes: number;
  auto_resolve: boolean;
  reopen_on_repeat: boolean;
  rate_limit_per_minute: number;
  enabled: boolean;
  /** Email kind: mail with no SPF/DKIM/DMARC verdict from the provider is accepted (off by default). */
  allow_unverified_mail: boolean;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  /** Distinct alerts seen in the last 24 hours. */
  alerts_24h: number;
  /** The path the tool posts to (webhook kinds), e.g. /api/helpdesk/intake/7. */
  endpoint_path: string;
}

export interface HdDeliveryView {
  id: number;
  at: string;
  status_code: number;
  outcome: HdIntakeOutcome;
  reason: string;
  ticket_number: number | null;
  dedup_key: string;
}

/** What the AlertDetails panel reads for one ticket. */
export interface HdAlertDetailsView {
  integration: { id: number; name: string; kind: HdIntegrationKind } | null;
  automated: boolean;
  alert: {
    dedup_key: string;
    state: HdAlertStatus;
    count: number;
    first_seen: string;
    last_seen: string;
    resolved_at: string | null;
    severity: string;
    source: string;
    links: HdAlertLink[];
    fields: Record<string, string>;
  } | null;
}

/** The label of an automated ticket's chip: "Automated · Grafana". */
export function automatedChipLabel(kind: string | null | undefined): string {
  return isIntegrationKind(kind) ? `Automated · ${HD_INTEGRATION_KIND_SHORT[kind]}` : "Automated";
}

/** The requester name an integration's tickets carry: "Monitoring (Grafana)". */
export function serviceIdentityName(name: string, kind: HdIntegrationKind): string {
  const short = HD_INTEGRATION_KIND_SHORT[kind];
  const n = name.trim() || "Integration";
  return n.toLowerCase().includes(short.toLowerCase()) ? n : `${n} (${short})`;
}

export const HD_INTAKE_LIMITS = {
  name: 80,
  bodyBytes: 256 * 1024,
  title: 200,
  description: 20_000,
  dedupKey: 255,
  source: 200,
  links: 20,
  linkLabel: 100,
  linkUrl: 2000,
  fields: 50,
  fieldKey: 100,
  fieldValue: 1000,
  senders: 20,
  pattern: 300,
  /** Alerts in one webhook (Alertmanager and Grafana group them). */
  alertsPerRequest: 50,
  dedupWindowMax: 60 * 24 * 30,
  rateMax: 600,
} as const;
