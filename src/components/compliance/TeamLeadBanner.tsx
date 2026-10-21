"use client";

// The lead's banner on My policies (F4, 1.14.0): one sentence and one link
// to /compliance/team, shown only to someone the team page would open for
// (GET /api/compliance/mine answers `lead_team` by the page's own rule).
// Nothing renders until the answer is in, and nothing at all for everyone
// else, so the page reads exactly as it did in 1.13.0 for a plain reader.
// An invitation, not a state, so the accent tint of the bulk bar rather
// than a notice-* class; hidden on paper like every control.

import { useEffect, useState } from "react";
import Link from "next/link";
import { UsersRound } from "lucide-react";

export function TeamLeadBanner() {
  const [lead, setLead] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetch("/api/compliance/mine")
      .then((r) => (r.ok ? (r.json() as Promise<{ lead_team?: boolean }>) : null))
      .then((d) => {
        if (alive && d?.lead_team === true) setLead(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!lead) return null;
  return (
    <p
      data-team-lead-banner
      className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2 text-sm text-slate-700 print:hidden"
    >
      <UsersRound className="h-4 w-4 shrink-0 text-compass-600" aria-hidden />
      <span>You lead a team.</span>
      <Link href="/compliance/team" className="link font-medium">
        See your team&apos;s policies
      </Link>
    </p>
  );
}
