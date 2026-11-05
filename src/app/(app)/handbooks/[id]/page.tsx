import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { BookOpen, Pencil } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { settingsForUser } from "@/lib/format";
import { EmptyState } from "@/components/form";
import { HandbookReader } from "@/components/handbooks/reader/HandbookReader";
import { HandbookIntro } from "@/components/handbooks/reader/HandbookIntro";
import {
  loadReaderBase,
  policyHref,
  readerCanEdit,
  readerHandbook,
} from "@/components/handbooks/reader/reader-data";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const handbook = await readerHandbook(Number(id)).catch(() => undefined);
  return { title: handbook?.title ?? "Handbook" };
}

// The handbook reader's first page (1.18.0): the introduction beside the
// contents. A handbook with no introduction opens at its first policy, so
// /handbooks/{id} is always the right link to share; one with no policies
// yet says so (its editors get the way to add some).
export default async function HandbookPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const handbook = await readerHandbook(Number(id));
  if (!handbook) notFound();

  const [settings, canEdit] = await Promise.all([getAppSettings(), readerCanEdit(handbook.id)]);
  const base = await loadReaderBase(user, handbook, settingsForUser(settings, user));
  const first = base.items[0] ?? null;
  const introduction = handbook.introduction.trim();
  if (!introduction && first) redirect(policyHref(handbook.id, first.doc_id));

  // Where a reader who has begun picks up: the first policy, in reading
  // order, that still asks them to confirm.
  const begun = base.progress !== null && base.progress.confirmed > 0;
  const nextToConfirm = begun
    ? base.items.find((i) => {
        const s = base.states.get(i.doc_id);
        return s !== undefined && s !== "confirmed";
      })
    : undefined;

  return (
    <HandbookReader base={base} activeDocId={null} canEdit={canEdit}>
      {first ? (
        <HandbookIntro
          handbookId={handbook.id}
          introduction={introduction}
          start={{ href: policyHref(handbook.id, first.doc_id), title: first.title }}
          resume={nextToConfirm ? { href: policyHref(handbook.id, nextToConfirm.doc_id), title: nextToConfirm.title } : null}
        />
      ) : (
        <>
          {introduction && (
            <div className="mb-6">
              <HandbookIntro handbookId={handbook.id} introduction={introduction} start={null} resume={null} />
            </div>
          )}
          <EmptyState
            icon={<BookOpen />}
            title="No policies in this handbook yet"
            body={
              canEdit
                ? "Add published documents to its contents, and they appear here in reading order."
                : "Its policies appear here, in reading order, once its editors add them."
            }
            action={canEdit ? { href: `/handbooks/${handbook.id}/edit`, label: "Edit handbook", icon: <Pencil /> } : undefined}
          />
        </>
      )}
    </HandbookReader>
  );
}
