// POST /api/helpdesk/admin/import/[id]/dry-run → { job }
//
// Helpdesk 1.19.1, Desk settings → Import: plan the whole export with the
// saved mapping and write nothing but the counts (tickets to create and
// update, contacts matched and kept, attachments, skipped rows with
// reasons). Desk capability settings.manage.
//
// 1.19.2 (agent W5, lib/helpdesk/import-check): the dry run runs in the
// background. This answers at once with the job in status "checking"; GET
// [id] shows its progress, and the person who asked hears in the bell
// when it is ready. Stop it with POST [id]/stop-check.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { jobView } from "@/lib/helpdesk/import";
import { auditCheckStarted, queueImportCheck } from "@/lib/helpdesk/import-check";
import { importErrorResponse, importGate, loadJob } from "@/lib/helpdesk/import-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const job = await loadJob((await params).id);
  if (job instanceof NextResponse) return job;
  try {
    const row = await queueImportCheck(job.id, "dry_run", gate.id);
    await auditCheckStarted(row, "dry_run", actorFrom(gate), ipFrom(req));
    return NextResponse.json({ job: await jobView(row) }, { status: 202 });
  } catch (e) {
    return importErrorResponse(e);
  }
}
