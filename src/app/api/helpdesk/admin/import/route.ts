// GET  /api/helpdesk/admin/import → { jobs: ImportJobView[], settings, teams, agents }
// POST /api/helpdesk/admin/import?source=zoho|csv  (body: the file's bytes,
//      header x-filename) → 201 { job }
//
// Helpdesk 1.19.1, Desk settings → Import (lib/helpdesk/import). The file
// streams to the uploads volume, capped by the "Largest upload" setting
// (default 200 MB; 413 past it), then is scanned and a first mapping is
// guessed. Nothing is imported until the admin confirms after a dry run.
// Desk capability settings.manage.

import { NextResponse } from "next/server";
import { hq } from "@/lib/helpdesk/db-core";
import {
  createImportJob,
  getImportSettings,
  jobView,
  listImportJobs,
  saveImportUpload,
} from "@/lib/helpdesk/import";
import { importErrorResponse, importGate, uploadFilename } from "@/lib/helpdesk/import-routes";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const [jobs, settings, teams, agents] = await Promise.all([
    listImportJobs(10),
    getImportSettings(),
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, name"),
    hq<{ id: number; name: string; email: string }>(
      `SELECT DISTINCT u.id, COALESCE(NULLIF(u.name, ''), u.username) AS name, u.email
         FROM users u JOIN hd_team_members m ON m.user_id = u.id
        WHERE u.status = 'active' ORDER BY name LIMIT 2000`
    ),
  ]);
  return NextResponse.json({ jobs: await Promise.all(jobs.map(jobView)), settings, teams, agents });
}

export async function POST(req: Request) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const source = new URL(req.url).searchParams.get("source");
  if (source !== "zoho" && source !== "csv") return NextResponse.json({ error: "Choose Zoho Desk or CSV." }, { status: 400 });
  const { max_upload_mb } = await getImportSettings();
  const max = max_upload_mb * 1024 * 1024;
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    return NextResponse.json({ error: `That file is larger than the ${max_upload_mb} MB limit.` }, { status: 413 });
  }
  try {
    const filename = uploadFilename(req, source === "zoho" ? "zoho-desk-export.zip" : "tickets.csv");
    const stored = await saveImportUpload(req.body, max, filename.toLowerCase().endsWith(".zip") ? "zip" : "csv");
    const job = await createImportJob({ source, filename, stored, actor: { id: gate.id, name: gate.name || gate.username } });
    return NextResponse.json({ job: await jobView(job) }, { status: 201 });
  } catch (e) {
    return importErrorResponse(e);
  }
}
