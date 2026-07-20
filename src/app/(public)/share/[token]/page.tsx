// A shared document: one published doc, read-only, reachable by anyone
// holding the tokenized link. Deliberately standalone — no public-site
// dependency, no navigation beyond the workspace brand — and always
// noindex: share links are unlisted, not published.

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveShare, recordShareView } from "@/lib/shares";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";
import { listAttachments } from "@/lib/db";
import { DOC_TYPE_LABEL } from "@/lib/types";
import { MarkdownView } from "@/components/MarkdownView";
import { PrintButton } from "@/components/PrintButton";
import { Brand } from "@/components/Brand";
import { Paperclip } from "lucide-react";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const resolved = await resolveShare((await params).token);
  return {
    title: resolved ? resolved.doc.title : "Shared document",
    robots: { index: false, follow: false },
  };
}

export default async function SharedDocPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveShare(token);
  if (!resolved) notFound();
  const { share, doc } = resolved;
  void recordShareView(share.id);

  const settings = await getAppSettings();
  const attachments = await listAttachments(doc.id);
  // Inline images point at the attachments API; the share token grants the
  // anonymous reader access to exactly this doc's files.
  const content = doc.content.replace(
    /\/api\/attachments\/(\d+)/g,
    `/api/attachments/$1?share=${token}`
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white print:hidden">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-6 py-4">
          <Brand name={settings.company_name} logoUrl={settings.logo_url || undefined} />
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Shared document · read-only
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">{doc.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-400">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                {DOC_TYPE_LABEL[doc.type]}
              </span>
              <span>Updated {formatDate(doc.updated_at, settings)}</span>
            </div>
          </div>
          <PrintButton compact />
        </div>

        {doc.summary && <p className="mb-6 max-w-3xl text-lg leading-relaxed text-slate-600">{doc.summary}</p>}

        <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
          <MarkdownView content={content} docKey={`share-${doc.id}`} />
        </div>

        {attachments.length > 0 && (
          <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm print:hidden">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">
              <Paperclip className="h-3.5 w-3.5" aria-hidden /> Attachments
            </h2>
            <ul className="space-y-1">
              {attachments.map((a) => (
                <li key={a.id}>
                  <a
                    href={`/api/attachments/${a.id}?share=${token}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-compass-700 hover:underline"
                  >
                    {a.filename}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-8 text-center text-xs text-slate-400 print:hidden">
          Shared from {settings.company_name} via CompassDocs.
        </p>
      </main>
    </div>
  );
}
