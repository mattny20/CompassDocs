// The printed handbook (1.18.0): the cover, an introduction page when the
// introduction is too long for the cover, the contents, one sheet per
// policy and the acknowledgement page with lines to sign. On screen it is
// a preview of the paper copy; on paper the @page rules from page-css.ts
// add the margins, the running header of each policy and the footer with
// the page number. Server-safe: the toolbar is the only client piece.
//
// Page numbers are not printed in the contents: Chromium has no
// target-counter(), so a page number for a policy cannot be known before the
// printer lays it out. The contents numbers the policies instead, and every
// page of a policy carries "Policy k of N" in its running header.

import { MarkdownView } from "@/components/MarkdownView";
import { BrandTile } from "@/components/Brand";
import { SectionEmpty } from "@/components/form";
import { EYEBROW_TEXT } from "@/components/Heading";
import { boldRuns } from "../reader/InShort";
import styles from "./HandbookPrint.module.css";
import { handbookPageCss, policyPageName } from "./page-css";
import {
  countLine,
  eachItemNoun,
  introFitsCover,
  itemsNoun,
  positionLine,
  sectionLabel,
  type PrintHandbook,
  type PrintPolicy,
  type PrintSection,
} from "./print-model";

const FURNITURE_TEXT = "text-2xs text-slate-500";

export function HandbookPrint({ hb, toolbar }: { hb: PrintHandbook; toolbar?: React.ReactNode }) {
  const paper = hb.paper === "letter" ? styles.letter : styles.a4;
  const sheet = `${styles.sheet} ${styles.paper} ${paper}`;
  const introOnCover = introFitsCover(hb.introduction);
  const draft = hb.status === "draft";

  return (
    <div className={styles.stage}>
      {/* The page boxes carry the handbook's own title, so they are written
          per request; page-css escapes every string for the <style>. */}
      <style dangerouslySetInnerHTML={{ __html: handbookPageCss(hb) }} />
      {toolbar}

      {/* The page's h1 is the toolbar's "Print preview" (never printed); on
          paper the cover's title heads the document, one h2 per sheet. A
          policy's body (and the introduction page's text) sits under its
          sheet's h2, so its own h1 is an h3 (MarkdownView headingOffset). */}
      <section className={`${sheet} ${styles.cover}`} style={{ page: "hb-cover" }} aria-label="Cover">
        <div className="flex items-center gap-2.5 text-sm font-semibold">
          <BrandTile logoUrl={hb.logoUrl || undefined} className={styles.coverMark} />
          {hb.company}
        </div>
        <div className="mt-[28%]">
          <p className="text-xs font-semibold uppercase tracking-widest opacity-80">
            Handbook{draft ? " · Draft" : ""}
          </p>
          <h2 className="mt-3 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">{hb.title}</h2>
          {introOnCover && hb.introduction.trim() && (
            <div className="mt-5 max-w-[34rem] text-sm sm:text-base">
              <MarkdownView content={hb.introduction} docKey={`hb-print-intro-${hb.id}`} inline />
            </div>
          )}
        </div>
        <div className={`mt-auto pt-8 text-xs leading-relaxed opacity-90 ${styles.grow} flex flex-col justify-end`}>
          <p>{countLine(hb.policyCount, hb.sectionCount, hb.mix)}</p>
          <p>
            Printed {hb.printedOn} by {hb.printedBy}
          </p>
          <p className="break-words">The current version is always at {hb.currentUrl}</p>
        </div>
      </section>

      {!introOnCover && (
        <section className={sheet} aria-labelledby="hb-print-intro">
          <div className={styles.grow}>
            <h2 id="hb-print-intro" className="mb-4 text-2xl font-bold text-slate-900">
              Introduction
            </h2>
            <MarkdownView content={hb.introduction} docKey={`hb-print-intro-${hb.id}`} headingOffset={2} />
          </div>
          <ScreenFooter hb={hb} />
        </section>
      )}

      <section className={sheet} aria-labelledby="hb-print-contents">
        <div className={styles.grow}>
          <h2 id="hb-print-contents" className="text-2xl font-bold text-slate-900">
            Contents
          </h2>
          {hb.policyCount === 0 ? (
            <SectionEmpty className="mt-4">
              This handbook has no policies yet. Policies appear here, numbered, once they are added in the editor.
            </SectionEmpty>
          ) : (
            hb.sections.map((s, i) => <ContentsSection key={i} section={s} />)
          )}
          <p className={`${EYEBROW_TEXT} mb-1 mt-6`}>Acknowledgement</p>
          <p className="py-1 pl-7 text-sm font-semibold text-slate-900">Signature page</p>
        </div>
        <ScreenFooter hb={hb} />
      </section>

      {hb.sections.flatMap((s) =>
        s.policies.map((p) => <PolicySheet key={p.docId} hb={hb} section={s} policy={p} className={sheet} />)
      )}

      <section className={sheet} aria-labelledby="hb-print-sign">
        <div className={styles.grow}>
          <h2 id="hb-print-sign" className="text-2xl font-bold text-slate-900">
            Acknowledgement
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            I confirm that I have received, read and understood the {hb.title} (
            {countLine(hb.policyCount, 0, hb.mix)}, listed in the contents), and that I agree to follow the {itemsNoun(hb)} it
            contains.
          </p>
          <div className={`mt-4 space-y-5 ${styles.keep}`}>
            {["Full name", "Signature", "Date", "Manager"].map((label) => (
              <div key={label}>
                <div className={styles.line} aria-hidden />
                <p className="mt-1 text-xs text-slate-500">{label}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-xs leading-relaxed text-slate-500">
            {hb.confirmOnline ? (
              <>
                Return this page to {hb.ownerLabel}, or confirm online at {hb.currentUrl}, where your confirmation is
                recorded against each {eachItemNoun(hb)}&apos;s version.
              </>
            ) : (
              <>
                Return this page to {hb.ownerLabel}. The current version is always at {hb.currentUrl}.
              </>
            )}
          </p>
        </div>
        <ScreenFooter hb={hb} />
      </section>
    </div>
  );
}

function ContentsSection({ section }: { section: PrintSection }) {
  if (section.policies.length === 0) return null;
  return (
    <div className={styles.keep}>
      {section.title && <p className={`${EYEBROW_TEXT} mb-1 mt-6`}>{sectionLabel(section)}</p>}
      <ol className={section.title ? "" : "mt-6"}>
        {section.policies.map((p) => (
          <li key={p.docId} className="flex items-baseline gap-2 py-1 text-sm">
            <span className="w-5 shrink-0 tabular-nums text-slate-500">{p.number}</span>
            <span className="min-w-0">
              <span className="font-semibold text-slate-900">{p.title}</span>{" "}
              <span className="text-slate-500">
                {p.spaceName}
                {p.version !== null && ` · v${p.version}`}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PolicySheet({
  hb,
  section,
  policy: p,
  className,
}: {
  hb: PrintHandbook;
  section: PrintSection;
  policy: PrintPolicy;
  className: string;
}) {
  const head = `hb-print-policy-${p.docId}`;
  const meta = [
    p.spaceName,
    p.version !== null ? `Version ${p.version}` : "",
    p.effectiveLabel ? `Effective ${p.effectiveLabel}` : "",
    p.owner ? `Owner: ${p.owner}` : "",
  ].filter(Boolean);
  const points = p.summaryPoints.map((s) => s.trim()).filter(Boolean);
  return (
    <section className={className} style={{ page: policyPageName(p.number) }} aria-labelledby={head}>
      <div className={styles.grow}>
        {/* On paper this line is the @page running header, on every page. */}
        <div
          className={`flex justify-between gap-4 border-b border-slate-200 pb-1.5 print:hidden ${FURNITURE_TEXT}`}
        >
          <span>{section.title ? sectionLabel(section) : hb.title}</span>
          <span className="shrink-0">{positionLine(hb, p.number)}</span>
        </div>
        <div className={styles.policyHead}>
          <p className="mt-4 text-xs text-slate-500 print:mt-0">
            <span className="text-2xs font-semibold uppercase tracking-wider">{p.typeLabel}</span>
            {meta.map((m) => (
              <span key={m}> · {m}</span>
            ))}
          </p>
          <h2 id={head} className="mt-1.5 text-3xl font-bold tracking-tight text-slate-900">
            {p.title}
          </h2>
          {p.appliesTo && (
            <p className="mt-1.5 text-xs text-slate-600">
              <span className="font-semibold text-slate-700">Applies to:</span> {p.appliesTo}
            </p>
          )}
        </div>
        {points.length > 0 && (
          <div className={`mt-4 rounded-lg border border-compass-200 px-4 py-3 ${styles.keep}`}>
            <h3 className="mb-1 text-sm font-bold text-compass-700">In short</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-slate-700 marker:text-compass-500">
              {/* The reader's rule: **bold** is the only markup a point keeps. */}
              {points.map((pt, i) => (
                <li key={i}>{boldRuns(pt)}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-5">
          <MarkdownView
            content={p.content}
            docKey={`hb-print-${p.docId}`}
            slideBreaks={p.slideBreaks}
            dropTitle={p.title}
            headingOffset={2}
          />
        </div>
      </div>
      <ScreenFooter hb={hb} />
    </section>
  );
}

/** The footer as the preview shows it; on paper it is the @page footer. */
function ScreenFooter({ hb }: { hb: PrintHandbook }) {
  return (
    <div
      aria-hidden
      className={`mt-8 flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-slate-200 pt-1.5 print:hidden ${FURNITURE_TEXT}`}
    >
      <span>
        {hb.title} · {hb.company}
      </span>
      <span>
        {hb.status === "draft" ? "Draft · " : ""}Printed {hb.printedOn} by {hb.printedBy} · uncontrolled when printed
      </span>
    </div>
  );
}
