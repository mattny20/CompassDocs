// Shared rules for rendering the app's Markdown, which may carry a small
// amount of inline HTML written by the rich editor (underline, text alignment,
// indent, email buttons, spacers). Everything raw is sanitized against this
// schema, then inline styles are filtered to an explicit property whitelist —
// so stored content can never inject scripts, event handlers, or arbitrary CSS.
// Used by the in-app Markdown view and the newsletter email renderer.

import { defaultSchema } from "rehype-sanitize";

type Schema = typeof defaultSchema;

// The default `a` rules already carry a className allowlist (footnote
// back-refs); the sanitizer honors the FIRST className entry it finds, so our
// button class must be merged into that entry rather than appended as a new one.
const A_ATTRS = (defaultSchema.attributes?.a ?? []).map((entry) =>
  Array.isArray(entry) && entry[0] === "className" ? [...entry, "email-btn"] : entry
);

// Rich document blocks (tabs, callouts, accordions, embeds) arrive as
// md-* divs from the remarkDocBlocks directive plugin; MarkdownView maps
// them to components. Their data-* payloads (titles, URLs) are re-validated
// by those components before anything is embedded.
const DOC_BLOCK_CLASSES = [
  "md-callout",
  "md-callout-note",
  "md-callout-tip",
  "md-callout-warning",
  "md-callout-danger",
  "md-callout-info",
  "md-details",
  "md-tabs",
  "md-tab",
  "md-video",
  "md-embed",
];

export const MD_SANITIZE_SCHEMA: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "u", "div", "span"],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "style"],
    a: A_ATTRS as any,
    div: [
      ["className", "nl-spacer", "nl-panel", ...DOC_BLOCK_CLASSES],
      "dataTitle",
      "dataSrc",
      "dataHeight",
    ],
    table: [...(defaultSchema.attributes?.table ?? []), ["className", "nl-borderless"]],
  },
};

// property -> allowed value pattern. Anything else is dropped.
const STYLE_WHITELIST: [RegExp, RegExp][] = [
  [/^text-align$/, /^(left|center|right|justify)$/],
  [/^margin-left$/, /^\d{1,3}px$/],
  [/^height$/, /^\d{1,3}px$/],
  [/^width$/, /^\d{1,3}%$/],
  // Heading highlights + color panels: solid colors only (hex, or the rgb()
  // form the DOM serializer produces from hex).
  [/^background-color$/, /^(#[0-9a-f]{3,8}|rgb\(\d{1,3}, ?\d{1,3}, ?\d{1,3}\))$/],
  [/^color$/, /^(#[0-9a-f]{3,8}|rgb\(\d{1,3}, ?\d{1,3}, ?\d{1,3}\))$/],
  // Font choices: plain family lists only — no urls, parens, or escapes.
  [/^font-family$/, /^[a-z0-9 ,'"-]+$/],
];

function filterStyle(style: string): string {
  return style
    .split(";")
    .map((decl) => {
      const i = decl.indexOf(":");
      if (i < 0) return "";
      const prop = decl.slice(0, i).trim().toLowerCase();
      const value = decl.slice(i + 1).trim().toLowerCase();
      const ok = STYLE_WHITELIST.some(([p, v]) => p.test(prop) && v.test(value));
      return ok ? `${prop}: ${value}` : "";
    })
    .filter(Boolean)
    .join("; ");
}

/** Rehype plugin: keep only whitelisted CSS properties in style attributes. */
export function rehypeFilterStyles() {
  function walk(node: any): void {
    if (node?.type === "element" && node.properties && node.properties.style != null) {
      const filtered = filterStyle(String(node.properties.style));
      if (filtered) node.properties.style = filtered;
      else delete node.properties.style;
    }
    for (const child of node?.children ?? []) walk(child);
  }
  return (tree: any) => walk(tree);
}
