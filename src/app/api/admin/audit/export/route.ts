import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { ee, featureEnabled } from "@/lib/ee";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { metric } from "@/lib/metrics";

export const dynamic = "force-dynamic";

/** Parse a from/to query value; date-only strings get UTC-day semantics. */
function parseInstant(raw: string | null, endOfDay: boolean): string | undefined {
  if (!raw) return undefined;
  const v = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? // Date-only "to" means "through the end of that day".
      `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00"}Z`
    : raw;
  return Number.isNaN(Date.parse(v)) ? undefined : v;
}

export async function GET(req: Request) {
  const gate = await apiGuard("admin", "audit.export");
  if (gate instanceof NextResponse) return gate;

  const exporter = ee().exportAuditLog;
  if (!exporter || !(await featureEnabled("audit_export"))) {
    return NextResponse.json(
      { error: "Audit-log export requires an enterprise license." },
      { status: 402 }
    );
  }

  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "json" ? ("json" as const) : ("csv" as const);
  const category = url.searchParams.get("category") || undefined;
  const actorId = Number(url.searchParams.get("actor_id")) || undefined;
  const from = parseInstant(url.searchParams.get("from"), false);
  const to = parseInstant(url.searchParams.get("to"), true);

  metric("audit_exports");
  // The export itself is a security-significant action — record it.
  await audit({
    actor: actorFrom(gate),
    action: "audit.export",
    details: { format, ...(category && { category }), ...(from && { from }), ...(to && { to }) },
    ip: ipFrom(req),
  });

  return exporter({ format, category, actorId, from, to });
}
