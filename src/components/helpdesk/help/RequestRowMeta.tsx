"use client";

// The meta line under a request in My requests (1.19.0): the number, then
// the one thing the requester most wants to know. A running workflow says
// which step it is on ("step 3 of 4: IT is setting it up"); a request
// waiting on them says who asked; otherwise who replied last, or when it
// was sent.

import { RelativeTime } from "@/components/RelativeTime";
import type { HdRequestSummary } from "@/lib/helpdesk/types";
import type { HdRequestSummaryExtras } from "@/lib/helpdesk/types";
import { firstName } from "./shared";

export function RequestRowMeta({
  request: r,
  showTeam = false,
  viewerName,
}: {
  request: HdRequestSummary & HdRequestSummaryExtras;
  /** Add the team ("IT") after the number: the full list, where requests of every team mix. */
  showTeam?: boolean;
  /** The viewer's own name: their own last reply reads "You replied", never their first name. */
  viewerName?: string;
}) {
  const replier = r.last_public_author && r.last_public_author === viewerName ? "You" : firstName(r.last_public_author);
  const head = [`#${r.number}`, showTeam ? r.team_name : null].filter(Boolean).join(" · ");
  let tail: React.ReactNode = null;
  if (r.in_workflow && r.current_step) {
    tail = `step ${r.current_step.index} of ${r.current_step.total}: ${r.current_step.title}`;
  } else if (r.status === "pending" && r.last_public_author) {
    tail = (
      <>
        {firstName(r.last_public_author)} asked you a question{" "}
        {r.last_public_at && <RelativeTime value={r.last_public_at} />}
      </>
    );
  } else if (r.status === "solved" || r.status === "closed") {
    tail = r.csat_score ? `Rated ${r.csat_score} of 5` : r.solved_at ? <>Solved <RelativeTime value={r.solved_at} /></> : "Solved";
  } else if (r.last_public_author && r.last_public_at) {
    tail = (
      <>
        {replier} replied <RelativeTime value={r.last_public_at} />
      </>
    );
  } else {
    tail = (
      <>
        sent <RelativeTime value={r.created_at} />
      </>
    );
  }
  return (
    <span className="block truncate text-xs text-slate-500">
      {head} · {tail}
    </span>
  );
}
