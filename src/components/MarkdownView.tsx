import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="doc-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Fenced blocks (```lang) route through CodeBlock for the header bar,
          // Copy button, and run-block styling; inline code stays as-is.
          pre({ children }) {
            const child: any = Array.isArray(children) ? children[0] : children;
            if (child?.type === "code" || child?.props?.node?.tagName === "code") {
              const cls: string = child.props?.className || "";
              const lang = /language-([\w-]+)/.exec(cls)?.[1] || "";
              const code = String(child.props?.children ?? "");
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
