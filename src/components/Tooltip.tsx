// Custom tooltip wrapper for cases where the target element can't carry the
// data-tt attribute itself (third-party children, disabled buttons — which
// don't fire hover reliably). For ordinary buttons/links, skip the wrapper
// and put data-tt="Label" (and data-tt-pos="bottom" near the viewport top)
// straight on the element — the styling lives in globals.css.

export function Tooltip({
  label,
  side = "top",
  children,
  className = "",
}: {
  label: string;
  side?: "top" | "bottom";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex ${className}`}
      data-tt={label}
      data-tt-pos={side === "bottom" ? "bottom" : undefined}
    >
      {children}
    </span>
  );
}
