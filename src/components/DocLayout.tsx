"use client";

// The document page's two-column body: the article and its rail (table of
// contents, sub-pages, related documents, backlinks, attachments). At Wide
// and Full the rail is a sticky 18rem column beside the text. At Normal the
// 56rem column is too narrow to share — with the rail beside it, prose ran
// ~45 characters wide and headings wrapped line after line — so the rail
// stacks under the article instead, exactly as it does below the lg
// breakpoint at every width.
//
// The table of contents (1.9.0) goes where the rail goes: first in the rail
// when the rail is beside the article, a collapsible card above the body
// when it is not. The breakpoint is CSS, so both are rendered and one is
// shown; DocToc reads its placement from context and styles itself.
//
// A client component because it reads the width preference; the server page
// passes the pieces in as already-rendered children. Rendered as <aside>
// after the sidebar's own <aside>, so `aside` locators keep resolving to the
// sidebar first.

import { usePageWidth } from "./PageWidth";
import { TocPlacementContext } from "./DocToc";

export function DocLayout({
  children,
  aside,
  toc,
}: {
  children: React.ReactNode;
  aside: React.ReactNode;
  /** The DocToc element; placed by this layout. */
  toc?: React.ReactNode;
}) {
  const { width } = usePageWidth();
  const beside = width !== "normal";
  return (
    <div className={beside ? "lg:flex lg:items-start lg:gap-10" : ""}>
      <div className="min-w-0 flex-1">
        {toc && (
          <div className={beside ? "lg:hidden" : ""}>
            <TocPlacementContext.Provider value="card">{toc}</TocPlacementContext.Provider>
          </div>
        )}
        {children}
      </div>
      {/* top-16 clears the sticky title bar, which is visible exactly when
          this panel is stuck. */}
      <aside
        className={`mt-10 space-y-8 overflow-x-hidden border-t border-slate-100 pt-8 print:hidden ${
          beside
            ? "lg:sticky lg:top-16 lg:mt-0 lg:max-h-[calc(100vh-5.5rem)] lg:w-72 lg:shrink-0 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0"
            : ""
        }`}
      >
        {toc && beside && (
          <div className="hidden lg:block">
            <TocPlacementContext.Provider value="rail">{toc}</TocPlacementContext.Provider>
          </div>
        )}
        {aside}
      </aside>
    </div>
  );
}
