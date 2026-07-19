// Rich document blocks, authored as Markdown directives and fences.
//
// This module is pure (no fs/db) and is imported by both the server-rendered
// Markdown view and client block components.
//
// Directive syntax (remark-directive):
//   :::note … :::            (also tip / warning / danger / info)
//   :::note[Custom title]
//   :::details[Section title] … :::          → accordion
//   ::::tabs  :::tab[Windows] … :::  ::::    → tab group
//   ::video[Caption]{src="https://youtu.be/…"}
//   ::embed{src="https://status.example.com" height="500"}
//
// The plugin rewrites directives into plain <div className="md-…"> elements
// (with data-* attributes) that survive the sanitizer; MarkdownView maps those
// classes to interactive components.

import { visit } from "unist-util-visit";

const CALLOUTS = new Set(["note", "tip", "warning", "danger", "info"]);

/** Text content of a directive's label (the `[…]` part), if present. */
function directiveLabel(node: any): string {
  const first = node.children?.[0];
  if (!first || !first.data?.directiveLabel) return "";
  return (first.children ?? [])
    .map((c: any) => c.value ?? "")
    .join("")
    .trim();
}

function dropLabel(node: any): void {
  if (node.children?.[0]?.data?.directiveLabel) node.children.shift();
}

function asDiv(node: any, className: string, data: Record<string, string> = {}): void {
  node.data = node.data ?? {};
  node.data.hName = "div";
  node.data.hProperties = {
    className: className.split(" "),
    ...Object.fromEntries(
      Object.entries(data)
        .filter(([, v]) => v)
        .map(([k, v]) => [`data-${k}`, v])
    ),
  };
}

/** Remark plugin: turn supported directives into md-* divs. Unknown directives
 * are left alone (they render as their literal text, like before). */
export function remarkDocBlocks() {
  return (tree: any) => {
    visit(tree, (node: any) => {
      const isContainer = node.type === "containerDirective";
      const isLeaf = node.type === "leafDirective" || node.type === "textDirective";
      if (!isContainer && !isLeaf) return;
      const name = String(node.name || "").toLowerCase();
      const attrs = node.attributes ?? {};
      const label = directiveLabel(node);

      if (CALLOUTS.has(name) && isContainer) {
        dropLabel(node);
        asDiv(node, `md-callout md-callout-${name}`, { title: label || attrs.title || "" });
      } else if (name === "details" && isContainer) {
        dropLabel(node);
        asDiv(node, "md-details", { title: label || attrs.title || "Details" });
      } else if (name === "tabs" && isContainer) {
        dropLabel(node);
        asDiv(node, "md-tabs");
      } else if (name === "tab" && isContainer) {
        dropLabel(node);
        asDiv(node, "md-tab", { title: label || attrs.title || "Tab" });
      } else if (name === "video") {
        dropLabel(node);
        asDiv(node, "md-video", { src: attrs.src || "", title: label || attrs.title || "" });
      } else if (name === "embed") {
        dropLabel(node);
        asDiv(node, "md-embed", {
          src: attrs.src || "",
          height: attrs.height || "",
          title: label || attrs.title || "",
        });
      }
    });
  };
}

// --- Video URL handling -------------------------------------------------------

/** Map a pasted video URL to an embeddable iframe URL, or a direct file URL.
 * Returns null for anything unsupported (rendered as a plain link instead). */
export function videoEmbedUrl(
  raw: string
): { kind: "iframe" | "file"; url: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Uploaded attachments are app-relative (/api/attachments/…).
    if (raw.startsWith("/")) return { kind: "file", url: raw };
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "");
  if (host === "youtube.com" || host === "m.youtube.com") {
    const id = u.searchParams.get("v");
    if (id) return { kind: "iframe", url: `https://www.youtube-nocookie.com/embed/${id}` };
    const shorts = /^\/(shorts|embed)\/([\w-]+)/.exec(u.pathname);
    if (shorts) return { kind: "iframe", url: `https://www.youtube-nocookie.com/embed/${shorts[2]}` };
  }
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    if (id) return { kind: "iframe", url: `https://www.youtube-nocookie.com/embed/${id}` };
  }
  if (host === "vimeo.com") {
    const id = /^\/(\d+)/.exec(u.pathname)?.[1];
    if (id) return { kind: "iframe", url: `https://player.vimeo.com/video/${id}` };
  }
  if (host === "loom.com") {
    const id = /^\/share\/([\w]+)/.exec(u.pathname)?.[1];
    if (id) return { kind: "iframe", url: `https://www.loom.com/embed/${id}` };
  }
  if (/\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(u.pathname)) return { kind: "file", url: raw };
  return null;
}

// --- Decision trees -----------------------------------------------------------
//
// ```decision
// start: Is the service responding?
// - Yes -> logs
// - No -> ping
// ping: Can you ping the host?
// - Yes -> Restart the web service, then re-check.
// - No -> Escalate to the network team.
// logs: Any errors in the application log?
// - Yes -> Follow the runbook for that error code.
// - No -> Capture a HAR file and open a ticket.
// ```
// A choice's target is another node id when one matches; otherwise the text
// after `->` is a terminal outcome.

export interface DecisionChoice {
  label: string;
  /** Node id to jump to, or null when `outcome` is terminal. */
  next: string | null;
  outcome: string | null;
}
export interface DecisionNode {
  id: string;
  question: string;
  choices: DecisionChoice[];
}
export interface DecisionTreeData {
  start: string;
  nodes: Record<string, DecisionNode>;
  error?: string;
}

export function parseDecisionTree(source: string): DecisionTreeData {
  const nodes: Record<string, DecisionNode> = {};
  let current: DecisionNode | null = null;
  let first = "";
  const pending: Array<{ node: string; idx: number; target: string }> = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const choice = /^[-*]\s+(.+?)\s*->\s*(.+)$/.exec(line);
    if (choice && current) {
      current.choices.push({ label: choice[1].trim(), next: null, outcome: null });
      pending.push({ node: current.id, idx: current.choices.length - 1, target: choice[2].trim() });
      continue;
    }
    const q = /^([\w-]+)\s*:\s*(.+)$/.exec(line);
    if (q) {
      current = { id: q[1], question: q[2].trim(), choices: [] };
      nodes[current.id] = current;
      if (!first) first = current.id;
      continue;
    }
    // Continuation line: append to the current question.
    if (current && current.choices.length === 0) current.question += " " + line;
  }

  for (const p of pending) {
    const c = nodes[p.node].choices[p.idx];
    if (nodes[p.target]) c.next = p.target;
    else c.outcome = p.target;
  }

  if (!first) return { start: "", nodes: {}, error: "No questions found." };
  const bad = Object.values(nodes).find((n) => n.choices.length === 0);
  if (bad) {
    return { start: first, nodes, error: `"${bad.id}" has no choices — add "- Answer -> target" lines.` };
  }
  return { start: first, nodes };
}
