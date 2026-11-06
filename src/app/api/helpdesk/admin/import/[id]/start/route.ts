// POST /api/helpdesk/admin/import/[id]/start → 202 { job }
//
// Helpdesk 1.19.1, Desk settings → Import: start the import after its dry
// run, or resume a stopped or failed one from its last committed batch. It
// runs in the background (the periodic sweep resumes it after a restart).
// Audited as helpdesk.import.started with the dry run's counts (resumed:
// true on a resume). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { jobView, runImportInBackground, startImport } from "@/lib/helpdesk/import";
import { importErrorResponse, importGate, loadJob } from "@/lib/helpdesk/import-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const job = await loadJob((await params).id);
  if (job instanceof NextResponse) return job;
  try {
    const resumed = job.status === "cancelled" || job.status === "failed";
    const queued = await startImport(job.id);
    const { skipped_rows: _rows, ...counts } = queued.counts.dry_run ?? { skipped_rows: [] };
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.import.started",
      targetType: "helpdesk_import",
      targetId: String(job.id),
      targetLabel: job.filename,
      details: { source: job.source, resumed, counts },
      ip: ipFrom(req),
    });
    runImportInBackground(job.id);
    return NextResponse.json({ job: await jobView(queued) }, { status: 202 });
  } catch (e) {
    return importErrorResponse(e);
  }
}
