import JSZip from "jszip";
import {
  createSpace,
  createDocument,
  updateDocument,
  getSpaceById,
  getSpaceBySlug,
  createAttachment,
  slugify,
} from "../db";
import { setParent } from "../doc-tree";
import { saveUpload, safeExt } from "../uploads";
import { parseNotion } from "./notion";
import { parseConfluence } from "./confluence";
import type {
  ImportSource,
  ParsedExport,
  ParsedPage,
  MigrateOptions,
  MigrateResult,
} from "./types";

export type { ImportSource, MigrateOptions, MigrateResult } from "./types";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const mimeFor = (name: string) => MIME[safeExt(name)] || "application/octet-stream";

/** Sniff the export format from the zip's contents. */
export function detectSource(zip: JSZip): ImportSource | null {
  const names = Object.values(zip.files)
    .filter((f) => !f.dir)
    .map((f) => f.name);
  const hasNotionMd = names.some((n) => /\s[0-9a-f]{32}\.md$/i.test(n));
  if (hasNotionMd) return "notion";
  const rootHtml = names.filter((n) => /\.html?$/i.test(n) && !n.includes("/"));
  const hasIndex = rootHtml.some((n) => n.toLowerCase() === "index.html");
  if (hasIndex && rootHtml.length > 1) return "confluence";
  // Fall back: a lone tree of markdown → treat as Notion-style.
  if (names.some((n) => n.toLowerCase().endsWith(".md"))) return "notion";
  if (rootHtml.length > 0) return "confluence";
  return null;
}

export async function parseExport(buffer: Buffer, override?: ImportSource): Promise<ParsedExport> {
  const zip = await JSZip.loadAsync(buffer);
  const source = override || detectSource(zip);
  if (!source) {
    throw new Error(
      "Couldn't recognize this as a Notion or Confluence export. Upload the .zip you " +
        "downloaded from Notion (Markdown & CSV) or Confluence (Export space → HTML)."
    );
  }
  return source === "notion" ? parseNotion(zip) : parseConfluence(zip);
}

/** A space slug derived from the name that isn't already taken. */
async function uniqueSpaceSlug(name: string): Promise<string> {
  const base = slugify(name) || "imported";
  if (!(await getSpaceBySlug(base))) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!(await getSpaceBySlug(candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Order pages so every parent is created before its children. */
function inCreationOrder(pages: ParsedPage[]): ParsedPage[] {
  const byKey = new Map(pages.map((p) => [p.key, p]));
  const depth = new Map<string, number>();
  const depthOf = (p: ParsedPage, guard = 0): number => {
    if (depth.has(p.key)) return depth.get(p.key)!;
    if (!p.parentKey || !byKey.has(p.parentKey) || guard > 50) {
      depth.set(p.key, 0);
      return 0;
    }
    const d = depthOf(byKey.get(p.parentKey)!, guard + 1) + 1;
    depth.set(p.key, d);
    return d;
  };
  return [...pages].sort((a, b) => depthOf(a) - depthOf(b));
}

/** Replace every occurrence of a Markdown link/image target with a new one. */
function rewriteRef(markdown: string, from: string, to: string): string {
  // Match the target inside ](...) exactly, optionally followed by a "title".
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markdown.replace(new RegExp(`\\]\\(${esc}(\\s+"[^"]*")?\\)`, "g"), `](${to}$1)`);
}

/**
 * Turn a parsed export into CompassDocs spaces, documents, nested-page
 * parenting, and attachments. Reuses the same db primitives the app uses.
 */
export async function migrate(
  buffer: Buffer,
  opts: MigrateOptions,
  importer: { id: number | null; name: string },
  override?: ImportSource
): Promise<MigrateResult> {
  const parsed = await parseExport(buffer, override);
  const zip = await JSZip.loadAsync(buffer);
  const warnings = [...parsed.warnings];

  // Resolve the target space.
  let spaceId: number;
  let spaceName: string;
  let spaceCreated = false;
  if (opts.targetSpaceId) {
    const sp = await getSpaceById(opts.targetSpaceId);
    if (!sp) throw new Error("The chosen destination space no longer exists.");
    spaceId = sp.id;
    spaceName = sp.name;
  } else {
    const name = (opts.newSpaceName || parsed.suggestedSpaceName || "Imported").trim().slice(0, 60);
    const sp = await createSpace({
      slug: await uniqueSpaceSlug(name),
      name,
      description: `Imported from ${parsed.source}.`,
    });
    spaceId = sp.id;
    spaceName = sp.name;
    spaceCreated = true;
  }

  const status = opts.publish ? "published" : "draft";
  const keyToDocId = new Map<string, number>();
  let pagesCreated = 0;
  let attachmentsCreated = 0;
  let skipped = 0;

  for (const page of inCreationOrder(parsed.pages)) {
    try {
      const doc = await createDocument({
        space_id: spaceId,
        title: page.title.slice(0, 200) || "Untitled",
        type: "knowledge",
        status,
        content: page.markdown,
        summary: "",
        tags: [],
        author: importer.name,
      });
      keyToDocId.set(page.key, doc.id);
      pagesCreated++;

      // Upload assets and rewrite their references into attachment URLs.
      let content = page.markdown;
      let changed = false;
      for (const asset of page.assets) {
        const zf = zip.file(asset.zipPath);
        if (!zf) continue;
        const buf = Buffer.from(await zf.async("uint8array"));
        const stored = await saveUpload(buf, safeExt(asset.filename));
        const att = await createAttachment({
          document_id: doc.id,
          filename: asset.filename.slice(0, 255) || "file",
          stored_name: stored,
          mime_type: mimeFor(asset.filename),
          size: buf.length,
          created_by: importer.id,
        });
        content = rewriteRef(content, asset.ref, `/api/attachments/${att.id}`);
        attachmentsCreated++;
        changed = true;
      }

      // Re-parent under the imported ancestor (setParent enforces the depth cap).
      let parentSet = false;
      if (page.parentKey && keyToDocId.has(page.parentKey)) {
        const warn = await setParent(doc.id, keyToDocId.get(page.parentKey)!);
        if (warn) warnings.push(`${page.title}: ${warn}`);
        else parentSet = true;
      }

      if (changed) {
        await updateDocument(doc.id, {
          title: doc.title,
          type: "knowledge",
          status,
          content,
          summary: "",
          tags: [],
          author: importer.name,
          versionNote: "Imported",
        });
      }
      void parentSet;
    } catch (e: any) {
      skipped++;
      warnings.push(`${page.title}: ${e?.message || "could not import"}`);
    }
  }

  return {
    source: parsed.source,
    spaceId,
    spaceName,
    spaceCreated,
    pagesCreated,
    attachmentsCreated,
    skipped,
    warnings: warnings.slice(0, 100),
  };
}

/** Lightweight preview for the UI before committing an import. */
export async function previewExport(buffer: Buffer, override?: ImportSource) {
  const parsed = await parseExport(buffer, override);
  return {
    source: parsed.source,
    suggestedSpaceName: parsed.suggestedSpaceName,
    pageCount: parsed.pages.length,
    attachmentCount: parsed.pages.reduce((n, p) => n + p.assets.length, 0),
    topLevel: parsed.pages.filter((p) => !p.parentKey).length,
    warnings: parsed.warnings.slice(0, 100),
  };
}
