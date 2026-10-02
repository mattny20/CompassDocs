// A document read outside the app shell: the share page and the public
// document page (1.9.2). One component, so the two stop drifting — the same
// masthead (type chip, title, updated date, tags), the same summary lede,
// the same reading card with the measure, the same attachments panel and
// the same print output. Server-safe.
//
// The pages keep what differs: the share page its own header and footer and
// the token on every attachment URL; the public page its breadcrumbs and
// view tracking. Both pass the document's title as `dropTitle` so a body
// that opens with "# Title" does not show it twice.

import { Paperclip } from "lucide-react";
import { MarkdownView } from "./MarkdownView";
import { TypeBadge, Tag } from "./Badges";
import type { DocType } from "@/lib/types";

export function StandaloneDoc({
  doc,
  updatedLabel,
  docKey,
  slideBreaks,
  attachments,
  trailing,
}: {
  doc: { id: number; title: string; type: DocType; summary?: string | null; tags?: string[]; content: string };
  /** "Updated 2 Oct 2026", already formatted for the workspace. */
  updatedLabel: string;
  docKey: string;
  slideBreaks?: "indicator" | "hidden";
  attachments: { id: number; filename: string; href: string }[];
  /** Right of the masthead — the Print button. */
  trailing?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">{doc.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500">
            <TypeBadge type={doc.type} />
            <span>{updatedLabel}</span>
            {doc.tags && doc.tags.length > 0 && (
              <span className="flex flex-wrap items-center gap-1.5">
                <span>·</span>
                {doc.tags.map((t) => (
                  <Tag key={t} label={t} />
                ))}
              </span>
            )}
          </div>
        </div>
        {trailing && <div className="shrink-0 print:hidden">{trailing}</div>}
      </div>

      {doc.summary && <p className="mb-6 max-w-3xl text-lg leading-relaxed text-slate-600">{doc.summary}</p>}

      {/* doc-read: reading measure on the document body (see globals.css).
          On paper the card chrome goes; the page box is the frame. */}
      <article className="doc-read rounded-xl border border-slate-200 bg-surface p-8 shadow-xs print:border-0 print:p-0 print:shadow-none">
        <MarkdownView content={doc.content} docKey={docKey} slideBreaks={slideBreaks} dropTitle={doc.title} />
      </article>

      {attachments.length > 0 && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-surface p-5 shadow-xs print:hidden">
          <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <Paperclip className="h-3.5 w-3.5" aria-hidden /> Attachments
          </h2>
          <ul className="space-y-1">
            {attachments.map((a) => (
              <li key={a.id}>
                <a
                  href={a.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-compass-700 hover:underline"
                >
                  {a.filename}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
