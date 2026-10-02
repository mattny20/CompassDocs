import { Breadcrumbs } from "@/components/Breadcrumbs";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getSpaceBySlug,
  getDocumentBySpaceAndSlug,
  listAttachments,
  isTrainingDeckDoc,
} from "@/lib/db";
import { StandaloneDoc } from "@/components/StandaloneDoc";
import { ViewTracker } from "@/components/ViewTracker";
import { PrintButton } from "@/components/PrintButton";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

async function publicDoc(spaceSlug: string, docSlug: string) {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space || space.visibility !== "public") notFound();
  const doc = await getDocumentBySpaceAndSlug(space.id, docSlug);
  // Drafts are never public, and a wrong slug 404s indistinguishably.
  if (!doc || doc.status !== "published") notFound();
  return { space, doc };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ space: string; doc: string }>;
}): Promise<Metadata> {
  const p = await params;
  const { doc } = await publicDoc(p.space, p.doc);
  return { title: doc.title, description: doc.summary || undefined };
}

export default async function PublicDocPage({
  params,
}: {
  params: Promise<{ space: string; doc: string }>;
}) {
  const p = await params;
  const { space, doc } = await publicDoc(p.space, p.doc);
  const attachments = await listAttachments(doc.id);
  // Public readers have no account, so this is the workspace setting only.
  const settings = await getAppSettings();

  return (
    <div>
      <ViewTracker docId={doc.id} />
      <Breadcrumbs
        items={[
          { href: "/public", label: "Home" },
          { href: `/public/${space.slug}`, label: space.name },
        ]}
      />
      {/* The same standalone document as the share page (1.9.2). */}
      <StandaloneDoc
        doc={doc}
        updatedLabel={`Updated ${formatDate(doc.updated_at, settings)}`}
        docKey={`pub-${doc.id}`}
        slideBreaks={(await isTrainingDeckDoc(doc.id)) ? "hidden" : undefined}
        attachments={attachments.map((a) => ({ id: a.id, filename: a.filename, href: `/api/attachments/${a.id}` }))}
        trailing={<PrintButton compact />}
      />
    </div>
  );
}
