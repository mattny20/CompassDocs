// Helpdesk 1.19.2: what is new in the desk settings rail (agent W5),
// client-safe. One small versioned list: the pages a release adds, each
// shown with a "New" chip in the rail until the person has opened it, and
// the release strip ("New in 1.19.2: …") until they dismiss it. A release
// replaces the list and the version; nothing else changes. Seen pages are
// stored per person (lib/helpdesk/whats-new, hd_desk_seen), so a page
// someone opened once stays unflagged for them in later releases too.

export const DESK_NEW_RELEASE = "1.19.2";

export interface DeskNewPage {
  href: string;
  label: string;
}

/** The pages 1.19.2 adds to Desk settings (labels as the rail shows them). */
export const DESK_NEW_PAGES: readonly DeskNewPage[] = [
  { href: "/desk/settings/skills", label: "Skills and languages" },
  { href: "/desk/settings/canned", label: "Canned responses" },
  { href: "/desk/settings/checklists", label: "Checklists" },
];

/** The release strip's seen-record key. */
export const DESK_NEW_STRIP = `strip:${DESK_NEW_RELEASE}`;

/** A key the seen record accepts: one of this release's pages, or its strip. */
export function isDeskNewItem(item: unknown): item is string {
  return typeof item === "string" && (item === DESK_NEW_STRIP || DESK_NEW_PAGES.some((p) => p.href === item));
}

/** The New page an address is on (a page or anything under it), or undefined. */
export function deskNewPageFor(pathname: string): DeskNewPage | undefined {
  return DESK_NEW_PAGES.find((p) => pathname === p.href || pathname.startsWith(`${p.href}/`));
}

/** "A, B and C". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What one person still has to see: the New pages they have not opened, and whether the strip shows. */
export interface DeskNewState {
  release: string;
  /** Hrefs of New pages not opened yet (only pages this person's rail shows). */
  unseen: string[];
  /** The release strip is still showing. */
  strip: boolean;
}
