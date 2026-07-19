import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { MD_SANITIZE_SCHEMA, rehypeFilterStyles } from "@/lib/md-html";
import { remarkDocBlocks } from "@/lib/doc-blocks";
import { CodeBlock } from "./CodeBlock";
import { EmailTemplate } from "./EmailTemplate";
import { DocImage } from "./DocImage";
import { DocLink } from "./DocLink";
import {
  MermaidBlock,
  PlantUmlBlock,
  DocTabs,
  DecisionTreeBlock,
  FilterTable,
  ChecklistBox,
} from "./DocBlocks";
import { Callout, DocDetails, VideoBlock, SiteEmbed } from "./DocBlocksStatic";

/** Tab titles for a md-tabs group, read from the hast children. */
function tabTitles(node: any): string[] {
  const titles: string[] = [];
  for (const child of node?.children ?? []) {
    if (
      child?.type === "element" &&
      Array.isArray(child.properties?.className) &&
      child.properties.className.includes("md-tab")
    ) {
      titles.push(String(child.properties.dataTitle ?? "Tab"));
    }
  }
  return titles;
}

export function MarkdownView({ content, docKey }: { content: string; docKey?: string }) {
  return (
    <div className="doc-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkDirective, remarkDocBlocks]}
        // The rich editor stores a little inline HTML (underline, alignment,
        // indent, buttons, spacers). Raw HTML is reified, sanitized against an
        // allowlist schema, and inline styles filtered to safe properties.
        rehypePlugins={[rehypeRaw, [rehypeSanitize, MD_SANITIZE_SCHEMA], rehypeFilterStyles]}
        components={{
          // Images zoom on click and honor the "w=NN%" title width token.
          img({ src, alt, title }) {
            return <DocImage src={String(src ?? "")} alt={alt} title={title ?? undefined} />;
          },
          // External links become favicon chips; internal links stay plain.
          // Email CTA buttons keep their own styling.
          a({ href, children, className }) {
            if (className?.includes("email-btn")) {
              return (
                <a href={href} className={className}>
                  {children}
                </a>
              );
            }
            return <DocLink href={href}>{children}</DocLink>;
          },
          // Rich document blocks arrive as md-* divs from the directive plugin.
          div(props: any) {
            const { node, className, children } = props;
            const cls: string = className || "";
            if (cls.includes("md-callout")) {
              const kind = /md-callout-(\w+)/.exec(cls)?.[1] || "note";
              return (
                <Callout kind={kind} title={props["data-title"]}>
                  {children}
                </Callout>
              );
            }
            if (cls.includes("md-details")) {
              return <DocDetails title={props["data-title"] || "Details"}>{children}</DocDetails>;
            }
            if (cls.includes("md-tabs")) {
              return <DocTabs titles={tabTitles(node)}>{children}</DocTabs>;
            }
            if (cls.includes("md-tab")) {
              return <div className="md-tab">{children}</div>;
            }
            if (cls.includes("md-video")) {
              return <VideoBlock src={props["data-src"] || ""} title={props["data-title"]} />;
            }
            if (cls.includes("md-embed")) {
              return (
                <SiteEmbed
                  src={props["data-src"] || ""}
                  height={props["data-height"]}
                  title={props["data-title"]}
                />
              );
            }
            return <div className={className}>{children}</div>;
          },
          // GFM task-list checkboxes become interactive when we know which
          // document we're rendering (progress saved per device, per doc).
          input(props: any) {
            if (props.type === "checkbox" && docKey) {
              const pos = props.node?.position?.start;
              return <ChecklistBox storageKey={`cdchk:${docKey}:${pos?.line ?? 0}:${pos?.column ?? 0}`} />;
            }
            return <input type={props.type} disabled={props.disabled} defaultChecked={props.checked} />;
          },
          // Markdown tables get client-side filtering + click-to-sort.
          table({ children }) {
            return <FilterTable>{children}</FilterTable>;
          },
          // Fenced blocks (```lang) route through CodeBlock for the header bar,
          // Copy button, and run-block styling; diagram and decision fences get
          // their own renderers; inline code stays as-is.
          pre({ children }) {
            const child: any = Array.isArray(children) ? children[0] : children;
            if (child?.type === "code" || child?.props?.node?.tagName === "code") {
              const cls: string = child.props?.className || "";
              const lang = /language-([\w-]+)/.exec(cls)?.[1] || "";
              const code = String(child.props?.children ?? "");
              // ```email blocks get the letter-style template card instead.
              if (lang === "email") return <EmailTemplate raw={code} />;
              if (lang === "mermaid") return <MermaidBlock code={code} />;
              if (lang === "plantuml" || lang === "puml") return <PlantUmlBlock code={code} />;
              if (lang === "decision") return <DecisionTreeBlock code={code} />;
              return <CodeBlock language={lang} code={code} />;
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
