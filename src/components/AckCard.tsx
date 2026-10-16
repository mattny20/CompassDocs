"use client";

// The end-of-document confirmation card (B1, 1.10.0): the one place a reader
// records that they have read a document, placed after the article so the
// reading comes first. Laid out like the training deck's final gate panel —
// an icon in a 48px circle, the title, the confirmation statement as the only
// sentence, a meta line naming the version being confirmed, and one large
// primary button. The statement printed beside the button is the question;
// it does not open a dialog (STYLEGUIDE §Overlays).
//
// Nothing here is gated (B5): the button is live from first paint. The POST
// carries the version id the page rendered, so a document that changed while
// the person was reading answers 409 {stale} and the page refreshes into the
// new text instead of recording a confirmation of words they never saw.
//
// The card is print:hidden; a one-line standing statement takes its place on
// paper so a printed policy carries the printer's own status.

import { useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleCheckBig, ClipboardCheck, ShieldCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { CARD_TITLE_TEXT } from "@/components/Heading";
import { useFormatDate } from "@/components/SettingsProvider";
import { useAckState } from "@/components/AckState";
import { useAction } from "@/lib/use-action";
import { CONFIRM_SECTION_ID } from "@/lib/use-reached-end";

/** The house statement; C2 makes it configurable per document. */
export const DEFAULT_CONFIRMATION_STATEMENT = "I confirm that I have read and understood this document.";

const STALE_MESSAGE =
  "This document changed while you were reading it. The page has been refreshed; please read the changes.";

export function AckCard({
  docId,
  statement = DEFAULT_CONFIRMATION_STATEMENT,
  meta,
  readerName,
  recordHref = "/compliance",
}: {
  docId: number;
  /** The confirmation statement (the only sentence on the card). */
  statement?: string;
  /** The version being confirmed: "Version 12 · published {date} by {author}". */
  meta: { rev: number | null; publishedLabel: string | null; author: string };
  /** The signed-in reader, for the printed standing line. */
  readerName: string;
  /** Where "View your record" goes (My policies on /compliance until F3). */
  recordHref?: string;
}) {
  const ack = useAckState();
  const fmt = useFormatDate();
  const router = useRouter();
  const { run, isBusy } = useAction();
  const section = useRef<HTMLElement>(null);

  if (!ack || !ack.canSubmit) return null;

  const confirmed = ack.ackedAt !== null;
  const versionLabel = (rev: number | null) => (rev !== null ? `version ${rev}` : null);

  async function confirm() {
    if (!ack) return;
    // Holders rather than plain lets: the assignments happen inside run()'s
    // callback, which TypeScript's narrowing cannot see.
    const outcome: {
      stale: boolean;
      recorded: { acknowledged_at: string; version_id: number | null; rev: number | null } | null;
    } = { stale: false, recorded: null };
    const ok = await run(
      "ack",
      async () => {
        const res = await fetch(`/api/documents/${docId}/ack`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version_id: ack.versionId }),
        });
        if (res.status === 409) {
          const data = (await res.json().catch(() => ({}))) as { stale?: boolean; error?: string };
          if (data?.stale) {
            // The house sentence for this case, through the same toast path
            // as every other failure; the refresh below makes it true.
            outcome.stale = true;
            return new Response(JSON.stringify({ error: STALE_MESSAGE }), {
              status: 409,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify(data), { status: 409, headers: { "content-type": "application/json" } });
        }
        if (res.ok) {
          outcome.recorded = (await res.json().catch(() => null)) as typeof outcome.recorded;
        }
        return res;
      },
      { ok: "Confirmation recorded.", fallback: "Couldn't record your confirmation." }
    );
    if (outcome.stale) {
      router.refresh();
      return;
    }
    if (ok) {
      const { recorded } = outcome;
      const at = recorded?.acknowledged_at ?? new Date().toISOString();
      ack.setAckedAt(at, {
        versionId: recorded?.version_id ?? ack.versionId,
        rev: recorded?.rev ?? ack.rev,
      });
      // The toast announces; focus lands on the section so the confirmed
      // state is the next thing a keyboard or screen-reader user meets.
      section.current?.focus({ preventScroll: true });
    }
  }

  const metaLine = [
    versionLabel(meta.rev) ? `Version ${meta.rev}` : null,
    meta.publishedLabel ? `published ${meta.publishedLabel}${meta.author ? ` by ${meta.author}` : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const confirmedSentence = confirmed
    ? versionLabel(ack.ackedRev)
      ? `You confirmed ${versionLabel(ack.ackedRev)} on ${fmt.dateTime(ack.ackedAt)}.`
      : `You confirmed reading this document on ${fmt.dateTime(ack.ackedAt)}.`
    : "";

  return (
    <>
      <section
        id={CONFIRM_SECTION_ID}
        ref={section}
        tabIndex={-1}
        aria-labelledby={`${CONFIRM_SECTION_ID}-title`}
        // scroll-mt-20 is the same 5rem the headings use to clear the sticky bar.
        className={`${CARD_CLASS} mt-10 scroll-mt-20 p-6 print:hidden sm:p-8`}
      >
        <div className="flex flex-col items-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-compass-50 text-compass-600">
            {confirmed ? (
              <CircleCheckBig className="h-6 w-6 text-emerald-500" aria-hidden />
            ) : (
              <ShieldCheck className="h-6 w-6" aria-hidden />
            )}
          </span>
          <h2 id={`${CONFIRM_SECTION_ID}-title`} className={`${CARD_TITLE_TEXT} mt-3`}>
            {confirmed ? "Confirmation recorded" : "Confirm you've read this document"}
          </h2>

          {confirmed ? (
            <>
              <p className="mt-2 max-w-md text-sm text-slate-600">{confirmedSentence}</p>
              <Link
                href={recordHref}
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-compass-600 hover:underline"
              >
                <ClipboardCheck className="h-4 w-4" aria-hidden /> View your record
              </Link>
            </>
          ) : (
            <>
              <p className="mt-2 max-w-md text-sm text-slate-600">{statement}</p>
              {metaLine && <p className="mt-1 text-xs text-slate-500">{metaLine}</p>}
              <Button
                variant="primary"
                size="lg"
                icon={<ShieldCheck />}
                busy={isBusy("ack")}
                onClick={() => void confirm()}
                className="mt-5 w-full sm:w-auto"
              >
                I&apos;ve read and understood this
              </Button>
            </>
          )}
        </div>
      </section>

      {/* The printed policy carries the printer's standing instead of the card. */}
      <p className="mt-6 hidden text-xs text-slate-500 print:block">
        {confirmed
          ? `Read confirmation recorded for ${readerName} on ${fmt.dateTime(ack.ackedAt)}${
              versionLabel(ack.ackedRev) ? ` · ${versionLabel(ack.ackedRev)}` : ""
            }`
          : `Read confirmation required. Not yet confirmed by ${readerName}`}
      </p>
    </>
  );
}
