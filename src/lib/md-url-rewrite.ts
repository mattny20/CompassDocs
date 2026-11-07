// A rehype step that passes every address a rendered document carries
// through one function (1.19.4, the customer portal help centre's links).
// It runs on the parsed tree, after the sanitiser, so every form an author
// can write reaches it the same way: inline and reference links, autolinks,
// angle-bracket destinations, images, raw HTML (quoted or not) and the
// ::video / ::embed blocks' data-src and data-poster. Pure and dependency
// free: MarkdownView takes it as `rewriteUrl`.
//
// The function answers the address to keep, or null to drop it: a link
// keeps its text, and an image, a video or an embed whose source is
// dropped goes entirely. srcset is always dropped (each of its addresses
// would need the same check).

export type UrlRewrite = (url: string, at: { tagName: string; attribute: string }) => string | null;

/** hast property names that hold one address (camelCase as the sanitiser leaves them; the raw spelling too). */
const URL_PROPERTIES = ["href", "src", "poster", "cite", "dataSrc", "dataPoster", "data-src", "data-poster"] as const;
/** Properties dropped outright. */
const DROPPED = ["srcSet", "srcset", "data-srcset"] as const;

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Whether losing this attribute makes the element pointless (it goes, not just the attribute). */
function removesElement(tagName: string, attribute: string, props: Record<string, unknown>): boolean {
  if (attribute === "src" && (tagName === "img" || tagName === "video" || tagName === "source" || tagName === "iframe")) return true;
  if ((attribute === "dataSrc" || attribute === "data-src") && tagName === "div") {
    const cls = props.className;
    const list = Array.isArray(cls) ? cls.map(String) : typeof cls === "string" ? cls.split(/\s+/) : [];
    return list.includes("md-video") || list.includes("md-embed");
  }
  return false;
}

export function rehypeRewriteUrls(rewrite: UrlRewrite) {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.filter((child) => {
        if (child.type !== "element" || !child.tagName) {
          walk(child);
          return true;
        }
        const props = (child.properties ??= {});
        for (const key of DROPPED) delete props[key];
        for (const key of URL_PROPERTIES) {
          const value = props[key];
          if (value === undefined || value === null) continue;
          const next = typeof value === "string" ? rewrite(value, { tagName: child.tagName, attribute: key }) : null;
          if (next === null) {
            if (removesElement(child.tagName, key, props)) return false;
            delete props[key];
          } else {
            props[key] = next;
          }
        }
        walk(child);
        return true;
      });
    };
    walk(tree);
  };
}
