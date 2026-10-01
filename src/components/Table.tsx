// Tables, step one (STYLEGUIDE §Tables): one header recipe on every table —
// the larger eyebrow tier at an AA grey, semibold, with tabular numerals
// (set once on <table> in globals.css). Sort, sticky headers and hover
// arrive in step two. Server-safe.

import type { ReactNode } from "react";
import { EYEBROW_TEXT } from "./Heading";

/** The header row: put it on <thead> (or the header <tr>). */
export const TABLE_HEAD_ROW = `border-b border-slate-100 text-left ${EYEBROW_TEXT}`;
/** The header cell. */
export const TH = "px-4 py-2.5";
/** The body cell. */
export const TD = "px-4 py-3";
/** Body rows. */
export const TR = "border-b border-slate-100 last:border-b-0";

/** A table inside a card: the wrapper scrolls sideways on narrow screens
 *  instead of breaking the page. */
export function TableWrap({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`overflow-x-auto ${className}`.trim()}>{children}</div>;
}
