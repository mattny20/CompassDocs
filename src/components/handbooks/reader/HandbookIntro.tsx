// The handbook's first page in the reader (1.18.0): its introduction (plain
// text or Markdown, the words the printed copy opens with) and the way in,
// "Start reading" at the first policy, or "Continue" at the first policy
// still waiting for this reader's confirmation once they have begun. A
// handbook without an introduction has no such page: /handbooks/{id} goes
// straight to its first policy. Server component.

import { ArrowRight } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { Button } from "@/components/Button";
import { MarkdownView } from "@/components/MarkdownView";

export function HandbookIntro({
  handbookId,
  introduction,
  start,
  resume,
}: {
  handbookId: number;
  introduction: string;
  /** The first policy. */
  start: { href: string; title: string } | null;
  /** The first policy still to confirm, when the reader has confirmed some already. */
  resume: { href: string; title: string } | null;
}) {
  return (
    <section aria-labelledby="handbook-intro-title" className={`${CARD_CLASS} px-5 py-6 sm:px-8 sm:py-7`}>
      <h2 id="handbook-intro-title" className="text-2xl font-bold tracking-tight text-slate-900">
        Introduction
      </h2>
      <div className="doc-read mt-4">
        {/* Under the h2 "Introduction": the text's own h1 is an h3. */}
        <MarkdownView content={introduction} docKey={`handbook-intro-${handbookId}`} headingOffset={2} />
      </div>
      {(start || resume) && (
        <div className="mt-6 flex flex-wrap gap-2 print:hidden">
          {resume ? (
            <>
              <Button href={resume.href} variant="primary" className="max-w-full">
                <span className="min-w-0 truncate">Continue: {resume.title}</span>
                <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
              </Button>
              {start && start.href !== resume.href && (
                <Button href={start.href} variant="secondary">
                  Start from the beginning
                </Button>
              )}
            </>
          ) : (
            start && (
              <Button href={start.href} variant="primary" className="max-w-full">
                <span className="min-w-0 truncate">Start reading: {start.title}</span>
                <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
              </Button>
            )
          )}
        </div>
      )}
    </section>
  );
}
