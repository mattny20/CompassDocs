// Renders a tag-type directory attribute: the stored value is split on
// commas/semicolons and shown as badge chips (skills, certifications,
// technologies…). Server-safe — no hooks.

export function splitTags(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function TagBadges({ value, size = "sm" }: { value: string; size?: "sm" | "md" }) {
  const tags = splitTags(value);
  if (tags.length === 0) return null;
  const cls =
    size === "md"
      ? "rounded-full border border-compass-200 bg-compass-50 px-2.5 py-0.5 text-xs font-medium text-compass-700 dark:border-compass-100 dark:text-compass-300"
      : "rounded-full border border-compass-200 bg-compass-50 px-2 py-px text-[11px] font-medium text-compass-700 dark:border-compass-100 dark:text-compass-300";
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t, i) => (
        <span key={`${t}-${i}`} className={cls}>
          {t}
        </span>
      ))}
    </span>
  );
}
