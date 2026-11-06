// Helpdesk 1.19.0, machine intake (agent P): each tool's webhook payload as
// the generic alert shape (HdNormalizedAlert). Pure: a payload in, alerts
// out, or an IntakePayloadError with a sentence for the deliveries log.
// Sanitising (HTML, links, caps) happens after this, in lib/helpdesk/intake
// sanitize, so an adapter only decides what means what.
//
//   generic          {title, description, severity, status, dedup_key,
//                    source, links:[{label,url}], fields:{}, requester_email}
//                    (also used by the API and generic webhook kinds)
//   prometheus       Alertmanager webhook_config (version 4): one alert per
//                    entry in alerts[], keyed by fingerprint
//   grafana          Grafana alerting's webhook contact point (the
//                    Alertmanager shape plus title/message and per-alert
//                    dashboard, panel and silence URLs), and the legacy
//                    dashboard-alert shape (ruleId, state alerting|ok)
//   datadog          a webhook with the payload template in the setup
//                    notes ($ALERT_TRANSITION, $AGGREG_KEY, …); also the
//                    default template's title/body/id
//   azure_monitor    the common alert schema (essentials: alertId,
//                    monitorCondition Fired|Resolved, severity Sev0-4)
//   pagerduty_like   PagerDuty Events API v2 style (event_action
//                    trigger|resolve, dedup_key, payload.summary)

import type { HdAlertLink, HdAlertStatus, HdIntegrationKind, HdNormalizedAlert } from "./shared";
import { HD_INTAKE_LIMITS } from "./shared";

export class IntakePayloadError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

function statusWord(v: unknown, fallback: HdAlertStatus = "firing"): HdAlertStatus {
  const s = str(v).trim().toLowerCase();
  if (["resolved", "resolve", "ok", "recovered", "recovery", "closed", "normal", "inactive", "success"].includes(s)) return "resolved";
  if (["firing", "fired", "trigger", "triggered", "alerting", "alert", "active", "problem", "open", "re-triggered", "warn", "error", "no_data", "nodata"].includes(s)) return "firing";
  return fallback;
}

function link(label: string, url: unknown): HdAlertLink | null {
  const u = str(url).trim();
  return u ? { label, url: u } : null;
}
const links = (...ls: (HdAlertLink | null)[]) => ls.filter((l): l is HdAlertLink => !!l);

/** String-valued labels/annotations/tags as fields. */
function stringMap(v: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v))) {
    const s = str(val);
    if (s) out[`${prefix}${k}`] = s;
  }
  return out;
}

// --- Generic ----------------------------------------------------------------------

export function adaptGeneric(body: unknown): HdNormalizedAlert[] {
  if (!isObj(body)) throw new IntakePayloadError("The body must be a JSON object.");
  const title = str(body.title ?? body.summary ?? body.subject);
  if (!title.trim()) throw new IntakePayloadError("title is required.");
  const rawStatus = str(body.status).trim().toLowerCase();
  if (rawStatus && rawStatus !== "firing" && rawStatus !== "resolved") throw new IntakePayloadError("status must be firing or resolved.");
  const status: HdAlertStatus = rawStatus === "resolved" ? "resolved" : "firing";
  return [
    {
      title,
      description: str(body.description ?? body.message ?? body.body),
      description_format: body.description_format === "plain" ? "plain" : "markdown",
      severity: str(body.severity),
      status,
      dedup_key: str(body.dedup_key ?? body.dedupKey ?? body.fingerprint),
      source: str(body.source),
      links: Array.isArray(body.links) ? (body.links as HdAlertLink[]) : [],
      fields: isObj(body.fields) ? (body.fields as Record<string, string>) : {},
      requester_email: str(body.requester_email) || undefined,
    },
  ];
}

// --- Prometheus Alertmanager (and Grafana's unified alerting) ----------------------

interface AmOptions {
  /** Grafana adds per-alert URLs and a values string. */
  grafana?: boolean;
}

function adaptAlertmanagerShape(body: Obj, opts: AmOptions = {}): HdNormalizedAlert[] {
  const alerts = Array.isArray(body.alerts) ? (body.alerts as unknown[]).filter(isObj) : [];
  if (!alerts.length) throw new IntakePayloadError("No alerts in the payload.");
  if (alerts.length > HD_INTAKE_LIMITS.alertsPerRequest) throw new IntakePayloadError(`At most ${HD_INTAKE_LIMITS.alertsPerRequest} alerts in one request.`);
  const common = obj(body.commonAnnotations);
  const external = str(body.externalURL);
  return alerts.map((a) => {
    const labels = obj(a.labels);
    const ann = { ...common, ...obj(a.annotations) };
    const name = str(labels.alertname) || str(body.title) || "Alert";
    const where = str(labels.instance) || str(labels.service) || str(labels.job) || str(labels.pod) || str(labels.host);
    const title = str(ann.summary) || (where ? `${name} on ${where}` : name);
    const parts = [str(ann.description) || str(ann.message)];
    if (opts.grafana && str(a.valueString)) parts.push(`Values: \`${str(a.valueString).replace(/`/g, "'")}\``);
    const fields: Record<string, string> = { ...stringMap(labels) };
    if (str(a.startsAt) && !str(a.startsAt).startsWith("0001")) fields["Started"] = str(a.startsAt);
    if (str(a.endsAt) && !str(a.endsAt).startsWith("0001") && statusWord(a.status ?? body.status) === "resolved") fields["Ended"] = str(a.endsAt);
    return {
      title,
      description: parts.filter(Boolean).join("\n\n"),
      description_format: "markdown" as const,
      severity: str(labels.severity) || str(labels.priority),
      status: statusWord(a.status ?? body.status),
      dedup_key: str(a.fingerprint) || Object.entries(labels).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${k}=${str(v)}`).join(","),
      source: where || str(labels.job) || (opts.grafana ? "Grafana" : "Alertmanager"),
      links: links(
        link("Source", a.generatorURL),
        opts.grafana ? link("Dashboard", a.dashboardURL) : null,
        opts.grafana ? link("Panel", a.panelURL) : null,
        link("Runbook", ann.runbook_url ?? ann.runbook),
        opts.grafana ? link("Silence", a.silenceURL) : external ? link("Alertmanager", external) : null
      ),
      fields,
    };
  });
}

export function adaptPrometheus(body: unknown): HdNormalizedAlert[] {
  if (!isObj(body)) throw new IntakePayloadError("The body must be a JSON object.");
  return adaptAlertmanagerShape(body);
}

export function adaptGrafana(body: unknown): HdNormalizedAlert[] {
  if (!isObj(body)) throw new IntakePayloadError("The body must be a JSON object.");
  if (Array.isArray(body.alerts)) return adaptAlertmanagerShape(body, { grafana: true });
  // Legacy dashboard alerts: {title, ruleId, ruleName, ruleUrl, state, message, evalMatches, tags}.
  if (body.ruleId !== undefined || body.ruleName !== undefined || body.state !== undefined) {
    const state = str(body.state).toLowerCase();
    const fields: Record<string, string> = stringMap(body.tags);
    for (const m of (Array.isArray(body.evalMatches) ? body.evalMatches : []).filter(isObj).slice(0, 10)) {
      if (str(m.metric)) fields[str(m.metric)] = str(m.value);
    }
    return [
      {
        title: str(body.ruleName) || str(body.title) || "Grafana alert",
        description: str(body.message),
        description_format: "markdown",
        severity: str(obj(body.tags).severity),
        status: state === "ok" ? "resolved" : "firing",
        dedup_key: body.ruleId !== undefined ? `rule-${str(body.ruleId)}` : str(body.ruleName),
        source: "Grafana",
        links: links(link("Rule", body.ruleUrl), link("Image", body.imageUrl)),
        fields,
      },
    ];
  }
  throw new IntakePayloadError("Not a Grafana alert payload.");
}

// --- Datadog -------------------------------------------------------------------------

export function adaptDatadog(body: unknown): HdNormalizedAlert[] {
  if (!isObj(body)) throw new IntakePayloadError("The body must be a JSON object.");
  const transition = str(body.alert_transition ?? body.transition).toLowerCase();
  const alertType = str(body.alert_type).toLowerCase();
  const resolved = transition === "recovered" || transition === "recovery" || alertType === "success" || str(body.alert_status).toLowerCase() === "recovered";
  const title = str(body.title ?? body.event_title).replace(/^\[(triggered|recovered|warn|re-triggered|no data)[^\]]*\]\s*/i, "");
  if (!title.trim()) throw new IntakePayloadError("title is required (map $EVENT_TITLE).");
  const fields: Record<string, string> = {};
  for (const k of ["hostname", "alert_metric", "alert_query", "alert_scope", "org_name", "alert_status"]) if (str(body[k])) fields[k] = str(body[k]);
  const tags = Array.isArray(body.tags) ? (body.tags as unknown[]).map(str) : str(body.tags).split(",");
  const tagList = tags.map((t) => t.trim()).filter(Boolean);
  if (tagList.length) fields["tags"] = tagList.slice(0, 30).join(", ");
  return [
    {
      title,
      description: str(body.text_only_msg ?? body.body ?? body.message),
      description_format: "markdown",
      severity: str(body.priority ?? body.alert_priority) === "P1" ? "critical" : alertType === "error" ? "high" : alertType === "warning" ? "warning" : str(body.severity) || str(body.priority ?? body.alert_priority) || alertType,
      status: resolved ? "resolved" : "firing",
      dedup_key: str(body.aggreg_key ?? body.alert_cycle_key ?? body.alert_id ?? body.id),
      source: str(body.hostname) || "Datadog",
      links: links(link("Datadog", body.link ?? body.url), link("Snapshot", body.snapshot)),
      fields,
    },
  ];
}

// --- Azure Monitor (common alert schema) -----------------------------------------------

export function adaptAzureMonitor(body: unknown): HdNormalizedAlert[] {
  if (!isObj(body)) throw new IntakePayloadError("The body must be a JSON object.");
  const data = obj(body.data);
  const ess = obj(data.essentials);
  if (!Object.keys(ess).length) throw new IntakePayloadError("Not the Azure Monitor common alert schema (turn it on in the action group).");
  const alertId = str(ess.alertId);
  const targets = Array.isArray(ess.configurationItems) ? (ess.configurationItems as unknown[]).map(str).filter(Boolean) : [];
  const fields: Record<string, string> = {};
  for (const k of ["signalType", "monitoringService", "firedDateTime", "resolvedDateTime", "alertContextVersion"]) if (str(ess[k])) fields[k] = str(ess[k]);
  if (targets.length) fields["Resources"] = targets.slice(0, 10).join(", ");
  const sev = str(ess.severity);
  return [
    {
      title: str(ess.alertRule) ? `${str(ess.alertRule)}${targets[0] ? ` on ${targets[0]}` : ""}` : "Azure Monitor alert",
      description: str(ess.description),
      description_format: "plain",
      severity: sev,
      status: str(ess.monitorCondition).toLowerCase() === "resolved" ? "resolved" : "firing",
      dedup_key: str(ess.originAlertId) || alertId,
      source: targets[0] || str(ess.monitoringService) || "Azure Monitor",
      links: links(
        alertId ? link("Azure portal", `https://portal.azure.com/#view/Microsoft_Azure_Monitoring_Alerts/AlertDetails.ReactView/alertId/${encodeURIComponent(alertId)}`) : null
      ),
      fields,
    },
  ];
}

// --- PagerDuty Events API v2 style ------------------------------------------------------

export function adaptPagerDutyLike(body: unknown): HdNormalizedAlert[] {
  if (!isObj(body)) throw new IntakePayloadError("The body must be a JSON object.");
  const action = str(body.event_action).toLowerCase();
  if (!["trigger", "resolve", "acknowledge"].includes(action)) throw new IntakePayloadError("event_action must be trigger, acknowledge or resolve.");
  const p = obj(body.payload);
  const summary = str(p.summary);
  if (action === "trigger" && !summary.trim()) throw new IntakePayloadError("payload.summary is required.");
  const fields: Record<string, string> = {};
  for (const k of ["component", "group", "class", "timestamp"]) if (str(p[k])) fields[k] = str(p[k]);
  Object.assign(fields, stringMap(p.custom_details));
  const pdLinks = (Array.isArray(body.links) ? body.links : []).filter(isObj).map((l) => link(str(l.text) || "Link", l.href));
  return [
    {
      title: summary || `Alert ${str(body.dedup_key)}`,
      description: isObj(p.custom_details) ? "" : str(p.custom_details),
      description_format: "plain",
      severity: str(p.severity),
      // An acknowledgement is not a resolution: it lands as a repeat.
      status: action === "resolve" ? "resolved" : "firing",
      dedup_key: str(body.dedup_key),
      source: str(p.source),
      links: links(...pdLinks),
      fields,
    },
  ];
}

/** The adapter for an integration's kind. */
export function adaptPayload(kind: HdIntegrationKind, body: unknown): HdNormalizedAlert[] {
  switch (kind) {
    case "prometheus":
      return adaptPrometheus(body);
    case "grafana":
      return adaptGrafana(body);
    case "datadog":
      return adaptDatadog(body);
    case "azure_monitor":
      return adaptAzureMonitor(body);
    case "pagerduty_like":
      return adaptPagerDutyLike(body);
    case "email":
      throw new IntakePayloadError("This integration takes email, not webhooks.");
    default:
      return adaptGeneric(body);
  }
}
