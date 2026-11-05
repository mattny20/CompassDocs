// The handbook reader's frame (1.18.0, the approved 2-reader and
// 6-policy-view mock-ups), shared by /handbooks/{id} (the introduction)
// and /handbooks/{id}/{docId} (one policy): the page skeleton (breadcrumb,
// PageHeader with the BookOpen icon, the "N policies in M sections ·
// updated … · owned by …" subtitle, "Print or save as PDF" and, when the
// handbook asks for it under the licence, "Confirm handbook"), then the
// contents rail beside the pane from lg and above it on a phone.
// Server component.

import { BookOpen, Pencil, Printer, ShieldCheck } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Button } from "@/components/Button";
import { HandbookContents } from "./HandbookContents";
import { IN_SHORT_ID } from "./InShort";
import { handbookHref, type ReaderBase } from "./reader-data";

export function HandbookReader({
  base,
  activeDocId,
  activeHasInShort = false,
  canEdit,
  children,
}: {
  base: ReaderBase;
  /** The policy on screen; null on the introduction. */
  activeDocId: number | null;
  activeHasInShort?: boolean;
  /** The reader may edit this handbook (its editors see drafts and an Edit button). */
  canEdit: boolean;
  children: React.ReactNode;
}) {
  const { handbook } = base;
  const href = handbookHref(handbook.id);
  const draft = handbook.status !== "published";
  const actions = (
    <>
      {canEdit && (
        <Button href={`${href}/edit`} variant="secondary" icon={<Pencil />} className="print:hidden">
          Edit
        </Button>
      )}
      <Button href={`${href}/print?print=1`} variant="secondary" icon={<Printer />} className="print:hidden">
        Print or save as PDF
      </Button>
      {base.confirmWhole && !draft && base.items.length > 0 && (
        <Button href={`${href}/confirm`} variant="primary" icon={<ShieldCheck />} className="print:hidden">
          Confirm handbook
        </Button>
      )}
    </>
  );
  return (
    <PageContainer>
      <Breadcrumbs items={[{ href: "/handbooks", label: "Handbooks" }]} className="mb-2" />
      <PageHeader icon={<BookOpen />} title={handbook.title} subtitle={base.subtitle} actions={actions} />

      {draft && (
        <div className="notice-warn mb-5 rounded-lg border px-3 py-2 text-sm print:hidden">
          This handbook is a draft. Only its editors can see it until it is published.
        </div>
      )}

      {base.items.length === 0 ? (
        children
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <HandbookContents
            sections={base.contents}
            activeDocId={activeDocId}
            introHref={href}
            introActive={activeDocId === null}
            hasIntroduction={handbook.introduction.trim() !== ""}
            inShortId={activeHasInShort ? IN_SHORT_ID : null}
            progress={base.progress}
          />
          <div className="min-w-0">{children}</div>
        </div>
      )}
    </PageContainer>
  );
}
