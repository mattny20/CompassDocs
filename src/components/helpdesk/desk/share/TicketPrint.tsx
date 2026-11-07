// A ticket on paper (1.19.4, area C6; mock-up u5). On screen it is a preview:
// one white sheet on the canvas, with the header line and the footer drawn
// in it. On paper those two lines are page furniture instead (@page margin
// boxes, so they repeat on every page with the printer's page numbers) and
// the in-sheet copies are hidden. The sheet is paper in both themes: it
// borrows the printed handbook's sheet styles, which re-declare the light
// tokens (STYLEGUIDE §Print). Messages never split across pages.
//
// Server-safe: the toolbar is the only client piece.

import { MarkdownView } from "@/components/MarkdownView";
import { cssString } from "@/components/handbooks/print/page-css";
import { PAPER_CSS } from "@/components/handbooks/print/print-model";
import sheetStyles from "@/components/handbooks/print/HandbookPrint.module.css";
import type { HdTicketPrint } from "@/lib/helpdesk/share";

const FURNITURE = `font-family: "Aileron", ui-sans-serif, system-ui, sans-serif; font-size: 7.5pt; color: #5a6980;`;

/** The page boxes: "Acme · IT Service Desk" | "Ticket #1047" on top, the printed-by sentence | "Page 1 of 2" below. */
export function ticketPageCss(t: Pick<HdTicketPrint, "workspace" | "team" | "number" | "footer" | "paper">): string {
  const top = `vertical-align: bottom; padding-bottom: 2.5mm; border-bottom: 0.5pt solid #e2e8f0; ${FURNITURE}`;
  const bottom = `vertical-align: top; padding-top: 2.5mm; border-top: 0.5pt solid #e2e8f0; ${FURNITURE}`;
  return `@page {
  size: ${PAPER_CSS[t.paper].size};
  margin: 18mm 16mm 20mm;
  @top-left { content: ${cssString(headerLine(t))}; text-align: left; ${top} }
  @top-right { content: ${cssString(`Ticket #${t.number}`)}; text-align: right; ${top} }
  @bottom-left { content: ${cssString(t.footer)}; text-align: left; width: 75%; ${bottom} }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); text-align: right; ${bottom} }
}
@media print {
  html { font-size: 10.5pt; }
}`;
}

function headerLine(t: Pick<HdTicketPrint, "workspace" | "team">): string {
  return t.team ? `${t.workspace} · ${t.team}` : t.workspace;
}

const SECTION = "mt-6 border-b border-slate-200 pb-1 text-sm font-bold text-slate-900 break-after-avoid";
const MUTED = "text-slate-500";

export function TicketPrint({ t, toolbar }: { t: HdTicketPrint; toolbar?: React.ReactNode }) {
  const paper = t.paper === "letter" ? sheetStyles.letter : sheetStyles.a4;
  return (
    <div className={sheetStyles.stage}>
      {/* The page boxes carry the subject's ticket number and people's names, so they are written per request; cssString escapes them. */}
      <style dangerouslySetInnerHTML={{ __html: ticketPageCss(t) }} />
      {toolbar}
      <article className={`${sheetStyles.sheet} ${sheetStyles.paper} ${paper} text-sm leading-relaxed`} aria-labelledby="print-subject" data-testid="ticket-print">
        <div className={`flex justify-between gap-4 border-b border-slate-200 pb-2 text-2xs ${MUTED} print:hidden`}>
          <span>{headerLine(t)}</span>
          <span>Ticket #{t.number}</span>
        </div>
        <div className={sheetStyles.grow}>
          <h2 id="print-subject" className="mt-4 text-xl font-bold text-slate-900 print:mt-0">
            #{t.number} {t.subject}
          </h2>

          {t.details && (
            <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 text-xs sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
              {t.details.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className={`border-b border-slate-100 py-1.5 ${MUTED}`}>{k}</dt>
                  <dd className="min-w-0 break-words border-b border-slate-100 py-1.5 text-slate-800">{v}</dd>
                </div>
              ))}
            </dl>
          )}

          <h3 className={SECTION}>Conversation</h3>
          {t.messages.length === 0 ? (
            <p className={`mt-2 ${MUTED}`}>No replies yet.</p>
          ) : (
            <ol className="mt-1">
              {t.messages.map((m) =>
                m.system ? (
                  // A system-written note is Markdown, as the desk shows it (names in it are
                  // escaped by lib/helpdesk/md-inline); a one-line event keeps its time on its line.
                  <li
                    key={m.id}
                    className={`${sheetStyles.keep} mt-2 break-inside-avoid text-xs text-slate-600 [&>.doc-prose]:inline [&>.doc-prose>p:last-child]:inline [&_.doc-prose]:text-xs! [&_.doc-prose]:leading-relaxed! [&_.doc-prose]:text-slate-600! [&_.doc-prose_p]:my-0`}
                    data-kind="event"
                  >
                    <MarkdownView content={m.body} headingOffset={3} /> <span className={MUTED}>· {m.meta.replace(/ · internal note$/, "")}</span>
                  </li>
                ) : (
                <li
                  key={m.id}
                  className={`${sheetStyles.keep} mt-3 break-inside-avoid ${m.internal ? "border-l-2 border-amber-400 pl-3" : ""}`}
                  data-kind={m.internal ? "internal" : "public"}
                >
                  <p>
                    <b className="font-semibold text-slate-900">{m.author}</b> <span className={MUTED}>{m.meta}</span>
                  </p>
                  <div className="mt-0.5 [&_.doc-prose]:text-sm! [&_.doc-prose]:leading-relaxed! [&_.doc-prose_p]:my-1">
                    <MarkdownView content={m.body} headingOffset={3} />
                  </div>
                </li>
                )
              )}
            </ol>
          )}

          {t.checklists && t.checklists.length > 0 &&
            t.checklists.map((c, i) => (
              <section key={`${c.name}-${i}`} className={sheetStyles.keep}>
                <h3 className={SECTION}>
                  Checklist: {c.name} ({c.done} of {c.total} done)
                </h3>
                <ul className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
                  {c.items.map((it, j) => (
                    <li key={j}>
                      <span aria-hidden>{it.done ? "☑" : "☐"}</span> {it.title}
                      <span className="sr-only">{it.done ? " (done)" : " (not done)"}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

          {t.assets && t.assets.length > 0 && (
            <section className={sheetStyles.keep}>
              <h3 className={SECTION}>Linked assets</h3>
              <ul className="mt-1.5 space-y-0.5">
                {t.assets.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </section>
          )}

          {t.time && (
            <section className={sheetStyles.keep}>
              <h3 className={SECTION}>Time logged ({t.time.total})</h3>
              {t.time.entries.length === 0 ? (
                <p className={`mt-1.5 ${MUTED}`}>No time logged.</p>
              ) : (
                <ul className="mt-1.5 space-y-0.5">
                  {t.time.entries.map((e, i) => (
                    <li key={i}>
                      {e.who} · {e.minutes} <span className={MUTED}>{e.when}</span>
                      {e.note && ` · ${e.note}`}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {t.attachments && t.attachments.length > 0 && (
            <section className={sheetStyles.keep}>
              <h3 className={SECTION}>Attachments</h3>
              <ul className="mt-1.5 space-y-0.5">
                {t.attachments.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <p className={`mt-10 flex justify-between gap-4 border-t border-slate-200 pt-2 text-2xs ${MUTED} print:hidden`}>
          <span>{t.footer}</span>
          <span className="shrink-0">Page numbers are added on paper</span>
        </p>
      </article>
    </div>
  );
}
