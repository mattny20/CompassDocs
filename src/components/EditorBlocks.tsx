"use client";

// Rich-block support for the WYSIWYG editor: callouts, accordions, and tabs
// become editable containers; video/website embeds become preview cards; and
// mermaid/plantuml/decision code fences get a live preview while typing.
// Everything round-trips through the same Markdown directives that
// MarkdownView renders (see src/lib/doc-blocks.ts) — the stored format never
// changes.

import { useEffect, useState } from "react";
import { Node, Extension } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import mdContainer from "markdown-it-container";
import { Pencil, Trash2 } from "lucide-react";
import { MermaidBlock, PlantUmlBlock, DecisionTreeBlock } from "./DocBlocks";
import { VideoBlock, SiteEmbed, CALLOUT_STYLE } from "./DocBlocksStatic";

const CALLOUT_KINDS = ["note", "info", "tip", "warning", "danger"] as const;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `[Title]` from a container info string like `tip[Title]`. */
function infoTitle(info: string): string {
  return /\[(.*)\]\s*$/.exec(info.trim())?.[1] ?? "";
}

/** key="value" pairs from a directive attribute list. */
function parseDirectiveAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

// --- Markdown parsing (markdown-it) -------------------------------------------
// tiptap-markdown renders Markdown to HTML via markdown-it, then ProseMirror
// parses that HTML. These rules emit the same md-* divs the doc view uses, so
// the nodes' parseHTML rules below pick them up.

function registerContainer(md: any, name: string, open: (title: string) => string) {
  md.use(mdContainer, name, {
    validate: (params: string) => new RegExp(`^${name}(\\[.*\\])?\\s*$`).test(params.trim()),
    render: (tokens: any[], idx: number) =>
      tokens[idx].nesting === 1 ? open(infoTitle(tokens[idx].info)) : "</div>\n",
  });
}

function markdownItSetup(md: any) {
  for (const kind of CALLOUT_KINDS) {
    registerContainer(
      md,
      kind,
      (title) => `<div class="md-callout md-callout-${kind}" data-title="${esc(title)}">\n`
    );
  }
  registerContainer(md, "details", (title) => `<div class="md-details" data-title="${esc(title)}">\n`);
  registerContainer(md, "tabs", () => `<div class="md-tabs">\n`);
  registerContainer(md, "tab", (title) => `<div class="md-tab" data-title="${esc(title)}">\n`);

  // Leaf directives: ::video{...} / ::embed{...} on their own line.
  md.block.ruler.before(
    "paragraph",
    "cd_leaf_directive",
    (state: any, startLine: number, _endLine: number, silent: boolean) => {
      const pos = state.bMarks[startLine] + state.tShift[startLine];
      const line = state.src.slice(pos, state.eMarks[startLine]);
      const m = /^::(video|embed)(?:\[(.*?)\])?\{(.*)\}\s*$/.exec(line);
      if (!m) return false;
      if (silent) return true;
      const attrs = parseDirectiveAttrs(m[3]);
      const token = state.push("html_block", "", 0);
      token.content =
        `<div class="md-${m[1]}" data-src="${esc(attrs.src ?? "")}"` +
        ` data-title="${esc(m[2] ?? attrs.title ?? "")}"` +
        (m[1] === "embed" ? ` data-height="${esc(attrs.height ?? "")}"` : "") +
        `></div>\n`;
      token.map = [startLine, startLine + 1];
      state.line = startLine + 1;
      return true;
    }
  );
}

/** Carrier for the markdown-it rules (registered once, not per node). */
export const RichBlocksMarkdown = Extension.create({
  name: "richBlocksMarkdown",
  addStorage() {
    return {
      markdown: {
        parse: {
          setup(md: any) {
            markdownItSetup(md);
          },
        },
      },
    };
  },
});

// --- Serialization helpers ----------------------------------------------------

function serializeContainer(state: any, node: any, opener: string, closer: string) {
  state.write(opener);
  state.ensureNewLine();
  state.renderContent(node);
  state.ensureNewLine();
  state.write(closer);
  state.closeBlock(node);
}

// --- Callouts -----------------------------------------------------------------

function CalloutNodeView({ node, updateAttributes }: NodeViewProps) {
  const kind = String(node.attrs.kind);
  const v = CALLOUT_STYLE[kind] ?? CALLOUT_STYLE.note;
  return (
    <NodeViewWrapper className={`my-3 rounded-lg border border-l-4 px-3 py-2 ${v.box}`}>
      <div contentEditable={false} className="mb-1 flex items-center gap-1.5 text-sm">
        <v.Icon className={`h-4 w-4 shrink-0 ${v.title}`} aria-hidden />
        <select
          value={kind}
          onChange={(e) => updateAttributes({ kind: e.target.value })}
          className="rounded border border-transparent bg-transparent text-xs font-semibold text-slate-600 hover:border-slate-300"
        >
          {CALLOUT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          value={String(node.attrs.title ?? "")}
          onChange={(e) => updateAttributes({ title: e.target.value })}
          placeholder="Title (optional)"
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent text-sm font-semibold outline-none placeholder:font-normal placeholder:text-slate-400 hover:border-slate-300 focus:border-slate-300"
        />
      </div>
      <NodeViewContent className="text-[0.95em] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
    </NodeViewWrapper>
  );
}

export const CalloutBlock = Node.create({
  name: "calloutBlock",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return { kind: { default: "note" }, title: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "div.md-callout",
        getAttrs: (el) => ({
          kind: /md-callout-(\w+)/.exec((el as HTMLElement).className)?.[1] ?? "note",
          title: (el as HTMLElement).getAttribute("data-title") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    return [
      "div",
      { class: `md-callout md-callout-${node.attrs.kind}`, "data-title": node.attrs.title },
      0,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutNodeView);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const title = String(node.attrs.title ?? "").trim();
          serializeContainer(
            state,
            node,
            `:::${node.attrs.kind}${title ? `[${title}]` : ""}`,
            ":::"
          );
        },
        parse: {},
      },
    };
  },
});

// --- Accordion ----------------------------------------------------------------

function DetailsNodeView({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper className="my-3 rounded-lg border border-slate-200">
      <div
        contentEditable={false}
        className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-3 py-1.5 dark:bg-slate-800/40"
      >
        <span className="text-xs text-slate-400">▸ accordion</span>
        <input
          value={String(node.attrs.title ?? "")}
          onChange={(e) => updateAttributes({ title: e.target.value })}
          placeholder="Section title"
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent text-sm font-semibold outline-none placeholder:font-normal placeholder:text-slate-400 hover:border-slate-300 focus:border-slate-300"
        />
      </div>
      <NodeViewContent className="px-3 py-1 [&>*:first-child]:mt-2 [&>*:last-child]:mb-2" />
    </NodeViewWrapper>
  );
}

export const DetailsBlock = Node.create({
  name: "detailsBlock",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return { title: { default: "Details" } };
  },
  parseHTML() {
    return [
      {
        tag: "div.md-details",
        getAttrs: (el) => ({ title: (el as HTMLElement).getAttribute("data-title") || "Details" }),
      },
    ];
  },
  renderHTML({ node }) {
    return ["div", { class: "md-details", "data-title": node.attrs.title }, 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DetailsNodeView);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const title = String(node.attrs.title ?? "").trim() || "Details";
          serializeContainer(state, node, `:::details[${title}]`, ":::");
        },
        parse: {},
      },
    };
  },
});

// --- Tabs ---------------------------------------------------------------------
// Edited as stacked, titled panels (each panel fully editable); the reader's
// view renders them as real tabs.

function TabsNodeView(_props: NodeViewProps) {
  return (
    <NodeViewWrapper className="my-3 rounded-lg border border-compass-200 dark:border-compass-800">
      <div
        contentEditable={false}
        className="rounded-t-lg border-b border-compass-100 bg-compass-50 px-3 py-1 text-xs font-semibold text-compass-600 dark:bg-compass-950/40"
      >
        Tab group — each panel below becomes a tab
      </div>
      <NodeViewContent className="p-2" />
    </NodeViewWrapper>
  );
}

function TabPanelNodeView({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper className="mb-2 rounded-md border border-slate-200 last:mb-0">
      <div
        contentEditable={false}
        className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-2.5 py-1 dark:bg-slate-800/40"
      >
        <span className="text-[11px] uppercase tracking-wide text-slate-400">tab</span>
        <input
          value={String(node.attrs.title ?? "")}
          onChange={(e) => updateAttributes({ title: e.target.value })}
          placeholder="Tab title"
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent text-sm font-medium outline-none placeholder:text-slate-400 hover:border-slate-300 focus:border-slate-300"
        />
      </div>
      <NodeViewContent className="px-2.5 py-1 [&>*:first-child]:mt-1.5 [&>*:last-child]:mb-1.5" />
    </NodeViewWrapper>
  );
}

export const TabPanel = Node.create({
  name: "tabPanel",
  content: "block+",
  defining: true,
  addAttributes() {
    return { title: { default: "Tab" } };
  },
  parseHTML() {
    return [
      {
        tag: "div.md-tab",
        getAttrs: (el) => ({ title: (el as HTMLElement).getAttribute("data-title") || "Tab" }),
      },
    ];
  },
  renderHTML({ node }) {
    return ["div", { class: "md-tab", "data-title": node.attrs.title }, 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TabPanelNodeView);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const title = String(node.attrs.title ?? "").trim() || "Tab";
          serializeContainer(state, node, `:::tab[${title}]`, ":::");
        },
        parse: {},
      },
    };
  },
});

export const TabsBlock = Node.create({
  name: "tabsBlock",
  group: "block",
  content: "tabPanel+",
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: "div.md-tabs" }];
  },
  renderHTML() {
    return ["div", { class: "md-tabs" }, 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TabsNodeView);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          serializeContainer(state, node, "::::tabs", "::::");
        },
        parse: {},
      },
    };
  },
});

// --- Video / website embed cards ---------------------------------------------

function EmbedCardControls({
  label,
  onEdit,
  onDelete,
}: {
  label: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="mb-1 flex items-center justify-between">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <span className="flex gap-1">
        <button
          type="button"
          onClick={onEdit}
          title="Change URL"
          className="rounded border border-slate-200 p-1 text-slate-400 hover:text-slate-600"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Remove"
          className="rounded border border-slate-200 p-1 text-slate-400 hover:text-red-500"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </span>
    </div>
  );
}

function VideoNodeView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  return (
    <NodeViewWrapper
      contentEditable={false}
      className="my-3 rounded-lg border border-slate-200 p-2 [&_figure]:my-0"
    >
      <EmbedCardControls
        label="video"
        onEdit={() => {
          const src = window.prompt("Video URL (YouTube, Vimeo, Loom, or a file):", node.attrs.src);
          if (src !== null) updateAttributes({ src: src.trim() });
        }}
        onDelete={deleteNode}
      />
      <VideoBlock src={String(node.attrs.src ?? "")} title={String(node.attrs.title ?? "") || undefined} />
    </NodeViewWrapper>
  );
}

export const VideoEmbedNode = Node.create({
  name: "videoEmbed",
  group: "block",
  atom: true,
  addAttributes() {
    return { src: { default: "" }, title: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "div.md-video",
        getAttrs: (el) => ({
          src: (el as HTMLElement).getAttribute("data-src") ?? "",
          title: (el as HTMLElement).getAttribute("data-title") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    return ["div", { class: "md-video", "data-src": node.attrs.src, "data-title": node.attrs.title }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(VideoNodeView);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const title = String(node.attrs.title ?? "").trim();
          state.write(`::video${title ? `[${title}]` : ""}{src="${node.attrs.src}"}`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

function EmbedNodeView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  return (
    <NodeViewWrapper
      contentEditable={false}
      className="my-3 rounded-lg border border-slate-200 p-2 [&_figure]:my-0 [&_iframe]:pointer-events-none"
    >
      <EmbedCardControls
        label="website embed"
        onEdit={() => {
          const src = window.prompt("Page URL (https://…):", node.attrs.src);
          if (src === null) return;
          const height = window.prompt("Height in pixels (optional):", node.attrs.height || "420");
          updateAttributes({ src: src.trim(), height: (height ?? "").trim() });
        }}
        onDelete={deleteNode}
      />
      <SiteEmbed
        src={String(node.attrs.src ?? "")}
        height={String(node.attrs.height ?? "")}
        title={String(node.attrs.title ?? "") || undefined}
      />
    </NodeViewWrapper>
  );
}

export const SiteEmbedNode = Node.create({
  name: "siteEmbed",
  group: "block",
  atom: true,
  addAttributes() {
    return { src: { default: "" }, height: { default: "" }, title: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "div.md-embed",
        getAttrs: (el) => ({
          src: (el as HTMLElement).getAttribute("data-src") ?? "",
          height: (el as HTMLElement).getAttribute("data-height") ?? "",
          title: (el as HTMLElement).getAttribute("data-title") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    return [
      "div",
      {
        class: "md-embed",
        "data-src": node.attrs.src,
        "data-height": node.attrs.height,
        "data-title": node.attrs.title,
      },
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EmbedNodeView);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const parts = [`src="${node.attrs.src}"`];
          if (node.attrs.height) parts.push(`height="${node.attrs.height}"`);
          state.write(`::embed{${parts.join(" ")}}`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

// --- Code blocks with live diagram preview ------------------------------------

const PREVIEW_LANGS = new Set(["mermaid", "plantuml", "puml", "decision"]);

function CodeBlockView({ node }: NodeViewProps) {
  const lang = String(node.attrs.language ?? "");
  const code = node.textContent;
  // Debounce so diagrams re-render calmly while typing.
  const [preview, setPreview] = useState(code);
  useEffect(() => {
    const t = setTimeout(() => setPreview(code), 600);
    return () => clearTimeout(t);
  }, [code]);

  return (
    <NodeViewWrapper className="my-3">
      <pre className={lang ? `language-${lang}` : undefined}>
        <NodeViewContent as={"code" as any} className={lang ? `language-${lang}` : undefined} />
      </pre>
      {PREVIEW_LANGS.has(lang) && preview.trim() && (
        <div contentEditable={false} className="-mt-2 rounded-b-lg border border-t-0 border-slate-200 px-2 pb-1 [&>div]:my-2">
          <div className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Live preview
          </div>
          {lang === "decision" ? (
            <DecisionTreeBlock code={preview} />
          ) : lang === "mermaid" ? (
            <MermaidBlock code={preview} />
          ) : (
            <PlantUmlBlock code={preview} />
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const PreviewCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});

export const EDITOR_BLOCK_EXTENSIONS = [
  RichBlocksMarkdown,
  CalloutBlock,
  DetailsBlock,
  TabsBlock,
  TabPanel,
  VideoEmbedNode,
  SiteEmbedNode,
];
