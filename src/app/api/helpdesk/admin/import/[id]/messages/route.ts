// POST /api/helpdesk/admin/import/[id]/messages (body: a CSV's bytes,
//      header x-filename) → { job }
//
// Helpdesk 1.19.1, Desk settings → Import: a CSV import's optional second
// file, one row per message keyed by ticket id. Replaces an earlier one
// and rescans. Same size limit as the upload. Desk capability settings.manage.

import { NextResponse } from "next/server";
import { attachMessagesFile, getImportSettings, jobView, saveImportUpload } from "@/lib/helpdesk/import";
import { importErrorResponse, importGate, loadJob, uploadFilename } from "@/lib/helpdesk/import-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const job = await loadJob((await params).id);
  if (job instanceof NextResponse) return job;
  const { max_upload_mb } = await getImportSettings();
  const max = max_upload_mb * 1024 * 1024;
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    return NextResponse.json({ error: `That file is larger than the ${max_upload_mb} MB limit.` }, { status: 413 });
  }
  try {
    const stored = await saveImportUpload(req.body, max, "csv");
    return NextResponse.json({ job: await jobView(await attachMessagesFile(job.id, stored, uploadFilename(req, "messages.csv"))) });
  } catch (e) {
    return importErrorResponse(e);
  }
}
