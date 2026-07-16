import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { EmailTemplate } from "./EmailTemplate";
import { DocImage } from "./DocImage";

export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="doc-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Images zoom on click and honor the "w=NN%" title width token.
          img({ src, alt, title }) {
            return <DocImage src={String(src ?? "")} alt={alt} title={title ?? undefined} />;
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
