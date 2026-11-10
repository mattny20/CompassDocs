// A usage meter (STYLEGUIDE §Usage meter): a count against an allowance,
// e.g. "5 of 6 agents" on the licence. A thin bar, compass while within the
// allowance and amber once past it (filled to the end; the number says by
// how much). role="meter" with the value, maximum and a value text for
// screen readers.
// Not a progress bar: nothing is in flight.

export function UsageMeter({
  value,
  max,
  label,
  warnOver = true,
  className = "",
}: {
  value: number;
  max: number;
  label: string;
  /** Amber past the maximum (false while the allowance isn't enforced, e.g. a licence in grace). */
  warnOver?: boolean;
  className?: string;
}) {
  const over = value > max;
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 100;
  return (
    <div
      className={`h-1.5 w-full max-w-md overflow-hidden rounded-full bg-slate-100 ${className}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      // A meter's value can't pass its maximum (ARIA): past it, valuenow
      // stays at the maximum and valuetext carries the real count.
      aria-valuenow={Math.min(value, max)}
      aria-valuemax={max}
      aria-valuetext={over ? `${value} of ${max}, over by ${value - max}` : `${value} of ${max}`}
    >
      <div style={{ width: `${pct}%` }} className={`h-full rounded-full ${over && warnOver ? "bg-amber-500" : "bg-compass-600"}`} />
    </div>
  );
}
