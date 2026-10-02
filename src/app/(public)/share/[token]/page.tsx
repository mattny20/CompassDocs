// A shared document: one published doc, read-only, reachable by anyone
// holding the tokenized link. Deliberately standalone — no public-site
// dependency, no navigation beyond the workspace brand — and always
// noindex: share links are unlisted, not published.

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveShare, recordShareView } from "@/lib/shares";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";
import { listAttachments, isTrainingDeckDoc } from "@/lib/db";
import { StandaloneDoc } from "@/components/StandaloneDoc";
import { PrintButton } from "@/components/PrintButton";
import { Brand } from "@/components/Brand";

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
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-slate-200 bg-surface print:hidden">
        <div className="mx-auto flex max-w-standalone items-center justify-between gap-4 px-6 py-4">
          <Brand name={settings.company_name} logoUrl={settings.logo_url || undefined} />
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Shared document · read-only
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-standalone px-6 py-10">
        <StandaloneDoc
          doc={{ ...doc, content }}
          updatedLabel={`Updated ${formatDate(doc.updated_at, settings)}`}
          docKey={`share-${doc.id}`}
          slideBreaks={(await isTrainingDeckDoc(doc.id)) ? "hidden" : undefined}
          attachments={attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            href: `/api/attachments/${a.id}?share=${token}`,
          }))}
          trailing={<PrintButton compact />}
        />

        <p className="mt-8 text-center text-xs text-slate-500 print:hidden">
          Shared from {settings.company_name} via CompassDocs.
        </p>
      </main>
    </div>
  );
}
