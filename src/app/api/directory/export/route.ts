// Directory export — PDF or CSV, for any signed-in user who can read the
// directory. Two ways in:
//
//   GET  ?preset=<id>&format=pdf|csv           an admin preset, as published
//   POST { preset?, format?, ids?, ...overrides } "export what I see": the
//        directory page sends the ids it is showing and the columns / grouping
//        / sort it has on screen, and the file matches the screen.
//
// Overrides never widen what a person can see: hidden people are dropped in
// the data layer whatever ids arrive, and the preset options only shape the
// page. Rate-limited per user because rendering costs real CPU.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getSetting } from "@/lib/db";
import { listFields, listPeople } from "@/lib/directory";
import { defaultExportPreset, getExportPreset, sanitizePreset, type ExportPreset } from "@/lib/directory-export-config";
import { exportFilename, renderDirectoryCsv, renderDirectoryPdf } from "@/lib/directory-export";
import { getOfficeConfig } from "@/lib/directory-offices-store";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";
import { uploadReadStream } from "@/lib/uploads";
import { exportRateLimited } from "@/lib/rate-limit";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";
// The renderer is Node-only (fontkit, streams); never let this route drift to
// the edge runtime.
export const runtime = "nodejs";

const RASTER_LOGO = /^image\/(png|jpeg)$/;

/** The workspace logo as a data: URL when it is a format the PDF can draw. */
async function logoDataUrl(): Promise<string | null> {
  const [file, mime] = await Promise.all([getSetting("logo_file"), getSetting("logo_mime")]);
  if (!file || !mime || !RASTER_LOGO.test(mime)) return null;
  const stream = uploadReadStream(file);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  try {
    for await (const c of stream) chunks.push(c as Buffer);
  } catch {
    return null;
  }
  const buf = Buffer.concat(chunks);
  if (buf.length === 0 || buf.length > 1024 * 1024) return null;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function run(user: SessionUser, req: Request, params: Record<string, unknown>): Promise<Response> {
  if (exportRateLimited(String(user.id))) {
    return NextResponse.json({ error: "Too many exports — wait a minute and try again." }, { status: 429 });
  }
  const fields = await listFields();
  const base = params.preset
    ? (await getExportPreset(String(params.preset), fields)) ?? (await defaultExportPreset(fields))
    : await defaultExportPreset(fields);

  // Overrides ride on top of the chosen preset; sanitizePreset drops anything
  // that is not a real column or option.
  const overrides: Record<string, unknown> = {};
  for (const k of [
    "columns", "group_by", "sort", "sort_dir", "paper", "orientation", "density",
    "logo", "photos", "pinned_first", "page_numbers", "printed_date", "office_info", "title", "subtitle", "footer_note",
  ]) {
    if (params[k] !== undefined) overrides[k] = params[k];
  }
  if (typeof overrides.columns === "string") overrides.columns = overrides.columns.split(",").map((s) => s.trim());
  for (const k of ["logo", "photos", "pinned_first", "page_numbers", "printed_date", "office_info"]) {
    if (typeof overrides[k] === "string") overrides[k] = overrides[k] === "1" || overrides[k] === "true";
  }
  if (params.filter_key !== undefined || params.filter_value !== undefined) {
    overrides.filter = { key: params.filter_key, value: params.filter_value };
  }
  const preset: ExportPreset = sanitizePreset({ ...base, ...overrides }, fields, base.id);

  const format = String(params.format ?? "pdf").toLowerCase() === "csv" ? "csv" : "pdf";
  const q = typeof params.q === "string" && params.q.trim() ? params.q.trim().slice(0, 80) : undefined;
  let people = await listPeople({ q });
  if (Array.isArray(params.ids)) {
    const wanted = new Set(params.ids.map(Number).filter((n) => Number.isInteger(n)));
    if (wanted.size) people = people.filter((p) => wanted.has(p.id));
  }

  const settings = await getAppSettings();
  const company = settings.company_name || "Company";
  const filename = exportFilename(preset, company, format);

  await audit({
    actor: actorFrom(user),
    action: "directory.exported",
    details: { format, preset: preset.id, people: people.length, ad_hoc: Object.keys(overrides).length > 0 },
    ip: ipFrom(req),
  });

  if (format === "csv") {
    const csv = renderDirectoryCsv({ preset, people, fields, company });
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  const pdf = await renderDirectoryPdf({
    preset,
    people,
    fields,
    company,
    logo: preset.logo ? await logoDataUrl() : null,
    printedOn: formatDate(new Date().toISOString(), settings),
    offices: preset.office_info ? await getOfficeConfig() : undefined,
  });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(req: Request) {
  const gate = await apiGuard("viewer", "directory.read");
  if (gate instanceof NextResponse) return gate;
  const params: Record<string, unknown> = {};
  for (const [k, v] of new URL(req.url).searchParams) params[k] = v;
  return run(gate as SessionUser, req, params);
}

export async function POST(req: Request) {
  const gate = await apiGuard("viewer", "directory.read");
  if (gate instanceof NextResponse) return gate;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  return run(gate as SessionUser, req, body && typeof body === "object" ? body : {});
}
