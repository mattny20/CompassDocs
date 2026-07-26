import JSZip from "jszip";
import type { ParsedExport, ParsedPage, ParsedAsset } from "./types";

// Notion "Export as Markdown & CSV" adapter.
//
// Notion writes one `<Title> <32-hex-id>.md` per page. A page that has children
// also gets a sibling folder `<Title> <32-hex-id>/` holding the child `.md`
// files and any images/attachments. Markdown links to those assets are
// URL-encoded relative paths. Database exports add `.csv` files (skipped) plus
// a folder of row pages (imported as normal pages).

const NOTION_ID = /\s*[0-9a-f]{32}$/i; // trailing space + 32 hex, before extension
const HEX_IN_PATH = / [0-9a-f]{32}(?=[/.]|$)/gi;

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function dirName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/** Strip Notion's hex id from a single path segment's title. */
function cleanTitle(nameNoExt: string): string {
  return decodeURIComponent(nameNoExt).replace(NOTION_ID, "").trim();
}

export async function parseNotion(zip: JSZip): Promise<ParsedExport> {
  const warnings: string[] = [];
  const all = Object.values(zip.files).filter((f) => !f.dir);
  const mdFiles = all
    .map((f) => f.name)
    .filter((n) => n.toLowerCase().endsWith(".md"))
    .sort();
  const zipPaths = new Set(all.map((f) => f.name));

  const csvCount = all.filter((f) => f.name.toLowerCase().endsWith(".csv")).length;
  if (csvCount > 0) {
    warnings.push(
      `${csvCount} Notion database CSV file${csvCount === 1 ? "" : "s"} were skipped; ` +
        `the individual database rows are imported as pages.`
    );
  }

  const pages: ParsedPage[] = [];
  for (const path of mdFiles) {
    const raw = await zip.file(path)!.async("string");
    const nameNoExt = baseName(path).replace(/\.md$/i, "");

    // Parent: a child page `Dir <id>/Child <id2>.md` sits under `Dir <id>.md`.
    const dir = dirName(path);
    const parentMd = dir ? `${dir}.md` : "";
    const parentKey = parentMd && zipPaths.has(parentMd) ? parentMd : null;

    // Title from the first H1 (Notion's own title), else the cleaned filename.
    let markdown = raw.replace(/^﻿/, "");
    let title = cleanTitle(nameNoExt);
    const h1 = markdown.match(/^\s*#\s+(.+?)\s*$/m);
    if (h1 && markdown.slice(0, (h1.index ?? 0)).trim() === "") {
      title = h1[1].trim();
      // Drop the leading H1 (title is stored separately) and one blank line.
      markdown = markdown.slice((h1.index ?? 0) + h1[0].length).replace(/^\s*\n/, "");
    }
    if (!title) title = "Untitled";

    // Collect referenced assets that resolve to files inside the zip.
    const assets: ParsedAsset[] = [];
    const seen = new Set<string>();
    const refRe = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(markdown))) {
      const ref = m[1];
      if (/^[a-z]+:\/\//i.test(ref) || ref.startsWith("#") || ref.startsWith("mailto:")) continue;
      const resolved = resolveRelative(dir, ref);
      if (resolved && zipPaths.has(resolved) && !seen.has(ref)) {
        seen.add(ref);
        assets.push({ ref, zipPath: resolved, filename: decodeURIComponent(baseName(resolved)) });
      }
    }

    pages.push({ key: path, parentKey, title, markdown: markdown.trim() + "\n", assets });
  }

  // Suggested space name: the common top-level folder, cleaned of Notion ids.
  let suggested = "Imported from Notion";
  const top = mdFiles[0]?.split("/")[0];
  if (top && mdFiles.every((p) => p.startsWith(top + "/"))) {
    const c = cleanTitle(top.replace(/\.md$/i, ""));
    if (c) suggested = c;
  }

  return { source: "notion", suggestedSpaceName: suggested, pages, warnings };
}

/** Resolve a URL-encoded relative ref against a zip directory. */
function resolveRelative(dir: string, ref: string): string | null {
  let p = decodeURIComponent(ref.split("#")[0].split("?")[0]);
  if (!p) return null;
  const parts = (dir ? dir.split("/") : []).concat(p.split("/"));
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

// Exported for reuse/testing: strip Notion ids from any string.
export function stripNotionIds(s: string): string {
  return s.replace(HEX_IN_PATH, "");
}
