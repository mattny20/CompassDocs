import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Components } from "react-markdown";
import { MD_SANITIZE_SCHEMA, rehypeFilterStyles } from "@/lib/md-html";
import { remarkDocBlocks } from "@/lib/doc-blocks";
import { remarkDropTitle } from "@/lib/drop-title";
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

/**
 * The inline-only schema (1.12.0): what a confirmation statement may carry.
 * One sentence with emphasis, code and a link, and nothing that embeds,
 * loads or asks: the md-* directive divs (an embed's iframe, a video) are
 * unwrapped to nothing, images and task-list inputs are dropped, and so
 * are headings, tables and inline styles. `a` keeps the default attributes,
 * so `href` stays under the default protocols (a javascript: link is
 * dropped here as it is in the document view).
 */
export const MD_INLINE_SANITIZE_SCHEMA: typeof defaultSchema = {
  ...defaultSchema,
  tagNames: ["p", "em", "strong", "a", "code", "br"],
  attributes: { a: defaultSchema.attributes?.a ?? [] },
};

/**
 * How a shifted heading keeps the look of the level it was written at: the
 * `.doc-prose h1/h2/h3` rules of globals.css, restated. Those rules are
 * unlayered, so a plain utility loses to them on the tag the heading lands
 * on (an authored h1 drawn by `.doc-prose h3`): the box and type are
 * !important; the ink is not, so the heading-highlight and panel rules
 * still win it on h1-h3. Levels 4-6 have no prose rule, so they need none.
 * Keep in step with globals.css.
 */
const SHIFTED_LOOK: Record<number, string> = {
  1: "mt-8! mb-4! first:mt-0! text-2xl! font-bold! text-slate-900",
  2: "mt-8! mb-3! border-b! border-slate-100! pb-1! text-xl! font-semibold! text-slate-900",
  3: "mt-6! mb-2! text-lg! font-semibold! text-slate-900",
};
/** A level-1 heading landing on h2, whose prose rule rules a line under it. */
const SHIFTED_FLAT = "border-b-0! pb-0!";
/** The heading-highlight rule (globals.css) covers h1-h3 only; past h3 it is restated. */
const SHIFTED_HIGHLIGHT =
  "[&[style*=background-color]]:rounded-lg [&[style*=background-color]]:px-[0.55em] [&[style*=background-color]]:py-[0.3em] [&[style*=background-color]]:text-[#0f172a]";

/**
 * Re-tags every heading `offset` levels down (h1 → h3 for 2), capped at h6,
 * records the level it was written at as data-md-level, and dresses it in
 * that level's look (SHIFTED_LOOK). Runs after the sanitizer, so the
 * attribute and the classes are ours, never the author's.
 */
function rehypeHeadingOffset(offset: number) {
  return (tree: any) => {
    const walk = (node: any) => {
      for (const child of node?.children ?? []) {
        if (child?.type !== "element") continue;
        const m = /^h([1-6])$/.exec(child.tagName);
        if (m) {
          const level = Number(m[1]);
          const tag = Math.min(6, level + offset);
          const look = [SHIFTED_LOOK[level] ?? "", tag === 2 ? SHIFTED_FLAT : "", tag > 3 ? SHIFTED_HIGHLIGHT : ""];
          const had = child.properties?.className;
          child.tagName = `h${tag}`;
          child.properties = {
            ...child.properties,
            dataMdLevel: level,
            className: [...(Array.isArray(had) ? had : had ? [String(had)] : []), ...look.join(" ").split(" ").filter(Boolean)],
          };
        }
        walk(child);
      }
    };
    walk(tree);
  };
}

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

export function MarkdownView({
  content,
  docKey,
  slideBreaks,
  dropTitle,
  inline,
  headingOffset = 0,
}: {
  content: string;
  docKey?: string;
  /**
   * Inline-only rendering (1.12.0): the confirmation statement on the
   * read confirmation card. The sanitizer keeps p, em, strong, a, code and
   * br and nothing else (MD_INLINE_SANITIZE_SCHEMA), and only the link
   * component is mapped, so a statement can carry emphasis and a link but
   * never a directive, an image, an embed or a task list.
   */
  inline?: boolean;
  /**
   * The document's title, when the surface already shows it as a masthead:
   * a leading `# Title` that repeats it is dropped from the body (1.9.2,
   * lib/drop-title). Only the three reading surfaces pass it.
   */
  dropTitle?: string;
  /**
   * Levels to shift the body's headings down by, for a host whose own title
   * already holds a place in the outline (STYLEGUIDE §Reading measure,
   * "Heading offset"): the handbook reader and print pass 2 under a policy's
   * h2, so the body's h1 is an h3 and the page keeps one h1. The look stays
   * the level the author wrote; only the tag moves. Default 0.
   */
  headingOffset?: number;
  /**
   * How `---` thematic breaks render. Training decks split slides on them, so
   * the editor preview shows a labeled indicator ("indicator") while the
   * published document hides them entirely ("hidden"). Default: a normal rule.
   */
  slideBreaks?: "indicator" | "hidden";
}) {
  // External links become favicon chips; internal links stay plain. Email
  // CTA buttons keep their own styling. The one component inline mode maps.
  const a: Components["a"] = ({ href, children, className }) => {
    if (className?.includes("email-btn")) {
      return (
        <a href={href} className={className}>
          {children}
        </a>
      );
    }
    return <DocLink href={href}>{children}</DocLink>;
  };

  if (inline) {
    // The same parse (so a directive is recognised and then dropped, not
    // shown as its literal text), a narrower allowlist, no block components.
    return (
      <div className="doc-prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkDirective, remarkDocBlocks]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, MD_INLINE_SANITIZE_SCHEMA]]}
          components={{ a }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="doc-prose">
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkDirective,
          remarkDocBlocks,
          ...(dropTitle ? [remarkDropTitle(dropTitle)] : []),
        ]}
        // The rich editor stores a little inline HTML (underline, alignment,
        // indent, buttons, spacers). Raw HTML is reified, sanitized against an
        // allowlist schema, and inline styles filtered to safe properties.
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, MD_SANITIZE_SCHEMA],
          rehypeFilterStyles,
          ...(headingOffset > 0 ? [[rehypeHeadingOffset, headingOffset] as [typeof rehypeHeadingOffset, number]] : []),
        ]}
        components={{
          // Slide breaks (training decks): indicator in the editor preview,
          // invisible on the published page, a plain rule everywhere else.
          hr() {
            if (slideBreaks === "hidden") return null;
            if (slideBreaks === "indicator") {
              return (
                <div
                  aria-hidden
                  className="my-5 flex select-none items-center gap-3 text-2xs font-semibold uppercase tracking-widest text-compass-600"
                >
                  <span className="h-0 flex-1 border-t-2 border-dashed border-compass-300" />
                  Slide break
                  <span className="h-0 flex-1 border-t-2 border-dashed border-compass-300" />
                </div>
              );
            }
            return <hr />;
          },
          // Images zoom on click and honor the "w=NN%" title width token.
          img({ src, alt, title }) {
            return <DocImage src={String(src ?? "")} alt={alt} title={title ?? undefined} />;
          },
          a,
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
            if (cls.includes("md-compliance")) {
              return (
                <Callout kind="info" title={props["data-title"] || "Compliance confirmation"}>
                  {children}
                </Callout>
              );
            }
            if (cls.includes("md-quiz")) {
              // Training scaffolding: invisible on published deck pages; a
              // labeled callout in the editor preview and everywhere else so
              // authors can see (and proofread) the questions.
              if (slideBreaks === "hidden") return null;
              return (
                <Callout
                  kind="note"
                  title={`${props["data-title"] || "Quiz"} — graded in the training player`}
                >
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
              return (
                <VideoBlock
                  src={props["data-src"] || ""}
                  title={props["data-title"]}
                  poster={props["data-poster"]}
                />
              );
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
