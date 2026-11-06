// POST /api/helpdesk/admin/import/[id]/dry-run → { job }
//
// Helpdesk 1.19.1, Desk settings → Import: plan the whole export with the
// saved mapping and write nothing but the counts (tickets to create and
// update, contacts matched and kept, attachments, skipped rows with
// reasons). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { dryRunJob, jobView } from "@/lib/helpdesk/import";
import { importErrorResponse, importGate, loadJob } from "@/lib/helpdesk/import-routes";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const job = await loadJob((await params).id);
  if (job instanceof NextResponse) return job;
  try {
    return NextResponse.json({ job: await jobView(await dryRunJob(job.id)) });
  } catch (e) {
    return importErrorResponse(e);
  }
}
