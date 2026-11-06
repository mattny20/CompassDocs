// One policy as the handbook reader shows it (1.18.0, the approved
// 6-policy-view mock-up): a masthead on an accent wash (the type, "Handbook
// only" when that is where people find it, "Policy k of N" (SOP / Document
// k of N for other contents, lib/handbook-shared), the reader's
// status chip), the title, the facts row; then "In short", "What changed in
// version N" for a reader who confirmed an earlier version, the body
// through the app's document renderer (MarkdownView in a doc-read article,
// the reading measure and every block the document page renders), the
// confirm bar and the related documents.
//
// The page h1 is the handbook's (PageHeader), so the policy title is an h2
// at the document-title size: within a handbook the policy is a chapter,
// and the heading ladder stays one h1 per page. The body's own headings move
// two levels down under it (MarkdownView headingOffset: its h1 is an h3).
// Server component.

import Link from "next/link";
import { CARD_CLASS } from "@/components/Card";
import { TypeBadge } from "@/components/Badges";
import { MarkdownView } from "@/components/MarkdownView";
import { AckProvider } from "@/components/AckState";
import { ViewTracker } from "@/components/ViewTracker";
import { StandingChip } from "../confirm/StandingChip";
import { HandbookOnlyChip } from "../HandbookOnlyChip";
import { PolicyFacts } from "./PolicyFacts";
import { InShort } from "./InShort";
import { WhatChanged } from "./WhatChanged";
import { PolicyConfirmBar } from "./PolicyConfirmBar";
import type { PolicyView } from "./reader-data";
import { AskAboutPolicyTrigger } from "@/components/helpdesk/help/server-triggers";

export function PolicyPage({ view }: { view: PolicyView }) {
  return (
    <div className={`${CARD_CLASS} min-w-0 overflow-hidden print:border-0 print:shadow-none`}>
      <ViewTracker docId={view.docId} />
      <header className="border-b border-slate-100 bg-linear-to-b from-compass-50 to-transparent px-5 pb-5 pt-5 sm:px-8 sm:pt-6 print:bg-none print:px-0">
        <div className="flex flex-wrap items-center gap-2">
          <TypeBadge type={view.type} />
          {view.handbookOnly && <HandbookOnlyChip handbooks={[view.handbookTitle]} />}
          <span className="text-xs text-slate-500">{view.position}</span>
          {view.standing && (
            <span className="ml-auto">
              <StandingChip standing={view.standing} />
            </span>
          )}
        </div>
        <h2 className="mt-2.5 text-3xl font-bold tracking-tight text-slate-900">{view.title}</h2>
        <div className="mt-4">
          <PolicyFacts facts={view.facts} />
        </div>
      </header>

      <div className="px-5 pb-6 pt-5 sm:px-8 sm:pb-7 print:px-0">
        {(view.summaryPoints.length > 0 || view.whatChanged) && (
          <div className="mb-6 space-y-3.5">
            <InShort points={view.summaryPoints} />
            {view.whatChanged && <WhatChanged {...view.whatChanged} />}
          </div>
        )}

        <AckProvider seed={view.ackSeed}>
          {/* doc-read: the reading measure, and the article the reached-the-end
              latch and the contents rail's headings read. */}
          <article className="doc-read [&_.doc-prose>:first-child]:mt-0!" aria-label={view.title}>
            {/* headingOffset: the policy title is this page's h2, so the
                body's own h1 is an h3 (the rail reads the shifted levels). */}
            <MarkdownView
              content={view.content}
              docKey={`handbook-doc-${view.docId}`}
              dropTitle={view.title}
              headingOffset={2}
            />
          </article>

          <PolicyConfirmBar
            docId={view.docId}
            handbookId={view.confirm.handbookId}
            title={view.title}
            noun={view.noun}
            handbookNoun={view.handbookNoun}
            statement={view.confirm.statement}
            signature={view.confirm.signature}
            localAccount={view.confirm.localAccount}
            signedName={view.confirm.signedName}
            readerName={view.confirm.readerName}
            forInformation={view.confirm.forInformation}
            prev={view.prev}
            next={view.next}
            finish={view.finish}
          />
        </AckProvider>

        {view.related.length > 0 && (
          <p className="mt-3.5 text-sm text-slate-500 print:hidden">
            Related:{" "}
            {view.related.map((r, i) => (
              <span key={r.href}>
                {i > 0 && <span aria-hidden> · </span>}
                <Link href={r.href} className="link font-medium">
                  {r.title}
                </Link>
              </span>
            ))}
          </p>
        )}

        <AskAboutPolicyTrigger
          handbookId={view.confirm.handbookId}
          handbookTitle={view.handbookTitle}
          docId={view.docId}
          title={view.title}
        />
      </div>
    </div>
  );
}
