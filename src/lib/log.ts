// Minimal structured logger. With COMPASSDOCS_LOG_FORMAT=json every event is
// a single JSON line (machine-shippable to Loki/CloudWatch/etc.); otherwise
// events print as readable console lines. Server-only.

import "server-only";

type Level = "info" | "warn" | "error";

const json = () => process.env.COMPASSDOCS_LOG_FORMAT === "json";

export function logEvent(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  if (json()) {
    // eslint-disable-next-line no-console
    console[level === "info" ? "log" : level](
      JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })
    );
    return;
  }
  const extras = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  // eslint-disable-next-line no-console
  console[level === "info" ? "log" : level](`[${event}]${extras ? " " + extras : ""}`);
}
