// Most documents open with `# Title` — the same words the masthead already
// shows 350px higher, in a larger size. On the three reading surfaces (the
// document page, the share page, the public document page) that first
// heading is dropped from the rendered body when, and only when, it matches
// the document's title. Pure mdast; isomorphic.
//
// The match is loose (case, whitespace and punctuation ignored) so "Production
// Deployment SOP" == "# Production deployment SOP". Only the FIRST block is
// considered, and only an H1: a document that uses H1s as real sections keeps
// every one of them, and an H1 further down is never touched.

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
}

function textOf(node: any): string {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

/** True when `text` is the document's title, loosely. */
export function sameTitle(text: string, title: string): boolean {
  const a = norm(text);
  return a !== "" && a === norm(title);
}

/** Remark plugin factory: drop a leading H1 that repeats `title`. */
export function remarkDropTitle(title: string) {
  return () => (tree: any) => {
    dropLeadingTitle(tree, title);
  };
}

/** The plugin's work, exposed for tests: mutates `tree`, returns whether it dropped. */
export function dropLeadingTitle(tree: any, title: string): boolean {
  if (!title || !Array.isArray(tree?.children)) return false;
  const first = tree.children[0];
  if (!first || first.type !== "heading" || first.depth !== 1) return false;
  if (!sameTitle(textOf(first), title)) return false;
  tree.children.shift();
  return true;
}
