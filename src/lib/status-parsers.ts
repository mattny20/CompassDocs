// Pure pieces of the SaaS status board: provider catalog and the parsers
// that normalize each vendor's payload to one shared state. No server
// imports — these run anywhere, including offline fixture tests.

export type ServiceStatus = "operational" | "degraded" | "outage" | "maintenance" | "unknown";

export interface ParsedStatus {
  status: ServiceStatus;
  detail: string;
  url: string;
}

// --- Catalog -------------------------------------------------------------------
// One-click presets. Everything here uses the Atlassian Statuspage JSON format
// unless the provider says otherwise; admins can also add any custom URL.

export const STATUS_PROVIDERS = [
  "statuspage",
  "slack",
  "google",
  "salesforce",
  "aws",
  "rss",
  "m365",
  "manual",
] as const;

export const STATUS_CATALOG: { name: string; provider: string; source_url: string }[] = [
  { name: "GitHub", provider: "statuspage", source_url: "https://www.githubstatus.com" },
  { name: "Zoom", provider: "statuspage", source_url: "https://status.zoom.us" },
  { name: "Cloudflare", provider: "statuspage", source_url: "https://www.cloudflarestatus.com" },
  { name: "Dropbox", provider: "statuspage", source_url: "https://status.dropbox.com" },
  { name: "OpenAI", provider: "statuspage", source_url: "https://status.openai.com" },
  { name: "Anthropic", provider: "statuspage", source_url: "https://status.anthropic.com" },
  { name: "Atlassian", provider: "statuspage", source_url: "https://status.atlassian.com" },
  { name: "Twilio", provider: "statuspage", source_url: "https://status.twilio.com" },
  { name: "DocuSign", provider: "statuspage", source_url: "https://status.docusign.com" },
  { name: "Box", provider: "statuspage", source_url: "https://status.box.com" },
  { name: "NetDocuments", provider: "statuspage", source_url: "https://status.netdocuments.com" },
  { name: "iManage Cloud", provider: "statuspage", source_url: "https://status.imanage.com" },
  { name: "Slack", provider: "slack", source_url: "https://status.slack.com" },
  { name: "Google Workspace", provider: "google", source_url: "https://www.google.com/appsstatus" },
  { name: "Salesforce", provider: "salesforce", source_url: "https://status.salesforce.com" },
  { name: "AWS", provider: "aws", source_url: "https://status.aws.amazon.com" },
  { name: "Microsoft 365", provider: "m365", source_url: "" },
];

// --- Parsers (pure — fixture-testable) -------------------------------------------

/** Atlassian Statuspage /api/v2/summary.json. */
export function parseStatuspage(json: any, pageUrl: string): ParsedStatus {
  const indicator = String(json?.status?.indicator ?? "unknown");
  const map: Record<string, ServiceStatus> = {
    none: "operational",
    minor: "degraded",
    major: "outage",
    critical: "outage",
    maintenance: "maintenance",
  };
  const incident = (json?.incidents ?? [])[0];
  const maintenance = (json?.scheduled_maintenances ?? []).find(
    (m: any) => m?.status === "in_progress"
  );
  return {
    status: map[indicator] ?? "unknown",
    detail: String(incident?.name ?? maintenance?.name ?? json?.status?.description ?? ""),
    url: String(incident?.shortlink || pageUrl),
  };
}

/** Slack's status.slack.com/api/v2.0.0/current. */
export function parseSlack(json: any): ParsedStatus {
  const active = json?.active_incidents ?? [];
  if (String(json?.status) === "ok" || active.length === 0) {
    return { status: "operational", detail: "", url: "https://slack.com/status" };
  }
  const worst = active[0];
  const type = String(worst?.type ?? "incident");
  return {
    status: type === "outage" ? "outage" : type === "maintenance" ? "maintenance" : "degraded",
    detail: String(worst?.title ?? "Active incident"),
    url: String(worst?.url || "https://slack.com/status"),
  };
}

/** Google Workspace dashboard incidents.json (array; open = no `end`). */
export function parseGoogle(json: any): ParsedStatus {
  const open = (Array.isArray(json) ? json : []).filter((i: any) => !i?.end);
  if (open.length === 0) {
    return { status: "operational", detail: "", url: "https://www.google.com/appsstatus/dashboard/" };
  }
  const worst = open.find((i: any) => String(i?.severity) === "high") ?? open[0];
  const products = (worst?.affected_products ?? [])
    .map((p: any) => p?.title)
    .filter(Boolean)
    .slice(0, 4)
    .join(", ");
  return {
    status: String(worst?.severity) === "high" ? "outage" : "degraded",
    detail: [worst?.external_desc, products && `(${products})`].filter(Boolean).join(" ").slice(0, 300),
    url: `https://www.google.com/appsstatus/dashboard/incidents/${worst?.id ?? ""}`,
  };
}

/** Salesforce api.status.salesforce.com/v1/incidents/active (array). */
export function parseSalesforce(json: any): ParsedStatus {
  const active = Array.isArray(json) ? json : [];
  if (active.length === 0) {
    return { status: "operational", detail: "", url: "https://status.salesforce.com" };
  }
  const worst = active[0];
  const impacts = (worst?.IncidentImpacts ?? []).map((i: any) => i?.type).filter(Boolean);
  const isCore = impacts.some((t: string) => /unavailable|outage|core/i.test(t));
  return {
    status: isCore ? "outage" : "degraded",
    detail:
      String(worst?.IncidentEvents?.[0]?.message ?? "").slice(0, 300) ||
      `${active.length} active incident${active.length === 1 ? "" : "s"}`,
    url: `https://status.salesforce.com/incidents/${worst?.id ?? ""}`,
  };
}

/** Generic RSS/Atom fallback (also used for AWS): the newest item within the
 * last 24h whose title doesn't read as resolved marks the service degraded.
 * Coarse by design — feeds don't carry component state. */
export function parseRssFeed(xml: string, feedUrl: string): ParsedStatus {
  const items = [...xml.matchAll(/<(item|entry)[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const pick = (block: string, tag: string) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    return (m?.[1] ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .trim();
  };
  const now = Date.now();
  for (const item of items.slice(0, 10)) {
    const when = new Date(
      pick(item, "pubDate") || pick(item, "updated") || pick(item, "published") || 0
    ).getTime();
    if (isNaN(when) || now - when > 24 * 60 * 60 * 1000) continue;
    const title = pick(item, "title");
    if (/resolved|completed|back to normal|operating normally/i.test(title)) continue;
    const link =
      pick(item, "link") || item.match(/<link[^>]*href="([^"]+)"/i)?.[1] || feedUrl;
    return { status: "degraded", detail: title.slice(0, 300), url: link };
  }
  return { status: "operational", detail: "", url: feedUrl };
}

/** Microsoft Graph serviceAnnouncement/healthOverviews (EE). */
export function parseM365(json: any): ParsedStatus {
  const overviews = json?.value ?? [];
  const bad = overviews.filter(
    (o: any) => o?.status && !/serviceOperational|serviceRestored/i.test(String(o.status))
  );
  if (bad.length === 0) {
    return { status: "operational", detail: "", url: "https://admin.microsoft.com/#/servicehealth" };
  }
  const outage = bad.some((o: any) => /interruption/i.test(String(o.status)));
  return {
    status: outage ? "outage" : "degraded",
    detail: bad
      .map((o: any) => o?.service)
      .filter(Boolean)
      .slice(0, 6)
      .join(", "),
    url: "https://admin.microsoft.com/#/servicehealth",
  };
}

