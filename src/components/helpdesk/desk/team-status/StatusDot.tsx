// A service's state as a 9px dot (1.19.2, agent W6): emerald operational,
// amber degraded, red outage, sky maintenance, slate unknown. Decoration:
// the state is always also written beside it.

export function StatusDot({ state, className = "" }: { state: string; className?: string }) {
  const hue =
    state === "operational"
      ? "bg-emerald-500"
      : state === "degraded"
        ? "bg-amber-500"
        : state === "outage"
          ? "bg-red-500"
          : state === "maintenance"
            ? "bg-sky-500"
            : "bg-slate-400";
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full print:border print:border-black ${hue} ${className}`} aria-hidden />;
}
