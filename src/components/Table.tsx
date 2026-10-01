"use client";

// Tables (STYLEGUIDE §Tables): one header recipe on every table — the
// larger eyebrow tier at an AA grey, semibold, with tabular numerals (set
// once on <table> in globals.css) — plus, in step two, sortable headers
// with proper aria-sort and icons, sticky headers where the table is not
// its own scroll container, row hover, and a fit mode so dates, counts and
// actions stop taking 300px while the primary column takes the slack.
//
// Composition, not a data grid: every table keeps its own cells.
//
//   <Table scroll minWidth="45rem">            // horizontal scroll inside the card
//     <thead className={TABLE_HEAD_ROW}><tr>
//       <Th sort={{ key: "name", by, dir, onSort }}>Name</Th>
//       <Th fit align="right">Actions</Th>
//     </tr></thead>
//     <tbody><tr className={TR}><Td>…</Td><Td fit>…</Td></tr></tbody>
//   </Table>
//
//   <Table sticky>                              // the page scrolls; the header stays
//
// The two are exclusive: a sticky header inside an overflow wrapper sticks
// to the wrapper's own (non-scrolling) scrollport and never to the page.

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { EYEBROW_TEXT } from "./Heading";

/** The header row: put it on <thead> (or the header <tr>). */
export const TABLE_HEAD_ROW = `border-b border-slate-100 text-left ${EYEBROW_TEXT}`;
/** The header cell. */
export const TH = "px-4 py-2.5";
/** The body cell. */
export const TD = "px-4 py-3";
/** Body rows: a hairline and a hover band that connects a title to its
 *  actions 1,600px to the right on a wide monitor. */
export const TR = "border-b border-slate-100 last:border-b-0 transition-colors hover:bg-slate-50/70";
/** Shrink a column to its content (dates, counts, actions). */
export const FIT = "w-px whitespace-nowrap";

/** A table inside a card: the wrapper scrolls sideways on narrow screens
 *  instead of breaking the page. */
export function TableWrap({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`overflow-x-auto ${className}`.trim()}>{children}</div>;
}

export function Table({
  children,
  scroll = false,
  sticky = false,
  minWidth,
  className = "",
  ...rest
}: {
  children: ReactNode;
  /** Wrap in a horizontal scroll container (tables with a minimum width). */
  scroll?: boolean;
  /** Keep the header on screen while the page scrolls. Not with `scroll`. */
  sticky?: boolean;
  /** CSS length applied as min-width (with `scroll`). */
  minWidth?: string;
  className?: string;
} & Omit<React.ComponentProps<"table">, "children" | "className">) {
  const table = (
    <table
      className={`w-full text-sm ${sticky ? "[&>thead]:sticky [&>thead]:top-0 [&>thead]:z-10 [&>thead]:bg-surface" : ""} ${className}`.trim()}
      style={minWidth ? { minWidth } : undefined}
      {...rest}
    >
      {children}
    </table>
  );
  return scroll ? <TableWrap>{table}</TableWrap> : table;
}

export type SortDir = "asc" | "desc";

export function Th({
  children,
  sort,
  fit = false,
  align = "left",
  className = "",
  ...rest
}: {
  children?: ReactNode;
  /** Makes the header a sort button: `key` is this column, `by`/`dir` the
   *  current sort, `onSort` receives the key. The icon is hidden from
   *  readers; aria-sort carries the state. */
  sort?: { key: string; by: string | null; dir: SortDir; onSort: (key: string) => void };
  fit?: boolean;
  align?: "left" | "right" | "center";
  className?: string;
} & Omit<React.ComponentProps<"th">, "children" | "className" | "align">) {
  const active = sort ? sort.by === sort.key : false;
  const ariaSort = sort ? (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") : undefined;
  const alignCls = align === "right" ? "text-right" : align === "center" ? "text-center" : "";
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`${TH} ${fit ? FIT : ""} ${alignCls} ${sort ? "select-none" : ""} ${className}`.trim()}
      {...rest}
    >
      {sort ? (
        <button
          type="button"
          onClick={() => sort.onSort(sort.key)}
          className={`inline-flex items-center gap-1 rounded-sm hover:text-slate-700 ${active ? "text-slate-700" : ""}`}
        >
          {children}
          <span className="shrink-0" aria-hidden>
            {active ? (
              sort.dir === "asc" ? (
                <ArrowUp className="h-3.5 w-3.5" />
              ) : (
                <ArrowDown className="h-3.5 w-3.5" />
              )
            ) : (
              <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
            )}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({
  children,
  fit = false,
  align = "left",
  className = "",
  ...rest
}: {
  children?: ReactNode;
  fit?: boolean;
  align?: "left" | "right" | "center";
  className?: string;
} & Omit<React.ComponentProps<"td">, "children" | "className" | "align">) {
  const alignCls = align === "right" ? "text-right" : align === "center" ? "text-center" : "";
  return (
    <td className={`${TD} ${fit ? FIT : ""} ${alignCls} ${className}`.trim()} {...rest}>
      {children}
    </td>
  );
}
