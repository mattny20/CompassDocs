// SaaS status board: polls the public status pages of the tools an org
// tracks, normalizes each vendor's format to one shared state, and alerts
// the workspace when something goes down (or recovers). The parsers live in
// status-parsers.ts (pure, fixture-testable); all network access goes
// through safeFetch. Server-only.

import "server-only";
import {
  claimStatusPoll,
  listActiveUserIds,
  listStatusServices,
  setServiceStatus,
  type ServiceStatus,
  type StatusService,
} from "./db";
import { safeFetch } from "./safe-fetch";
import { notify } from "./notifications";
import {
  parseGoogle,
  parseM365,
  parseRssFeed,
  parseSalesforce,
  parseSlack,
  parseStatuspage,
  type ParsedStatus,
} from "./status-parsers";

export { STATUS_CATALOG, STATUS_PROVIDERS } from "./status-parsers";

export const POLL_INTERVAL_MINUTES = 5;

// --- Fetch + poll loop -----------------------------------------------------------

const FETCH_OPTS: RequestInit = {
  headers: { accept: "application/json, application/rss+xml, application/atom+xml, */*" },
  signal: AbortSignal.timeout(10_000),
};

async function getJson(url: string): Promise<any> {
  const res = await safeFetch(url, FETCH_OPTS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function m365Health(): Promise<ParsedStatus> {
  const { featureEnabled } = await import("./ee");
  if (!(await featureEnabled("directory_sync"))) {
    return {
      status: "unknown",
      detail: "Requires an enterprise license and the Entra directory credentials.",
      url: "",
    };
  }
  const { getDirectoryGraphConfig } = await import("./directory-config");
  const cfg = await getDirectoryGraphConfig();
  if (!cfg.tenant || !cfg.clientId || !cfg.clientSecret) {
    return {
      status: "unknown",
      detail: "Set the Entra credentials under Settings → Directory first.",
      url: "",
    };
  }
  const tokenRes = await safeFetch(
    `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!tokenRes.ok) throw new Error(`Graph token: HTTP ${tokenRes.status}`);
  const token = (await tokenRes.json()).access_token;
  const res = await safeFetch(
    "https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/healthOverviews",
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) throw new Error(`Graph healthOverviews: HTTP ${res.status} (is ServiceHealth.Read.All consented?)`);
  return parseM365(await res.json());
}

/** One poll of one service. Throws on fetch/parse problems. */
export async function fetchServiceStatus(svc: StatusService): Promise<ParsedStatus> {
  const base = svc.source_url.replace(/\/+$/, "");
  switch (svc.provider) {
    case "statuspage":
      return parseStatuspage(await getJson(`${base}/api/v2/summary.json`), base);
    case "slack":
      return parseSlack(await getJson("https://status.slack.com/api/v2.0.0/current"));
    case "google":
      return parseGoogle(
        await getJson("https://www.google.com/appsstatus/dashboard/incidents.json")
      );
    case "salesforce":
      return parseSalesforce(
        await getJson("https://api.status.salesforce.com/v1/incidents/active")
      );
    case "aws": {
      const res = await safeFetch("https://status.aws.amazon.com/rss/all.rss", FETCH_OPTS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseRssFeed(await res.text(), "https://health.aws.amazon.com/health/status");
    }
    case "rss": {
      const res = await safeFetch(base, FETCH_OPTS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseRssFeed(await res.text(), base);
    }
    case "m365":
      return m365Health();
    default:
      throw new Error(`Unknown provider: ${svc.provider}`);
  }
}

const ALERTABLE: ServiceStatus[] = ["degraded", "outage"];

/** Poll every due service (claim-guarded, multi-instance safe) and alert the
 * workspace on meaningful transitions. Never throws. */
export async function refreshDueStatuses(origin = ""): Promise<void> {
  let services: StatusService[];
  try {
    services = await listStatusServices();
  } catch {
    return; // DB not ready — the next tick retries
  }
  for (const svc of services) {
    if (svc.provider === "manual") continue;
    try {
      if (!(await claimStatusPoll(svc.id, POLL_INTERVAL_MINUTES))) continue;
      const parsed = await fetchServiceStatus(svc);
      const prev = await setServiceStatus(svc.id, {
        status: parsed.status,
        detail: parsed.detail,
        url: parsed.url,
      });
      await alertOnTransition(svc.name, prev, parsed, origin);
    } catch (e) {
      // Keep the last known state; a fetch hiccup isn't an outage. Only note
      // the failure when we never had data for this service.
      if (svc.status === "unknown") {
        await setServiceStatus(svc.id, {
          status: "unknown",
          detail: `Check failed: ${e instanceof Error ? e.message : String(e)}`,
          url: svc.status_url,
        }).catch(() => {});
      }
      console.error(`[status] poll failed for ${svc.name}:`, e);
    }
  }
}

async function alertOnTransition(
  name: string,
  prev: ServiceStatus | undefined,
  next: ParsedStatus,
  origin: string
): Promise<void> {
  if (!prev || prev === next.status) return;
  const worsened = ALERTABLE.includes(next.status) && !ALERTABLE.includes(prev);
  const recovered = next.status === "operational" && ALERTABLE.includes(prev);
  if (!worsened && !recovered) return; // unknown↔operational and similar: quiet
  await notify(await listActiveUserIds(), {
    kind: "service_status",
    title: worsened
      ? `${name}: ${next.status === "outage" ? "outage" : "degraded performance"}`
      : `${name} is back to normal`,
    body: worsened ? next.detail || undefined : undefined,
    link: "/status",
    origin,
  });
}

/** Manual-incident alert (declared/resolved by an admin). */
export async function alertManualIncident(input: {
  serviceName: string;
  title: string;
  severity: string;
  resolved: boolean;
  origin?: string;
}): Promise<void> {
  await notify(await listActiveUserIds(), {
    kind: "service_status",
    title: input.resolved
      ? `Resolved: ${input.serviceName} — ${input.title}`
      : `${input.serviceName}: ${input.title}`,
    body: input.resolved ? undefined : `Declared ${input.severity}.`,
    link: "/status",
    origin: input.origin,
  });
}
