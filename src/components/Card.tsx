// The one card (STYLEGUIDE §Sections and cards): rounded-xl, one border,
// one shadow, one padding, and an optional header (title, description,
// actions) in the card-title tier. Lists and tables that manage their own
// padding pass padding="none" and render an inner header row. Server-safe.

import type { ReactNode } from "react";
import { CardTitle } from "./Heading";

export const CARD_CLASS = "rounded-xl border border-slate-200 bg-surface shadow-xs";

export function Card({
  title,
  description,
  actions,
  icon,
  padding = "p-5",
  className = "",
  children,
  as: Tag = "section",
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned header controls. */
  actions?: ReactNode;
  icon?: ReactNode;
  /** "p-5" for forms and settings, "p-4" for dense content, "none" when
   *  the children own their padding (a table). */
  padding?: "p-5" | "p-4" | "none";
  className?: string;
  children: ReactNode;
  as?: "section" | "div";
}) {
  return (
    <Tag className={`${CARD_CLASS} ${padding === "none" ? "overflow-hidden" : padding} ${className}`.trim()}>
      {(title || actions) && (
        <div className={`flex flex-wrap items-start justify-between gap-3 ${padding === "none" ? "border-b border-slate-100 px-4 py-3" : "mb-3"}`}>
          <div className="min-w-0">
            {title && <CardTitle icon={icon} className={description ? "mb-0.5" : ""}>{title}</CardTitle>}
            {description && <p className="text-sm text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}
