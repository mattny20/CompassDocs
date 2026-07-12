import JSZip from "jszip";
import matter from "gray-matter";
import {
  exportDocuments,
  listSpaces,
  getSpaceBySlug,
  createSpace,
  getDocumentBySpaceAndSlug,
  createDocument,
  updateDocument,
  slugify,
} from "./db";
import type { DocType, DocStatus } from "./types";

// Content-level import/export: the knowledge base as a zip of Markdown files
// with YAML front-matter, plus a manifest.json describing the spaces. This is a
// portable, human-readable backup of document *content* (not a full DB dump —
// that's a separate feature).

const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];
const STATUSES: DocStatus[] = ["draft", "published"];

function normalizeTags(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
  if (typeof input === "string")
    return input
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

/** Build a zip of the whole knowledge base. Returns a Node Buffer. */
export async function buildExportZip(): Promise<Buffer> {
  const [docs, spaces] = await Promise.all([exportDocuments(), listSpaces()]);
  const zip = new JSZip();
  const usedPaths = new Set<string>();
  const index: { path: string; title: string; space: string; status: string }[] = [];

  for (const d of docs) {
    let path = `documents/${d.space_slug}/${d.slug || "untitled"}.md`;
    if (usedPaths.has(path)) path = `documents/${d.space_slug}/${d.slug || "untitled"}-${d.id}.md`;
    usedPaths.add(path);

    const body = matter.stringify(d.content || "", {
      title: d.title,
      type: d.type,
      status: d.status,
      space: d.space_slug,
      space_name: d.space_name,
      tags: d.tags,
      summary: d.summary,
      author: d.author,
      created_at: d.created_at,
      updated_at: d.updated_at,
    });
    zip.file(path, body);
    index.push({ path, title: d.title, space: d.space_slug, status: d.status });
  }

  const manifest = {
    app: "CompassDocs",
    format: 1,
    exported_at: new Date().toISOString(),
    spaces: spaces.map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description,
      icon: s.icon,
      color: s.color,
    })),
    documents: index,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  return zip.generateAsync({ type: "nodebuffer" });
}

export interface ImportResult {
  created: number;
  updated: number;
  spacesCreated: number;
  skipped: number;
  errors: string[];
}

/**
 * Import documents from an export zip (or any zip of front-matter Markdown).
 * Documents are matched to existing ones by (space, title-slug) and updated in
 * place, or created. Missing spaces are created (using manifest metadata when
 * present). Returns a summary.
 */
export async function importFromZip(buffer: Buffer, importerName: string): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(buffer);
  const res: ImportResult = { created: 0, updated: 0, spacesCreated: 0, skipped: 0, errors: [] };

  // Optional manifest → nice space names/icons/colours.
  const manifestSpaces: Record<string, any> = {};
  const mf = zip.file("manifest.json");
  if (mf) {
    try {
      const m = JSON.parse(await mf.async("string"));
      for (const s of m?.spaces ?? []) if (s?.slug) manifestSpaces[s.slug] = s;
    } catch {
      // Ignore a malformed manifest; front-matter still carries what we need.
    }
  }

  const spaceCache = new Map<string, number>();
  async function resolveSpace(rawSlug: string, nameHint?: string): Promise<number> {
    const slug = slugify(rawSlug) || "imported";
    const cached = spaceCache.get(slug);
    if (cached) return cached;
    let sp = await getSpaceBySlug(slug);
    if (!sp) {
      const meta = manifestSpaces[slug] || manifestSpaces[rawSlug] || {};
      sp = await createSpace({
        slug,
        name: meta.name || nameHint || rawSlug || slug,
        description: meta.description,
        icon: meta.icon,
        color: meta.color,
      });
      res.spacesCreated++;
    }
    spaceCache.set(slug, sp.id);
    return sp.id;
  }

  const mdFiles = Object.values(zip.files).filter(
    (f) => !f.dir && f.name.toLowerCase().endsWith(".md")
  );

  for (const f of mdFiles) {
    try {
      const parsed = matter(await f.async("string"));
      const data: any = parsed.data || {};
      const title = String(data.title || "").trim();
      if (!title) {
        res.skipped++;
        res.errors.push(`${f.name}: missing title`);
        continue;
      }

      // Space: front-matter `space`, else the folder under documents/.
      let spaceSlug = String(data.space || "").trim();
      if (!spaceSlug) {
        const m = f.name.match(/documents\/([^/]+)\//);
        spaceSlug = m ? m[1] : "imported";
      }
      const spaceId = await resolveSpace(spaceSlug, data.space_name);

      const type: DocType = TYPES.includes(data.type) ? data.type : "knowledge";
      const status: DocStatus = STATUSES.includes(data.status) ? data.status : "draft";
      const tags = normalizeTags(data.tags);
      const content = parsed.content ?? "";
      const summary = String(data.summary || "").trim();
      const author = String(data.author || "").trim() || importerName;

      // Match how createDocument slugs, so re-importing updates in place.
      const docSlug = slugify(title) || "untitled";
      const existing = await getDocumentBySpaceAndSlug(spaceId, docSlug);

      if (existing) {
        await updateDocument(existing.id, {
          title,
          type,
          status,
          content,
          summary,
          tags,
          author,
          versionNote: "Imported",
        });
        res.updated++;
      } else {
        await createDocument({
          space_id: spaceId,
          title,
          type,
          status,
          content,
          summary,
          tags,
          author,
        });
        res.created++;
      }
    } catch (e: any) {
      res.skipped++;
      res.errors.push(`${f.name}: ${e?.message || "parse error"}`);
    }
  }

  return res;
}
