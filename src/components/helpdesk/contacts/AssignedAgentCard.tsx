"use client";

// "Who's helping you" on a request in Get help (Helpdesk 1.19.0): the
// card of the agent assigned to the request (or who replied on it), with
// what Desk settings → Contact cards lets requesters see (by default no
// phone numbers), their team and whether they are on the desk now. Until
// someone picks it up: "Your request is with the IT team".
//
//   <AssignedAgentCard request={1047} />

import { useEffect, useState } from "react";
import { Headset } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { Eyebrow } from "@/components/Heading";
import type { HdTicketContacts } from "@/lib/helpdesk/contact-cards-shared";
import { ContactCard } from "./ContactCard";
import { fetchTicketContacts } from "./api";

export function AssignedAgentCard({
  request,
  teamName = null,
  refreshKey,
  className = "",
}: {
  /** The request's number (#1047). */
  request: number;
  /** The team it is with, shown until it is assigned (the API sends it too). */
  teamName?: string | null;
  refreshKey?: unknown;
  className?: string;
}) {
  const [data, setData] = useState<HdTicketContacts | null | undefined>(undefined);

  useEffect(() => {
    const ac = new AbortController();
    fetchTicketContacts(request, ac.signal)
      .then(setData)
      .catch(() => !ac.signal.aborted && setData(null));
    return () => ac.abort();
  }, [request, refreshKey]);

  if (data === undefined) return null;
  const agents = data?.audience === "requester" ? data.contacts : [];
  const team = data?.team_name ?? teamName;

  return (
    <section aria-labelledby="hd-helping" className={`${CARD_CLASS} p-4 ${className}`}>
      <Eyebrow as="h2" icon={<Headset />} className="mb-3">
        <span id="hd-helping">Who&rsquo;s helping you</span>
      </Eyebrow>
      {agents.length === 0 ? (
        <p className="text-sm text-slate-600">
          {team ? (
            <>
              Your request is with the <span className="font-medium text-slate-800">{team}</span> team. You&rsquo;ll see who&rsquo;s on it here once someone picks it up.
            </>
          ) : (
            <>Your request is in the queue. You&rsquo;ll see who&rsquo;s on it here once someone picks it up.</>
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-4 divide-y divide-slate-100">
          {agents.map((c, i) => (
            <ContactCard key={c.user_id ?? i} card={c} variant="panel" profileTarget="_self" className={i > 0 ? "pt-4" : ""} />
          ))}
        </div>
      )}
    </section>
  );
}
