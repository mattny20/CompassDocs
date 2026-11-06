// POST /api/helpdesk/admin/import/[id]/stop-check → { job }
//
// Helpdesk 1.19.2 (agent W5, lib/helpdesk/import-check), Desk settings →
// Import: stop a dry run running in the background. The job goes back to
// the map step with no dry run; nothing was written. A rescan (new columns)
// can't be stopped (409). Audited as helpdesk.import.check_stopped. Desk
// capability settings.manage.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { jobView } from "@/lib/helpdesk/import";
import { stopImportCheck } from "@/lib/helpdesk/import-check";
import { importErrorResponse, importGate, loadJob } from "@/lib/helpdesk/import-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const job = await loadJob((await params).id);
  if (job instanceof NextResponse) return job;
  try {
    return NextResponse.json({ job: await jobView(await stopImportCheck(job.id, actorFrom(gate), ipFrom(req))) });
  } catch (e) {
    return importErrorResponse(e);
  }
}
