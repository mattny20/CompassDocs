"use client";

// "3d ago" with the exact time behind it (STYLEGUIDE §Tooltips): a real
// <time> with a machine-readable datetime, the workspace-formatted exact
// time as the house tooltip (shown on hover and keyboard focus — a native
// title never shows on focus), and the raw database string nowhere.

import { useFormatDate } from "./SettingsProvider";
import { timeAgo } from "@/lib/ui";

function toIso(value: string): string {
  // "2026-07-12 20:36:58" (no zone) is UTC from the database.
  const v = value.includes("T") || /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

export function RelativeTime({
  value,
  className = "",
  pos,
}: {
  value: string;
  className?: string;
  /** Tooltip placement when the default (above) would clip. */
  pos?: "bottom" | "right";
}) {
  const fmt = useFormatDate();
  const iso = toIso(value);
  return (
    <time dateTime={iso} data-tt={fmt.dateTime(iso)} data-tt-pos={pos} tabIndex={0} className={`outline-hidden ${className}`.trim()}>
      {timeAgo(value)}
    </time>
  );
}
