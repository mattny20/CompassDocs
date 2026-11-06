// GET /api/helpdesk/admin/import/[id]/skipped?of=dry_run|result → text/csv
//
// Helpdesk 1.19.1, Desk settings → Import: the rows the dry run (or the
// import) skipped, with the file, line, ticket id and reason. Desk
// capability settings.manage.

import { NextResponse } from "next/server";
import { skippedCsv } from "@/lib/helpdesk/import";
import { importGate, loadJob } from "@/lib/helpdesk/import-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const job = await loadJob((await params).id);
  if (job instanceof NextResponse) return job;
  const of = new URL(req.url).searchParams.get("of") === "result" ? "result" : "dry_run";
  return new NextResponse("﻿" + skippedCsv(job, of), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="import-${job.id}-skipped-rows.csv"`,
      "cache-control": "no-store",
    },
  });
}
