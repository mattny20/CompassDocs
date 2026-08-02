"use client";

import { useEffect, useState } from "react";

/**
 * Time-of-day greeting, computed in the BROWSER so it matches the reader's
 * clock, not the server's. Renders a neutral fallback until hydration so the
 * server HTML never shows the wrong half of the day.
 *
 * DELIBERATE EXCEPTION to "render absolute dates through lib/format": this is
 * the only `toLocale*` left under src/components, and it is not an absolute
 * timestamp — it is "what time is it for the person reading this", where the
 * browser clock is the right answer and a stored workspace zone would be the
 * wrong one (a reader in Tokyo would be told "good evening" at 9am because the
 * workspace is UTC). The weekday + long-month shape it prints has no
 * equivalent in the DateFormat set either, so there is nothing for the
 * workspace format to select. Every date the product asks you to *compare* —
 * audit, sessions, analytics, health, status — goes through the provider.
 */
export function DashboardGreeting({ name }: { name: string }) {
  const firstName = name.split(/\s+/)[0] || name;
  const [line, setLine] = useState<{ hello: string; date: string } | null>(null);

  useEffect(() => {
    const now = new Date();
    const h = now.getHours();
    const hello = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    const date = now.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    setLine({ hello, date });
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">
        {line ? `${line.hello}, ${firstName}` : `Hello, ${firstName}`}
      </h1>
      <p className="mt-1 text-slate-500">
        {line ? line.date : " "}
      </p>
    </div>
  );
}
