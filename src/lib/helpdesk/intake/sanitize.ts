// Helpdesk 1.19.0, machine intake (agent P): what an alert may put on a
// ticket. A monitoring tool's text is untrusted: HTML never renders (it is
// walked into text), and markdown is parsed and written out again from a
// strict allowlist (text, paragraphs, lists, quotes, emphasis, code, and
// http(s) links written here; an image becomes a plain link, so nothing
// loads from the tool's server when an agent opens the ticket; directives
// such as ::embed, raw HTML and reference definitions never survive). Every
// value is capped. Pure.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import { escapeMarkdownText, htmlToText, textToSafeMarkdown } from "../inbound-parse";
import { HD_INTAKE_LIMITS, type HdAlertLink } from "./shared";

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** http(s) only, parsed, no credentials, capped; null otherwise. */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > HD_INTAKE_LIMITS.linkUrl) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return u.toString();
}

/** One line of plain text: no tags, no control characters, collapsed, capped. */
export function plainLine(raw: unknown, max: number): string {
  if (raw === null || raw === undefined) return "";
  let s = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
  if (/<[a-z!/][^>]*>/i.test(s)) s = htmlToText(s);
  s = s.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Links: http(s) only, labelled, de-duplicated, at most 20. */
export function cleanLinks(raw: unknown): HdAlertLink[] {
  if (!Array.isArray(raw)) return [];
  const out: HdAlertLink[] = [];
  for (const l of raw) {
    if (out.length >= HD_INTAKE_LIMITS.links) break;
    const o = typeof l === "string" ? { url: l } : l && typeof l === "object" ? (l as Record<string, unknown>) : null;
    if (!o) continue;
    const url = safeUrl(o.url ?? o.href);
    if (!url || out.some((x) => x.url === url)) continue;
    const label = plainLine(o.label ?? o.text ?? o.name ?? "", HD_INTAKE_LIMITS.linkLabel) || new URL(url).hostname;
    out.push({ label, url });
  }
  return out;
}

/** Fields: flat string → string, scalars only (objects as compact JSON), capped. */
export function cleanFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= HD_INTAKE_LIMITS.fields) break;
    const key = plainLine(k, HD_INTAKE_LIMITS.fieldKey);
    if (!key || key === "__proto__" || key in out) continue;
    let value: string;
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") value = String(v);
    else {
      try {
        value = JSON.stringify(v);
      } catch {
        continue;
      }
    }
    value = value.replace(CONTROL, "").trim();
    if (!value) continue;
    out[key] = value.length > HD_INTAKE_LIMITS.fieldValue ? `${value.slice(0, HD_INTAKE_LIMITS.fieldValue - 1)}…` : value;
    n++;
  }
  return out;
}

/**
 * A URL as a markdown link destination: angle-bracketed, with everything
 * that could end the link or start markup percent-encoded (safeUrl output
 * is already parsed http(s)).
 */
export function markdownUrl(url: string): string {
  return `<${url.replace(/[<>()[\]\\\s`"'!*_{}|^]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)}>`;
}

/** A link we write ourselves: escaped label, safe destination. */
export function markdownLink(label: string, url: string): string {
  return `[${escapeMarkdownText(label.replace(/[\r\n]+/g, " ").trim() || new URL(url).hostname)}](${markdownUrl(url)})`;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  identifier?: string;
  ordered?: boolean | null;
  start?: number | null;
  depth?: number;
  children?: MdNode[];
}

function textOf(n: MdNode): string {
  if (typeof n.value === "string" && n.type !== "html") return n.value;
  if (n.type === "image" || n.type === "imageReference") return n.alt ?? "";
  if (n.type === "html") return n.value ?? "";
  return (n.children ?? []).map(textOf).join("");
}

/** Text as markdown that renders as itself, with line-start markers neutralised. */
function safeText(s: string): string {
  return s
    .split("\n")
    .map((l) => escapeMarkdownText(l).replace(/^(\s*)([-+=])/, "$1\\$2").replace(/^(\s*\d{1,9})([.)])/, "$1\\$2"))
    .join("\n");
}

/** A code span that its own content cannot close. */
function codeSpan(v: string): string {
  const longest = Math.max(0, ...[...v.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = v.startsWith("`") || v.endsWith("`") || v.startsWith(" ") ? " " : "";
  return `${fence}${pad}${v.replace(/\n/g, " ")}${pad}${fence}`;
}

/**
 * Markdown rebuilt from what an alert may hold. Parsed the way the desk
 * parses (GFM and directives), then written out node by node: anything not
 * on the list is its text, escaped.
 */
function rebuildMarkdown(src: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).parse(src) as unknown as MdNode;
  const defs = new Map<string, string>();
  const collect = (n: MdNode) => {
    if (n.type === "definition" && n.identifier && n.url) defs.set(n.identifier.toLowerCase(), n.url);
    for (const c of n.children ?? []) collect(c);
  };
  collect(tree);
  const link = (label: string, raw: string | undefined): string => {
    const url = safeUrl(raw);
    return url ? markdownLink(label, url) : safeText(label);
  };
  const inline = (nodes: MdNode[] = []): string =>
    nodes
      .map((n): string => {
        switch (n.type) {
          case "text":
            return safeText(n.value ?? "");
          case "strong":
            return `**${inline(n.children)}**`;
          case "emphasis":
            return `_${inline(n.children)}_`;
          case "delete":
            return inline(n.children);
          case "inlineCode":
            return codeSpan(n.value ?? "");
          case "break":
            return "  \n";
          case "link":
            return link(textOf(n), n.url);
          case "image":
            return n.url && safeUrl(n.url) ? link(n.alt || "", n.url) : safeText(n.alt ?? "");
          case "linkReference":
          case "imageReference": {
            const label = textOf(n);
            const url = n.identifier ? defs.get(n.identifier.toLowerCase()) : undefined;
            return url ? link(label, url) : safeText(label);
          }
          case "textDirective":
            return safeText(textOf(n));
          default:
            return safeText(textOf(n));
        }
      })
      .join("");
  const block = (n: MdNode): string => {
    switch (n.type) {
      case "paragraph":
        return inline(n.children);
      case "heading":
        return `**${inline(n.children)}**`;
      case "thematicBreak":
        return "***";
      case "blockquote":
        return blocks(n.children)
          .split("\n")
          .map((l) => (l ? `> ${l}` : ">"))
          .join("\n");
      case "list": {
        let i = typeof n.start === "number" ? n.start : 1;
        return (n.children ?? [])
          .map((item) => {
            const marker = n.ordered ? `${i++}. ` : "- ";
            const body = blocks(item.children).split("\n");
            return marker + body.map((l, k) => (k === 0 || !l ? l : " ".repeat(marker.length) + l)).join("\n");
          })
          .join("\n");
      }
      case "code": {
        // No info string: a fence never becomes a diagram, a decision or an email card.
        const v = n.value ?? "";
        const longest = Math.max(2, ...[...v.matchAll(/`+/g)].map((m) => m[0].length));
        const fence = "`".repeat(longest + 1);
        return `${fence}\n${v}\n${fence}`;
      }
      case "table":
        return (n.children ?? []).map((row) => (row.children ?? []).map((cell) => inline(cell.children)).join(" \\| ")).join("  \n");
      case "definition":
      case "leafDirective":
      case "containerDirective":
        // Reference definitions are resolved where they are used; a leaf
        // directive (::embed, ::video) is dropped, a container's content is
        // kept as plain blocks.
        return n.type === "containerDirective" ? blocks(n.children) : "";
      case "html":
        return safeText(n.value ?? "");
      default:
        return safeText(textOf(n));
    }
  };
  const blocks = (nodes: MdNode[] = []): string =>
    nodes
      .map(block)
      .filter((b) => b.trim() !== "")
      .join("\n\n");
  return blocks(tree.children);
}

/**
 * An alert's description as safe markdown. HTML (a whole document, or tags
 * mixed into text) is walked into text first; markdown keeps its emphasis,
 * lists and code, with raw HTML escaped and links filtered; plain text is
 * escaped so it renders as itself. Capped with a note.
 */
export function sanitizeDescription(raw: unknown, format: "markdown" | "plain" = "markdown"): string {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/\r\n?/g, "\n").replace(CONTROL, "");
  let fmt = format;
  // An HTML body (it opens with a tag, or carries block markup outside code)
  // is walked into text; stray inline tags in markdown are escaped below.
  const outsideCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  if (/^\s*<[a-z!][^>]*>/i.test(outsideCode) || /<(html|body|head|div|p|br|table|tr|td|ul|ol|li|h[1-6]|script|style|iframe)\b[^>]*>/i.test(outsideCode)) {
    text = htmlToText(text);
    fmt = "plain";
  }
  let note = "";
  if (text.length > HD_INTAKE_LIMITS.description) {
    text = text.slice(0, HD_INTAKE_LIMITS.description);
    note = "\n\n_(The rest of the alert text was too long and was left out.)_";
  }
  if (fmt === "plain") return (textToSafeMarkdown(text.trim()) + note).trim();
  return (rebuildMarkdown(text).trim() + note).trim();
}
