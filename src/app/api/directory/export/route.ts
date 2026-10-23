// Directory export — PDF or CSV, for any signed-in user who can read the
// directory. Two ways in:
//
//   GET  ?preset=<id>&format=pdf|csv|vcf       an admin preset, as published
//        (&via=link: from a download link's landing page, 1.15.0)
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
import { listMarkers, markersForViewer } from "@/lib/directory-markers";
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
  // The workspace's markers, read once and cut to the viewer's columns (a
  // marker on a restricted column would mark no one but still name itself
  // in the key): the preset's ids are checked against them and the renderer
  // prints from them.
  const markers = markersForViewer(await listMarkers(fields), scope.hidden);
  const markerIds = new Set(markers.map((m) => m.id));
  // A download link (1.15.0, lib/directory-export-link) names one preset and
  // says so with via=link: when that preset has since been deleted the link
  // is dead, and handing over the default preset under its name would be a
  // different file from the one the link promised.
  const viaLink = params.via === "link";
  const named = params.preset ? await getExportPreset(String(params.preset), fields, markers) : undefined;
  if (viaLink && !named) {
    return NextResponse.json(
      { error: "This download link no longer works: the export it points to was removed. Ask whoever sent it for a new link." },
      { status: 404 }
    );
  }
  const base = named ?? (await defaultExportPreset(fields, markers));

  // Overrides ride on top of the chosen preset; sanitizePreset drops anything
  // that is not a real column or option.
  const overrides: Record<string, unknown> = {};
  for (const k of [
    "columns", "group_by", "sort", "sort_dir", "sort2", "sort2_dir", "paper", "orientation", "density", "page_columns",
    "logo", "photos", "pinned_first", "page_numbers", "printed_date", "office_info", "office_columns", "zebra", "title", "subtitle", "footer_note",
    "layout", "cards_per_row", "split_by", "column_limits", "assistant_fields", "margins", "margin_custom", "markers", "name_format",
    "section_order", "section_heads",
  ]) {
    if (params[k] !== undefined) overrides[k] = params[k];
  }
  if (typeof overrides.columns === "string") overrides.columns = overrides.columns.split(",").map((s) => s.trim());
  if (typeof overrides.assistant_fields === "string") {
    overrides.assistant_fields = overrides.assistant_fields.split(",").map((s) => s.trim());
  }
  if (typeof overrides.markers === "string") overrides.markers = overrides.markers.split(",").map((s) => s.trim());
  // A marker's label is the admin's to publish, preset by preset: a viewer's
  // override may drop markers the preset prints, never add one it does not.
  if (!scope.isAdmin && overrides.markers !== undefined) {
    const listed = new Set(base.markers);
    overrides.markers = Array.isArray(overrides.markers) ? overrides.markers.filter((id) => listed.has(String(id).trim())) : [];
  }
  // The object- and array-valued options arrive as JSON in a POST body; a
  // GET may carry them JSON-encoded (a section value may hold a comma, so
  // the order is never a comma list). Anything unparseable is ignored.
  for (const k of ["column_limits", "margin_custom", "section_order"]) {
    if (typeof overrides[k] !== "string") continue;
    try {
      overrides[k] = JSON.parse(overrides[k] as string);
    } catch {
      delete overrides[k];
    }
  }
  // A section order belongs to the field it was made for: a request that
  // picks its own sections ("what I see", an ad hoc group_by) starts from
  // the field's own order unless it brings an order of its own.
  if (overrides.group_by !== undefined && overrides.section_order === undefined) overrides.section_order = [];
  for (const k of ["logo", "photos", "pinned_first", "page_numbers", "printed_date", "office_info", "zebra", "section_heads"]) {
    if (typeof overrides[k] === "string") overrides[k] = overrides[k] === "1" || overrides[k] === "true";
  }
  if (params.filter_key !== undefined || params.filter_value !== undefined) {
    overrides.filter = { key: params.filter_key, value: params.filter_value };
  }
  const sanitized = sanitizePreset({ ...base, ...overrides }, fields, base.id, markerIds);
  const columns = sanitized.columns.filter((c) => !scope.hidden.has(c));
  const preset: ExportPreset = {
    ...sanitized,
    columns: columns.length ? columns : ["name"],
    // A restricted column is blank on every row the viewer gets, the
    // assistant's included; keeping the key out of the request as well means
    // the file never asks for it.
    assistant_fields: sanitized.assistant_fields.filter((k) => !scope.hidden.has(k)),
  };

  const wanted = String(params.format ?? "pdf").toLowerCase();
  const format: "pdf" | "csv" | "vcf" = wanted === "csv" ? "csv" : wanted === "vcf" ? "vcf" : "pdf";
  const q = typeof params.q === "string" && params.q.trim() ? params.q.trim().slice(0, 80) : undefined;
  // Everyone the viewer may see is the assistant lookup: "what I see" sends
  // only the ids on screen, and an assistant off screen still carries their
  // details.
  const everyone = peopleForViewer(scope, await listPeople({ q }));
  let people = everyone;
  if (Array.isArray(params.ids)) {
    const wanted = new Set(params.ids.map(Number).filter((n) => Number.isInteger(n)));
    if (wanted.size) people = everyone.filter((p) => wanted.has(p.id));
  }

  const settings = await getAppSettings();
  const company = settings.company_name || "Company";
  const filename = exportFilename(preset, company, format);

  // Contact cards: one .vcf holding every exported person, in the export's
  // order, with each office's address and main line on its people.
  if (format === "vcf") {
    const { renderDirectoryVcf } = await import("@/lib/directory-export-vcf");
    await audit({
      actor: actorFrom(user),
      action: "directory.exported",
      details: { format, preset: preset.id, people: people.length, ...(viaLink ? { via: "link" } : {}) },
      ip: ipFrom(req),
    });
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
    details: { format, preset: preset.id, people: people.length, ad_hoc: Object.keys(overrides).length > 0, ...(viaLink ? { via: "link" } : {}) },
    ip: ipFrom(req),
  });

  // split=0 asks for one file from a preset that would otherwise zip one
  // per office; split=office (any group_by key) asks for the zip ad hoc.
  const splitParam = params.split === undefined ? undefined : String(params.split);
  const runPreset = splitParam === undefined ? preset : { ...preset, split_by: splitParam === "0" || splitParam === "" ? "" : splitParam };
  const file = await renderExportFile({ preset: sanitizePreset(runPreset, fields, preset.id, markerIds), format, people, lookup: everyone, fields, markers });
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
