// The printed handbook (1.18.0, /handbooks/{id}/print): what the print page
// hands the sheets, already resolved and formatted for the workspace, so
// the components stay presentational and server-safe. The page builds it
// from lib/handbooks; nothing here touches the database.

export type PaperSize = "a4" | "letter";

export interface PrintPolicy {
  docId: number;
  /** 1-based, across the whole handbook ("Policy 3 of 8"). */
  number: number;
  title: string;
  /** "Policy", "SOP" — the document type's label. */
  typeLabel: string;
  spaceName: string;
  /** The current version's number (v3); null before the first version. */
  version: number | null;
  /** "Sep 1, 2026", or "" when unknown. */
  effectiveLabel: string;
  /** The policy's owner (HandbookItem.owner_name: its own, else the space's Policy owner, else whoever switched the requirement on, else the publisher of the current version, else author). */
  owner: string;
  /** "Applies to" (short text); "" when not set. */
  appliesTo: string;
  /** "In short" bullets; empty when none. */
  summaryPoints: string[];
  /** The document body (markdown). */
  content: string;
  /** Hide training-deck slide breaks on paper. */
  slideBreaks?: "hidden";
}

export interface PrintSection {
  /** 1-based; null for policies that sit outside any section. */
  number: number | null;
  title: string;
  policies: PrintPolicy[];
}

export interface PrintHandbook {
  id: number;
  title: string;
  status: "draft" | "published";
  introduction: string;
  /** Who owns it: the workspace (company name) or the space's name. */
  ownerLabel: string;
  company: string;
  logoUrl: string;
  sections: PrintSection[];
  policyCount: number;
  /** Sections with a title (the "M sections" on the cover). */
  sectionCount: number;
  /** "Nov 5, 2026" */
  printedOn: string;
  /** The reader's name. */
  printedBy: string;
  /** Absolute link to the reader, "the current version is always at". */
  currentUrl: string;
  /** The handbook asks readers to confirm online (policy_ack licensed and on). */
  confirmOnline: boolean;
  paper: PaperSize;
}

/** "1 · Working here", or just the title when the section is unnumbered. */
export function sectionLabel(s: Pick<PrintSection, "number" | "title">): string {
  return s.number === null ? s.title : `${s.number} · ${s.title}`;
}

/** "8 policies · 3 sections" — the cover's count line. */
export function countLine(policies: number, sections: number): string {
  const p = `${policies} ${policies === 1 ? "policy" : "policies"}`;
  if (sections === 0) return p;
  return `${p} · ${sections} ${sections === 1 ? "section" : "sections"}`;
}

/**
 * Whether the introduction fits on the cover. A few sentences sit under the
 * title as in the approved mock-up; anything longer, or anything with block
 * structure (headings, lists, tables), gets a page of its own after the
 * cover, because the cover is one fixed-height sheet and would otherwise
 * spill its accent background onto page 2.
 */
export function introFitsCover(intro: string): boolean {
  const text = intro.trim();
  if (!text) return true;
  if (text.length > 480) return false;
  return !/^\s*(#|[-*+] |\d+\. |\||>|```)/m.test(text);
}

/** The printed name of a paper size. */
export const PAPER_CSS: Record<PaperSize, { size: string; height: string }> = {
  a4: { size: "A4", height: "297mm" },
  letter: { size: "letter", height: "11in" },
};
