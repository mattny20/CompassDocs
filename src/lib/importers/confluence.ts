import JSZip from "jszip";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { toHtml } from "hast-util-to-html";
import { visit } from "unist-util-visit";
import type { ParsedExport, ParsedPage, ParsedAsset } from "./types";

// Confluence "Export space > HTML" adapter.
//
// The export is a zip of one HTML file per page at the root, an `index.html`
// listing every page as a nested tree (the source of hierarchy), an
// `attachments/<pageId>/…` folder, and `images/` + `styles/` chrome. We take
// each page's `#main-content` body, convert it to Markdown, and rebuild the
// page tree from index.html.

const htmlToMd = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify, { bullet: "-", fences: true, rule: "-" });

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Parse a full HTML document string into a hast tree. */
function parseDoc(html: string) {
  return unified().use(rehypeParse, { fragment: false }).parse(html);
}

/** Find the element carrying a given id, returning its child nodes. */
function findById(tree: any, id: string): any[] | null {
  let hit: any[] | null = null;
  visit(tree, "element", (node: any) => {
    if (!hit && node.properties && node.properties.id === id) hit = node.children;
  });
  return hit;
}

function firstTag(tree: any, tag: string): any | null {
  let hit: any = null;
  visit(tree, "element", (node: any) => {
    if (!hit && node.tagName === tag) hit = node;
  });
  return hit;
}

function textOf(node: any): string {
  let s = "";
  visit(node, "text", (t: any) => {
    s += t.value;
  });
  return s.trim();
}

/** Walk the nested <ul>/<li> tree in index.html into href → parentHref links. */
function parseTree(ul: any, parentHref: string | null, out: Map<string, string | null>) {
  if (!ul || !ul.children) return;
  for (const li of ul.children) {
    if (li.type !== "element" || li.tagName !== "li") continue;
    const a = firstTag(li, "a");
    const href = a?.properties?.href ? baseName(String(a.properties.href).split("#")[0]) : null;
    if (href) out.set(href, parentHref);
    const childUl = (li.children || []).find(
      (c: any) => c.type === "element" && c.tagName === "ul"
    );
    if (childUl) parseTree(childUl, href, out);
  }
}

export async function parseConfluence(zip: JSZip): Promise<ParsedExport> {
  const warnings: string[] = [];
  const all = Object.values(zip.files).filter((f) => !f.dir);
  const zipPaths = new Set(all.map((f) => f.name));

  // Page HTML files live at the export root (not under styles/ or attachments/).
  const pageFiles = all
    .map((f) => f.name)
    .filter(
      (n) =>
        /\.html?$/i.test(n) &&
        !n.includes("/") &&
        baseName(n).toLowerCase() !== "index.html"
    )
    .sort();

  // Hierarchy from index.html's nested list, keyed by page filename.
  const parentByHref = new Map<string, string | null>();
  const indexFile = all.find((f) => baseName(f.name).toLowerCase() === "index.html");
  if (indexFile) {
    try {
      const tree = parseDoc(await zip.file(indexFile.name)!.async("string"));
      const main = findById(tree, "main-content");
      const container = main ? { type: "root", children: main } : tree;
      const ul = firstTag(container, "ul");
      parseTree(ul, null, parentByHref);
    } catch {
      warnings.push("Could not read index.html; pages were imported without their hierarchy.");
    }
  } else {
    warnings.push("No index.html found; pages were imported without their hierarchy.");
  }

  let spaceName = "Imported from Confluence";
  const pages: ParsedPage[] = [];

  for (const path of pageFiles) {
    try {
      const html = await zip.file(path)!.async("string");
      const tree = parseDoc(html);

      // Title: <title> is "Space Name : Page Title"; fall back to the H1.
      let title = "";
      const titleEl = firstTag(tree, "title");
      if (titleEl) {
        const t = textOf(titleEl);
        const parts = t.split(" : ");
        if (parts.length > 1) {
          spaceName = parts[0].trim() || spaceName;
          title = parts.slice(1).join(" : ").trim();
        } else {
          title = t;
        }
      }
      if (!title) {
        const h1 = firstTag(tree, "h1");
        title = h1 ? textOf(h1) : baseName(path).replace(/\.html?$/i, "");
      }

      // Body: #main-content, else the wiki-content div, else <body>.
      let bodyChildren = findById(tree, "main-content");
      if (!bodyChildren) {
        const body = firstTag(tree, "body");
        bodyChildren = body ? body.children : tree.children;
      }
      const innerHtml = toHtml(bodyChildren as any);
      const md = String(await htmlToMd.process(innerHtml));

      // Assets: local refs (attachments/…, images/…) that exist in the zip.
      const assets: ParsedAsset[] = [];
      const seen = new Set<string>();
      const refRe = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
      let m: RegExpExecArray | null;
      while ((m = refRe.exec(md))) {
        const ref = m[1];
        if (/^[a-z]+:\/\//i.test(ref) || ref.startsWith("#") || ref.startsWith("mailto:")) continue;
        const resolved = decodeURIComponent(ref.split("#")[0].split("?")[0]).replace(/^\.?\//, "");
        if (zipPaths.has(resolved) && !seen.has(ref)) {
          seen.add(ref);
          assets.push({ ref, zipPath: resolved, filename: decodeURIComponent(baseName(resolved)) });
        }
      }

      pages.push({
        key: baseName(path),
        parentKey: parentByHref.get(baseName(path)) ?? null,
        title: title || "Untitled",
        markdown: md.trim() + "\n",
        assets,
      });
    } catch (e: any) {
      warnings.push(`${baseName(path)}: ${e?.message || "could not convert"}`);
    }
  }

  return { source: "confluence", suggestedSpaceName: spaceName, pages, warnings };
}
