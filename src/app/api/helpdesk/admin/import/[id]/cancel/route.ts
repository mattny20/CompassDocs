// POST /api/helpdesk/admin/import/[id]/cancel → { job }
//
// Helpdesk 1.19.1, Desk settings → Import: stop a running import after its
// current batch (a queued one stops at once). What was imported stays, and
// Resume carries on from there. Audited as helpdesk.import.cancelled with
// the counts so far. Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { cancelImport, jobView } from "@/lib/helpdesk/import";
import { importErrorResponse, importGate, loadJob } from "@/lib/helpdesk/import-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const job = await loadJob((await params).id);
  if (job instanceof NextResponse) return job;
  try {
    const row = await cancelImport(job.id);
    const { skipped_rows: _rows, ...counts } = row.counts.result ?? { skipped_rows: [] };
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.import.cancelled",
      targetType: "helpdesk_import",
      targetId: String(job.id),
      targetLabel: job.filename,
      details: { source: job.source, counts, progress: row.progress },
      ip: ipFrom(req),
    });
    return NextResponse.json({ job: await jobView(row) });
  } catch (e) {
    return importErrorResponse(e);
  }
}
