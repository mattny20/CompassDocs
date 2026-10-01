// The one chip (STYLEGUIDE §Status chips): a closed set of tones, each
// carrying its dark-mode pair and a print override (dark-mode pills used to
// print as dark slabs). Status text is label-cased ("Published", "Active").
// Attribute chips (directory fields, tags) are FieldChips/Tag, not this.
// Server-safe.

import type { ReactNode } from "react";

export type ChipTone = "ok" | "warn" | "error" | "neutral" | "accent" | "info" | "label";

/** Emerald is the single success hue; green is retired. */
const TONE: Record<ChipTone, string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  error: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  neutral: "bg-slate-100 text-slate-600",
  accent: "bg-compass-50 text-compass-700",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  /** Product-tier labels (Enterprise). */
  label: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
};

const PRINT = "print:bg-transparent print:text-slate-700 print:ring-1 print:ring-slate-300";

export function chipClass(tone: ChipTone = "neutral", size: "sm" | "md" = "md", extra = ""): string {
  const pad = size === "sm" ? "px-1.5 py-px text-2xs" : "px-2 py-0.5 text-xs";
  return `inline-flex items-center gap-1 whitespace-nowrap rounded-full font-medium ${pad} ${TONE[tone]} ${PRINT} ${extra}`.trim();
}

export function Chip({
  tone = "neutral",
  size = "md",
  className = "",
  children,
  ...rest
}: {
  tone?: ChipTone;
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
} & Omit<React.ComponentProps<"span">, "children" | "className">) {
  return (
    <span className={chipClass(tone, size, className)} {...rest}>
      {children}
    </span>
  );
}

/** The one Enterprise badge, replacing five hand-written copies. */
export function EnterpriseBadge({ className = "" }: { className?: string }) {
  return (
    <Chip tone="label" className={className}>
      Enterprise
    </Chip>
  );
}

/** "published" → "Published": status values are stored lower-case. */
export function labelCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ") : value;
}
