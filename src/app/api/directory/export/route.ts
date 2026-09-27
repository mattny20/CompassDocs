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
import { peopleForViewer, viewerScope } from "@/lib/directory-viewer";
import { defaultExportPreset, getExportPreset, sanitizePreset, type ExportPreset } from "@/lib/directory-export-config";
import { exportFilename } from "@/lib/directory-export";
import { renderExportFile } from "@/lib/directory-export-run";
import { getAppSettings } from "@/lib/settings-store";
import { exportRateLimited } from "@/lib/rate-limit";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";
// The renderer is Node-only (fontkit, streams); never let this route drift to
// the edge runtime.
export const runtime = "nodejs";

async function run(user: SessionUser, req: Request, params: Record<string, unknown>): Promise<Response> {
  if (exportRateLimited(String(user.id))) {
    return NextResponse.json({ error: "Too many exports — wait a minute and try again." }, { status: 429 });
  }
  // A viewer's export carries only what the viewer may see: admin-only
  // fields drop out of the registry (so out of the preset's columns) and
  // restricted contact columns are removed below.
  const scope = await viewerScope(user, await listFields());
  const fields = scope.fields;
  const base = params.preset
    ? (await getExportPreset(String(params.preset), fields)) ?? (await defaultExportPreset(fields))
    : await defaultExportPreset(fields);

  // Overrides ride on top of the chosen preset; sanitizePreset drops anything
  // that is not a real column or option.
  const overrides: Record<string, unknown> = {};
  for (const k of [
    "columns", "group_by", "sort", "sort_dir", "sort2", "sort2_dir", "paper", "orientation", "density", "page_columns",
    "logo", "photos", "pinned_first", "page_numbers", "printed_date", "office_info", "office_columns", "zebra", "title", "subtitle", "footer_note",
    "layout", "cards_per_row", "split_by",
  ]) {
    if (params[k] !== undefined) overrides[k] = params[k];
  }
  if (typeof overrides.columns === "string") overrides.columns = overrides.columns.split(",").map((s) => s.trim());
  for (const k of ["logo", "photos", "pinned_first", "page_numbers", "printed_date", "office_info", "zebra"]) {
    if (typeof overrides[k] === "string") overrides[k] = overrides[k] === "1" || overrides[k] === "true";
  }
  if (params.filter_key !== undefined || params.filter_value !== undefined) {
    overrides.filter = { key: params.filter_key, value: params.filter_value };
  }
  const sanitized = sanitizePreset({ ...base, ...overrides }, fields, base.id);
  const columns = sanitized.columns.filter((c) => !scope.hidden.has(c));
  const preset: ExportPreset = { ...sanitized, columns: columns.length ? columns : ["name"] };

  const wanted = String(params.format ?? "pdf").toLowerCase();
  const format: "pdf" | "csv" | "vcf" = wanted === "csv" ? "csv" : wanted === "vcf" ? "vcf" : "pdf";
  const q = typeof params.q === "string" && params.q.trim() ? params.q.trim().slice(0, 80) : undefined;
  let people = peopleForViewer(scope, await listPeople({ q }));
  if (Array.isArray(params.ids)) {
    const wanted = new Set(params.ids.map(Number).filter((n) => Number.isInteger(n)));
    if (wanted.size) people = people.filter((p) => wanted.has(p.id));
  }

  const settings = await getAppSettings();
  const company = settings.company_name || "Company";
  const filename = exportFilename(preset, company, format);

  // Contact cards: one .vcf holding every exported person, in the export's
  // order, with each office's address and main line on its people.
  if (format === "vcf") {
    const { renderDirectoryVcf } = await import("@/lib/directory-export-vcf");
    await audit({ actor: actorFrom(user), action: "directory.exported", details: { format, preset: preset.id, people: people.length }, ip: ipFrom(req) });
    const domain = (await getSetting("custom_domain"))?.trim();
    const text = await renderDirectoryVcf({ preset, people, fields, company, origin: domain ? `https://${domain}` : new URL(req.url).origin });
    return new Response(text, {
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  await audit({
    actor: actorFrom(user),
    action: "directory.exported",
    details: { format, preset: preset.id, people: people.length, ad_hoc: Object.keys(overrides).length > 0 },
    ip: ipFrom(req),
  });

  // split=0 asks for one file from a preset that would otherwise zip one
  // per office; split=office (any group_by key) asks for the zip ad hoc.
  const splitParam = params.split === undefined ? undefined : String(params.split);
  const runPreset = splitParam === undefined ? preset : { ...preset, split_by: splitParam === "0" || splitParam === "" ? "" : splitParam };
  const file = await renderExportFile({ preset: sanitizePreset(runPreset, fields, preset.id), format, people, fields });
  return new Response(new Uint8Array(file.body), {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.body.length),
      "Content-Disposition": `attachment; filename="${file.filename}"`,
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
