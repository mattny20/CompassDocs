import "server-only";

// One place that turns a preset and a set of people into a file: the export
// route (a click) and the scheduler (an email) both call it, so a PDF that
// arrives by email is the PDF the button makes. Handles the logo, office
// blocks, the who's-who photos, and "one file per office" as a zip.

import JSZip from "jszip";
import { getSetting } from "./db";
import { personPhotoLargeMap, type DirectoryField, type DirectoryPerson } from "./directory";
import { groupPeople } from "./directory-display";
import type { ExportPreset } from "./directory-export-config";
import { exportFilename, renderDirectoryCsv, renderDirectoryPdf } from "./directory-export";
import { getOfficeConfig } from "./directory-offices-store";
import { getAppSettings } from "./settings-store";
import { formatDate } from "./format";
import { uploadReadStream } from "./uploads";

const RASTER_LOGO = /^image\/(png|jpeg)$/;

/** The workspace logo as a data: URL when it is a format the PDF can draw. */
export async function logoDataUrl(): Promise<string | null> {
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

export interface ExportFile {
  filename: string;
  mime: string;
  body: Buffer;
  /** How many files a zip holds; 1 otherwise. */
  parts: number;
}

export async function renderExportFile(opts: {
  preset: ExportPreset;
  format: "pdf" | "csv";
  people: DirectoryPerson[];
  fields: DirectoryField[];
  /** Ignore the preset's split and make one file. */
  split?: boolean;
}): Promise<ExportFile> {
  const { preset, format, people, fields } = opts;
  const settings = await getAppSettings();
  const company = settings.company_name || "Company";
  const printedOn = formatDate(new Date().toISOString(), settings);
  const [logo, offices, photosLarge] = await Promise.all([
    format === "pdf" && preset.logo ? logoDataUrl() : Promise.resolve(null),
    format === "pdf" && preset.office_info ? getOfficeConfig() : Promise.resolve(undefined),
    format === "pdf" && preset.layout === "cards" && preset.photos ? personPhotoLargeMap(people.map((p) => p.id)) : Promise.resolve(undefined),
  ]);
  const one = async (p: ExportPreset, subset: DirectoryPerson[]): Promise<Buffer> =>
    format === "csv"
      ? Buffer.from(renderDirectoryCsv({ preset: p, people: subset, fields, company }), "utf8")
      : renderDirectoryPdf({ preset: p, people: subset, fields, company, logo, printedOn, offices, photosLarge });

  const splitField = (opts.split ?? true) && preset.split_by ? fields.find((f) => f.key === preset.split_by && f.group_by) : undefined;
  if (!splitField) {
    return { filename: exportFilename(preset, company, format), mime: format === "csv" ? "text/csv; charset=utf-8" : "application/pdf", body: await one(preset, people), parts: 1 };
  }

  // One file per value of the field, each a full document of its own with
  // the value in its title, zipped. The split field's own filter is dropped
  // so the groups come from everyone the preset covers.
  const zip = new JSZip();
  const base = exportFilename(preset, company, format).replace(/\.(pdf|csv)$/, "");
  const groups = groupPeople(people.filter((p) => p.hidden !== 1), splitField);
  const used = new Set<string>();
  let parts = 0;
  for (const g of groups) {
    if (!g.members.length) continue;
    const label = g.key ? g.label : `No ${splitField.label.toLowerCase()}`;
    let name = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "other";
    while (used.has(name)) name = `${name}-${parts + 1}`;
    used.add(name);
    const title = `${preset.title || `${company} directory`} — ${label}`;
    const body = await one({ ...preset, title, filter: null, split_by: "" }, g.members);
    zip.file(`${base}-${name}.${format}`, body);
    parts++;
  }
  const body = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { filename: `${base}-by-${splitField.key}.zip`, mime: "application/zip", body, parts };
}
