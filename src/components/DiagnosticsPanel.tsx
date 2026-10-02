"use client";

import { useState } from "react";
import Link from "next/link";
import { buttonClass } from "@/components/Button";
import { useCanOpenSettings } from "@/components/SettingsLink";
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from "lucide-react";
import type { DiagnosticCheck } from "@/lib/diagnostics";

/** The way out of a warn/fail row: a link to the page that fixes it, or plain
 *  text when the viewer (a delegated role) cannot open that section. */
function FixLink({ fix }: { fix: NonNullable<DiagnosticCheck["fix"]> }) {
  const can = useCanOpenSettings(fix.href);
  return can ? (
    <Link href={fix.href} className="link text-sm font-medium">
      {fix.label}
    </Link>
  ) : (
    <span className="text-sm font-medium text-slate-500">{fix.label}</span>
  );
}

const TONE: Record<DiagnosticCheck["status"], { icon: React.ReactNode; chip: string }> = {
  pass: {
    icon: <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />,
    chip: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  },
  warn: {
    icon: <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />,
    chip: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  },
  fail: {
    icon: <XCircle className="h-4 w-4 text-red-600" aria-hidden />,
    chip: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  },
};

export function DiagnosticsPanel({ initial }: { initial: DiagnosticCheck[] }) {
  const [checks, setChecks] = useState(initial);
  const [running, setRunning] = useState(false);

  async function rerun() {
    setRunning(true);
    try {
      const res = await fetch("/api/admin/diagnostics");
      if (res.ok) setChecks((await res.json()).checks);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900">Diagnostics</h3>
          <p className="mt-0.5 text-sm text-slate-500">
            Live checks of every subsystem this install depends on.
          </p>
        </div>
        <button
          onClick={rerun}
          disabled={running}
          className={buttonClass("secondary")}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} aria-hidden />
          {running ? "Checking…" : "Run checks"}
        </button>
      </div>
      <ul className="divide-y divide-slate-100">
        {checks.map((c) => (
          <li key={c.key} className="flex items-start gap-3 py-2.5">
            <span className="mt-0.5 shrink-0">{TONE[c.status].icon}</span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-800">{c.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[c.status].chip}`}>
                  {c.status === "pass" ? "OK" : c.status === "warn" ? "Attention" : "Failing"}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-slate-500">
                {c.detail}
                {c.fix && c.status !== "pass" && (
                  <>
                    {" "}
                    <FixLink fix={c.fix} />
                  </>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
