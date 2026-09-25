// Chips for tag-type directory attributes.
//
// Two rules that came out of a real complaint ("Notary just has their office
// location in a red box"): a chip shows the option's LABEL, not the raw code,
// and it is neutral by default — the accent colour is opt-in per field
// (`highlight`) or per option (`color`), so a certification never reads as an
// alert. Server-safe — no hooks.

import { CHIP_COLORS, resolveValues, splitMulti, type FieldLike } from "@/lib/directory-display";

/** Split a comma/semicolon-separated tag value. */
export const splitTags = splitMulti;

function chipClass(size: "sm" | "md", tone: string): string {
  const base = size === "md" ? "rounded-full px-2.5 py-0.5 text-xs font-medium" : "rounded-full px-2 py-px text-[11px] font-medium";
  return `${base} ${CHIP_COLORS[tone] ?? CHIP_COLORS.slate}`;
}

/** Plain comma-separated tags, accent-coloured — the pre-1.2 look, kept for callers with no field. */
export function TagBadges({ value, size = "sm" }: { value: string; size?: "sm" | "md" }) {
  const tags = splitTags(value);
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t, i) => (
        <span key={`${t}-${i}`} className={chipClass(size, "accent")}>
          {t}
        </span>
      ))}
    </span>
  );
}

/** A field's value as chips: option labels, per-option colour, field highlight. */
export function FieldChips({ field, value, size = "sm" }: { field: FieldLike; value: string; size?: "sm" | "md" }) {
  const values = resolveValues({ ...field, multi: 1 }, value).filter((v) => !v.hidden);
  if (values.length === 0) return null;
  const fallback = field.highlight ? "accent" : "slate";
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((v, i) => (
        <span key={`${v.value}-${i}`} className={chipClass(size, v.color && CHIP_COLORS[v.color] ? v.color : fallback)}>
          {v.label}
        </span>
      ))}
    </span>
  );
}
