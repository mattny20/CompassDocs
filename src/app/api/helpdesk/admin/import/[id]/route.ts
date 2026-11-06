// GET    /api/helpdesk/admin/import/[id] → { job }
// PUT    /api/helpdesk/admin/import/[id]  ImportMapping (partial) → { job }
// DELETE /api/helpdesk/admin/import/[id] → { ok } (discards the job and its files)
//
// Helpdesk 1.19.1, Desk settings → Import. Saving a mapping clears the dry
// run (it must run again before importing). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { discardImportJob, jobView, saveMapping } from "@/lib/helpdesk/import";
import { importErrorResponse, importGate, loadJob } from "@/lib/helpdesk/import-routes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const job = await loadJob((await params).id);
  if (job instanceof NextResponse) return job;
  return NextResponse.json({ job: await jobView(job) });
}

export async function PUT(req: Request, { params }: Ctx) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const job = await loadJob((await params).id);
  if (job instanceof NextResponse) return job;
  const body = await readJson(req, 2 * 1024 * 1024);
  if (!body) return NextResponse.json({ error: "Send the mapping as JSON." }, { status: 400 });
  try {
    return NextResponse.json({ job: await jobView(await saveMapping(job.id, body)) });
  } catch (e) {
    return importErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const job = await loadJob((await params).id);
  if (job instanceof NextResponse) return job;
  try {
    await discardImportJob(job.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return importErrorResponse(e);
  }
}
