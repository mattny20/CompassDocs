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
// new text instead of recording a confirmation of words they never saw. It
// also carries `reached_end` (C3, 1.11.0): whether the end of the article
// has been on screen, read from the shared latch; a self-report, stored as
// evidence beside the server-measured reading time, never a gate.
//
// A re-confirmation (B3, 1.11.0) does not look like a first request: above
// the statement one line says why the reader is asked again (the change
// note, the manager's reason, or the annual cycle), and when the text
// changed a native <details> lists the versions since the one they
// confirmed with the rendered diff against it and a link to the same
// compare in version history. A manual or annual re-ask with no text change
// shows the reason line and no disclosure: nothing changed to show. The
// texts arrive as props from the page, so no endpoint serves them.
//
// The card is print:hidden; a one-line standing statement takes its place on
// paper so a printed policy carries the printer's own status.
//
// The confirmed state is a sentence, not a link: "View your record" arrives
// with My policies (1.11.1), the one page every reader can open. /compliance
// is the program view, gated on compliance.program_read, so a link there
// would bounce most readers to the dashboard.

import { useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CircleCheckBig, History, ShieldCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { CardTitle } from "@/components/Heading";
import { DocDiff } from "@/components/DocDiff";
import { useFormatDate } from "@/components/SettingsProvider";
import { monthsLabel, useAckState } from "@/components/AckState";
import type { AckReason } from "@/components/AckState";
import { diffLines, diffStats } from "@/lib/diff";
import { useAction } from "@/lib/use-action";
import { CONFIRM_SECTION_ID } from "@/lib/use-reached-end";

/** The house statement; C2 makes it configurable per document. */
export const DEFAULT_CONFIRMATION_STATEMENT = "I confirm that I have read and understood this document.";

const STALE_MESSAGE =
  "This document changed while you were reading it. The page has been refreshed; please read the changes.";

/** A version written since the one the reader confirmed (B3). */
export interface VersionSince {
  id: number;
  rev: number;
  note: string;
  author: string;
  createdAt: string;
}

/** A title and a text to compare (the confirmed version and the text on screen). */
export interface AckText {
  title: string;
  content: string;
}

/**
 * The one line above the statement that says why the reader is asked again.
 * Every text change reads as an update with its note; the manual and
 * per-person re-asks name who asked and why; the annual cycle says how long
 * it has been.
 */
export function reasonSentence(r: AckReason, date: (iso: string) => string): string {
  const quoted = (note: string) => (note ? `: "${note}"` : ".");
  switch (r.kind) {
    case "edit":
      return `Updated ${date(r.at)}${r.by ? ` by ${r.by}` : ""}${quoted(r.note)}`;
    case "manual":
      return `${r.by || "A manager"} asked everyone to confirm this document again on ${date(r.at)}${quoted(r.note)}`;
    case "person":
      return `${r.by || "A manager"} asked you to confirm this document again on ${date(r.at)}${quoted(r.note)}`;
    case "recurrence":
      return `Annual re-confirmation. It has been ${monthsLabel(r.months)} since you confirmed this document. Please read it again and confirm.`;
  }
}

export function AckCard({
  docId,
  statement = DEFAULT_CONFIRMATION_STATEMENT,
  meta,
  readerName,
  current,
  baseline = null,
  changesSince = [],
}: {
  docId: number;
  /** The confirmation statement (the only sentence on the card). */
  statement?: string;
  /** The version being confirmed: "Version 12 · published {date} by {author} · approved by {approvedBy}" (C6). */
  meta: { rev: number | null; publishedLabel: string | null; author: string; approvedBy?: string };
  /** The signed-in reader, for the printed standing line. */
  readerName: string;
  /** The text on screen, for the what-changed diff (B3). */
  current?: AckText;
  /** The text the reader confirmed (B3); null when it cannot be read. */
  baseline?: AckText | null;
  /** Versions written since the confirmed one, newest first (B3). */
  changesSince?: VersionSince[];
}) {
  const ack = useAckState();
  const fmt = useFormatDate();
  const router = useRouter();
  const { run, isBusy } = useAction();
  const section = useRef<HTMLElement>(null);
  // Lines added and removed since the confirmed version: the disclosure's
  // header. Measured once per pair of texts, and only when there is a pair.
  const stats = useMemo(
    () => (baseline && current ? diffStats(diffLines(baseline.content, current.content)) : null),
    [baseline, current]
  );

  if (!ack || !ack.canSubmit) return null;

  const confirmed = ack.ackedAt !== null;
  const prior = confirmed ? null : (ack.prior ?? null);
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
          // The self-reported evidence (C3) rides with the version: the
          // server measures the reading time itself and trusts nothing else.
          body: JSON.stringify({ version_id: ack.versionId, reached_end: ack.reachedEnd }),
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
    meta.approvedBy ? `approved by ${meta.approvedBy}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const confirmedSentence = confirmed
    ? versionLabel(ack.ackedRev)
      ? `You confirmed ${versionLabel(ack.ackedRev)} on ${fmt.dateTime(ack.ackedAt)}.`
      : `You confirmed reading this document on ${fmt.dateTime(ack.ackedAt)}.`
    : "";

  // The disclosure exists only when the text changed since the confirmed
  // version; a manual or annual re-ask without a text change has nothing
  // to show, and the reason line stands alone.
  const showChanges = Boolean(prior && prior.changed && changesSince.length > 0);
  const historyHref = prior && prior.versionId !== null ? `/doc/${docId}/history?from=${prior.versionId}&to=current` : null;

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
          <CardTitle as="h2" id={`${CONFIRM_SECTION_ID}-title`} className="mt-3">
            {confirmed ? "Confirmation recorded" : "Confirm you've read this document"}
          </CardTitle>

          {confirmed ? (
            <>
              <p className="mt-2 max-w-md text-sm text-slate-600">{confirmedSentence}</p>
              {/* A kept edit (A2): the confirmation still counts but cites an
                  older version than the text on screen. Re-confirming posts
                  the latest version id; the ledger keeps both rows. */}
              {ack.ackedVersionId !== null && ack.versionId !== null && ack.ackedVersionId !== ack.versionId && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ShieldCheck />}
                  busy={isBusy("ack")}
                  onClick={() => void confirm()}
                  className="mt-3"
                >
                  Re-confirm the current text{ack.rev !== null ? ` (v${ack.rev})` : ""}
                </Button>
              )}
            </>
          ) : (
            <>
              {prior?.reason && (
                <p className="mt-2 max-w-md text-sm font-medium text-slate-700">
                  {reasonSentence(prior.reason, fmt.date)}
                </p>
              )}
              <p className="mt-2 max-w-md text-sm text-slate-600">{statement}</p>
              {metaLine && <p className="mt-1 text-xs text-slate-500">{metaLine}</p>}

              {showChanges && prior && (
                <details className="mt-5 w-full rounded-lg border border-slate-200 bg-surface text-left [&[open]>summary]:border-b [&[open]>summary]:border-slate-100">
                  <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-slate-700 hover:text-compass-700 marker:text-compass-500">
                    What changed since you last confirmed ({changesSince.length} version
                    {changesSince.length === 1 ? "" : "s"})
                  </summary>
                  {prior.rev !== null && (
                    <p className="px-4 pt-3 text-xs text-slate-500">
                      Compared with version {prior.rev}
                      {prior.inferred ? " (version inferred)" : ""}, which you confirmed on {fmt.date(prior.ackedAt)}.
                    </p>
                  )}
                  <ol className="divide-y divide-slate-100 px-4 py-1 text-sm">
                    {changesSince.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
                        <span className="font-medium text-slate-800">v{v.rev}</span>
                        {v.note && <span className="min-w-0 flex-1 text-slate-700">{v.note}</span>}
                        <span className="text-xs text-slate-500">
                          {v.author}
                          {v.author ? " · " : ""}
                          {fmt.date(v.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {stats && baseline && current && (
                    <>
                      <div className="border-t border-slate-100 px-4 py-2 text-xs font-medium text-slate-700">
                        <span className="text-emerald-600">+{stats.added}</span> /{" "}
                        <span className="text-red-500">−{stats.removed}</span> lines
                      </div>
                      {/* Bounded so a long policy's diff never swallows the
                          page; the diff folds unchanged runs on its own. */}
                      <div className="max-h-[max(24rem,50vh)] overflow-auto border-t border-slate-100">
                        <DocDiff
                          oldText={baseline.content}
                          newText={current.content}
                          oldTitle={baseline.title}
                          newTitle={current.title}
                          docKey={`since-${docId}`}
                          className="overflow-x-auto"
                        />
                      </div>
                    </>
                  )}
                  {historyHref && (
                    <div className="border-t border-slate-100 px-4 py-2.5 text-sm">
                      <Link
                        href={historyHref}
                        className="inline-flex items-center gap-1.5 font-medium text-compass-700 hover:underline"
                      >
                        <History className="h-4 w-4" aria-hidden />
                        Open in version history
                      </Link>
                    </div>
                  )}
                </details>
              )}

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
