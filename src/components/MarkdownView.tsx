import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { MD_SANITIZE_SCHEMA, rehypeFilterStyles } from "@/lib/md-html";
import { CodeBlock } from "./CodeBlock";
import { EmailTemplate } from "./EmailTemplate";
import { DocImage } from "./DocImage";
import { DocLink } from "./DocLink";

export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="doc-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
          // Fenced blocks (```lang) route through CodeBlock for the header bar,
          // Copy button, and run-block styling; inline code stays as-is.
          pre({ children }) {
            const child: any = Array.isArray(children) ? children[0] : children;
            if (child?.type === "code" || child?.props?.node?.tagName === "code") {
              const cls: string = child.props?.className || "";
              const lang = /language-([\w-]+)/.exec(cls)?.[1] || "";
              const code = String(child.props?.children ?? "");
              // ```email blocks get the letter-style template card instead.
              if (lang === "email") return <EmailTemplate raw={code} />;
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
