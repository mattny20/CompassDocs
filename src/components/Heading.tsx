// The heading ladder below the page title (STYLEGUIDE §Page skeleton):
//
//   SectionHeading  h2  text-lg font-semibold      a group of cards within a page ("Users (2)")
//   CardTitle       h3  text-base font-semibold    one card ("Automatic backups")
//   SubHeading      h4  text-sm font-semibold      a block inside a card ("Change password")
//   Eyebrow         p   text-xs uppercase          a label over a list, a table header tier
//
// Levels are the element; sizes are the recipe. The review measured eight
// card-title styles and seven uppercase size/weight combinations; these are
// the four that remain. Rail group labels are the smaller eyebrow tier
// (RAIL_GROUP_TEXT in components/RailLink). Server-safe.

import type { ReactNode } from "react";

export const SECTION_HEADING_TEXT = "text-lg font-semibold text-slate-900";
export const CARD_TITLE_TEXT = "text-base font-semibold text-slate-900";
export const SUB_HEADING_TEXT = "text-sm font-semibold text-slate-800";
/** The larger eyebrow tier: list labels, table headers. */
export const EYEBROW_TEXT = "text-xs font-semibold uppercase tracking-wider text-slate-500";

function Glyph({ icon, size }: { icon?: ReactNode; size: string }) {
  if (!icon) return null;
  return (
    <span className={`shrink-0 text-compass-600 ${size}`} aria-hidden>
      {icon}
    </span>
  );
}

export function SectionHeading({
  children,
  icon,
  actions,
  className = "mb-3",
  id,
}: {
  children: ReactNode;
  icon?: ReactNode;
  /** Right-aligned controls on the same row. */
  actions?: ReactNode;
  className?: string;
  id?: string;
}) {
  const h = (
    <h2 id={id} className={`flex items-center gap-2 ${SECTION_HEADING_TEXT} ${actions ? "" : className}`}>
      <Glyph icon={icon} size="[&>svg]:h-5 [&>svg]:w-5" />
      {children}
    </h2>
  );
  if (!actions) return h;
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 ${className}`}>
      {h}
      <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

export function CardTitle({
  children,
  icon,
  className = "mb-1",
  as: Tag = "h3",
}: {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  as?: "h2" | "h3";
}) {
  return (
    <Tag className={`flex items-center gap-2 ${CARD_TITLE_TEXT} ${className}`}>
      <Glyph icon={icon} size="[&>svg]:h-4 [&>svg]:w-4" />
      {children}
    </Tag>
  );
}

export function SubHeading({
  children,
  icon,
  className = "mb-1",
  as: Tag = "h4",
}: {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  as?: "h3" | "h4";
}) {
  return (
    <Tag className={`flex items-center gap-1.5 ${SUB_HEADING_TEXT} ${className}`}>
      <Glyph icon={icon} size="[&>svg]:h-4 [&>svg]:w-4" />
      {children}
    </Tag>
  );
}

export function Eyebrow({
  children,
  icon,
  className = "mb-2",
  as: Tag = "p",
}: {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  as?: "p" | "h2" | "h3" | "span";
}) {
  return (
    <Tag className={`flex items-center gap-1.5 ${EYEBROW_TEXT} ${className}`}>
      <Glyph icon={icon} size="[&>svg]:h-3.5 [&>svg]:w-3.5" />
      {children}
    </Tag>
  );
}
