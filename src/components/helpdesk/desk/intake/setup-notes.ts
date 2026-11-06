// Per-tool setup notes for an integration (agent P): shown once beside the
// new key and on the integration's page. Plain data so the docs can quote
// the same steps. `{url}` is the endpoint; the key never appears here.

import type { HdIntegrationKind } from "@/lib/helpdesk/intake/shared";

export interface SetupNote {
  steps: string[];
  /** A snippet to paste into the tool, with {url} filled in by the page. */
  snippet?: { label: string; text: string };
}

export const SETUP_NOTES: Record<HdIntegrationKind, SetupNote> = {
  prometheus: {
    steps: [
      "Add a receiver to alertmanager.yml with a webhook_configs entry (below), and route the alerts you want as tickets to it.",
      "Keep send_resolved: true so a recovered alert solves its ticket.",
      "Each alert's fingerprint is its dedup key; the severity label picks the priority.",
    ],
    snippet: {
      label: "alertmanager.yml",
      text: `receivers:
  - name: compassdocs-helpdesk
    webhook_configs:
      - url: "{url}"
        send_resolved: true
        http_config:
          authorization:
            type: Bearer
            credentials: "<your key>"`,
    },
  },
  grafana: {
    steps: [
      "In Grafana, Alerting, Contact points: add a contact point of type Webhook with the URL below.",
      "Under Optional Webhook settings, set Authorization Header Scheme to Bearer and the credentials to your key.",
      "Point a notification policy at the contact point. Resolved notifications solve the ticket.",
    ],
  },
  datadog: {
    steps: [
      "In Datadog, Integrations, Webhooks: add a webhook with the URL below and this payload.",
      "Under Custom headers, add {\"Authorization\": \"Bearer <your key>\"}.",
      "Mention @webhook-<name> in a monitor's message. The Recovered transition solves the ticket.",
    ],
    snippet: {
      label: "Payload",
      text: `{
  "title": "$EVENT_TITLE",
  "text_only_msg": "$TEXT_ONLY_MSG",
  "alert_transition": "$ALERT_TRANSITION",
  "alert_type": "$ALERT_TYPE",
  "alert_id": "$ALERT_ID",
  "aggreg_key": "$AGGREG_KEY",
  "priority": "$ALERT_PRIORITY",
  "hostname": "$HOSTNAME",
  "link": "$LINK",
  "tags": "$TAGS"
}`,
    },
  },
  azure_monitor: {
    steps: [
      "In an action group, add a Webhook action and turn on the common alert schema.",
      "Azure can't send an Authorization header, so put the key in the URL: add ?key=<your key> to the address below.",
      "Fired opens a ticket and Resolved solves it; Sev0 to Sev4 map to the priorities you set.",
    ],
  },
  pagerduty_like: {
    steps: [
      "For tools that speak the PagerDuty Events API v2: use the URL below as the events endpoint and send the key as a Bearer token.",
      "event_action trigger opens or repeats, resolve solves; dedup_key ties them together. routing_key is ignored.",
    ],
  },
  webhook_generic: {
    steps: [
      "POST JSON to the URL below with Authorization: Bearer <your key>.",
      "Fields: title (required), description, severity, status (firing or resolved), dedup_key, source, links [{label, url}], fields {}.",
      "Send the same dedup_key with status resolved to solve the ticket.",
    ],
  },
  api: {
    steps: [
      "POST JSON to the URL below with Authorization: Bearer <your key>, from a script, bot or agent.",
      "Same fields as a generic webhook. Add requester_email to open the ticket for a workspace member: it becomes their request and they get the usual updates.",
      "Send an Idempotency-Key header to make retries safe.",
    ],
  },
  email: {
    steps: [
      "Have the tool mail your help address from one of the sender addresses you listed.",
      "Its mail is accepted even though it is automated, as long as your mail provider's SPF and DKIM checks pass.",
      "The subject is the ticket's title. A subject tagged [RESOLVED] or [OK] solves the ticket with the same subject.",
    ],
  },
};

/** The curl example for a new key (the page fills url and key; the key is shown once). */
export function curlExample(url: string, key: string): string {
  return `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Disk almost full on fs-02","severity":"warning","status":"firing","dedup_key":"fs-02-disk","source":"fs-02"}'`;
}
