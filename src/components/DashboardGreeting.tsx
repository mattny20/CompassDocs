"use client";

import { useEffect, useState } from "react";

/**
 * Time-of-day greeting, computed in the BROWSER so it matches the reader's
 * clock, not the server's. Renders a neutral fallback until hydration so the
 * server HTML never shows the wrong half of the day.
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
