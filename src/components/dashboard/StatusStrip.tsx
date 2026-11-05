// The dashboard's system status strip (1.17.0): one slim full-width row under
// the greeting with every tracked service as a coloured dot, a summary
// ("All systems normal" / "2 services degraded") and a link to /status. It
// replaces the old amber/red problems banner. Left out when no service is
// tracked. Server component; fetches its own data.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { listStatusStrip, type StripStatus } from "@/lib/dashboard-data";

const DOT: Record<StripStatus, string> = {
  operational: "bg-emerald-500",
  degraded: "bg-amber-500",
  outage: "bg-red-500",
  maintenance: "bg-sky-500",
  unknown: "bg-slate-300",
};

const INK: Partial<Record<StripStatus, string>> = {
  degraded: "ink-warn",
  outage: "text-red-600",
  maintenance: "text-sky-700 dark:text-sky-300",
};

const LABEL: Record<StripStatus, string> = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Outage",
  maintenance: "Maintenance",
  unknown: "Not checked yet",
};

/** How many services the strip names before "+N more" (the rest are on /status). */
const SHOWN = 8;

export async function StatusStrip() {
  const services = await listStatusStrip().catch(() => []);
  if (services.length === 0) return null;

  const problems = services.filter((s) => s.status === "outage" || s.status === "degraded" || s.status === "maintenance");
  const outage = problems.some((p) => p.status === "outage");
  const onlyMaintenance = problems.length > 0 && problems.every((p) => p.status === "maintenance");
  const n = problems.length;
  const summary =
    n === 0
      ? "All systems normal"
      : onlyMaintenance
        ? `${n} ${n === 1 ? "service" : "services"} in maintenance`
        : `${n} ${n === 1 ? "service" : "services"} degraded`;
  const summaryDot = n === 0 ? DOT.operational : outage ? DOT.outage : onlyMaintenance ? DOT.maintenance : DOT.degraded;
  const shown = services.slice(0, SHOWN);

  return (
    <section
      aria-labelledby="dash-status-title"
      data-dashboard-section="status"
      className="mb-6 flex min-w-0 items-center gap-x-5 gap-y-1.5 rounded-xl border border-slate-200 bg-surface px-4 py-2.5 text-sm shadow-xs"
    >
      <h2 id="dash-status-title" className="sr-only">
        System status
      </h2>
      <p className="flex shrink-0 items-center gap-2 font-semibold text-slate-800">
        <span className={`h-2 w-2 shrink-0 rounded-full ${summaryDot}`} aria-hidden />
        {summary}
      </p>
      {/* The services themselves from sm up; a phone gets the summary and
          the link, which is all a 343px row can hold. */}
      <ul className="hidden min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-slate-600 sm:flex">
        {shown.map((s) => (
          <li key={s.id} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
            <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.status]}`} aria-hidden />
            <span className="truncate">{s.name}</span>
            {INK[s.status] ? (
              <span className={`truncate ${INK[s.status]}`}>
                · {s.detail && s.detail.length <= 32 ? s.detail : LABEL[s.status]}
              </span>
            ) : (
              <span className="sr-only">: {LABEL[s.status]}</span>
            )}
          </li>
        ))}
        {services.length > shown.length && (
          <li className="whitespace-nowrap text-slate-500">+{services.length - shown.length} more</li>
        )}
      </ul>
      <Link
        href="/status"
        className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium text-compass-700 hover:text-compass-800 print:hidden"
      >
        Status
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </section>
  );
}
