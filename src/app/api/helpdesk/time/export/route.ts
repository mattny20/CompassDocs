// GET /api/helpdesk/time/export?from=YYYY-MM-DD&to=YYYY-MM-DD&team=1,2&agent=5&request_type=3&category=Hardware
// The logged time as CSV (one row per entry, newest first), in the caller's queue scope: every team, or
// their teams' tickets, tickets assigned to them and their own entries. Dates are the helpdesk's zone.
// Helpdesk 1.19.1 (agent V8). tickets.export. Audited helpdesk.time.exported.

import { NextResponse } from "next/server";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { helpdeskTimezone } from "@/lib/helpdesk/tickets";
import { auditTime, exportTimeCsv, type TimeExportFilters } from "@/lib/helpdesk/time";
import { parseIsoDate } from "@/lib/helpdesk/recurring-shared";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function ids(raw: string | null): number[] | undefined | null {
  if (!raw) return undefined;
  const out = raw.split(",").map((s) => Number(s.trim()));
  return out.every((n) => Number.isInteger(n) && n > 0 && n < 2 ** 31) && out.length <= 50 ? out : null;
}

export async function GET(req: Request) {
  const gate = await hdCapGate("tickets.export");
  if (gate instanceof NextResponse) return gate;
  const q = new URL(req.url).searchParams;
  const f: TimeExportFilters = {};
  for (const k of ["from", "to"] as const) {
    const v = q.get(k);
    if (v && (!DATE.test(v) || !parseIsoDate(v))) return NextResponse.json({ error: `${k === "from" ? "From" : "To"} is a date as YYYY-MM-DD.` }, { status: 400 });
    if (v) f[k] = v;
  }
  for (const k of ["team", "agent", "request_type"] as const) {
    const v = ids(q.get(k));
    if (v === null) return NextResponse.json({ error: `Unknown ${k.replace("_", " ")} list.` }, { status: 400 });
    if (v) f[k] = v;
  }
  const cat = q.getAll("category").map((s) => s.slice(0, 80)).slice(0, 50);
  if (cat.length) f.category = cat;
  const { csv, rows } = await exportTimeCsv(gate, f, await helpdeskTimezone());
  await auditTime(req, gate, "helpdesk.time.exported", { type: "helpdesk_time" }, { filters: f, rows });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="helpdesk-time-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
