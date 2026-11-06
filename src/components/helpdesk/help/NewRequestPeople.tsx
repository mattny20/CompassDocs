"use client";

// "Add people" on a new request (1.19.1, agent V3): colleagues to copy on
// the request once it is sent. They see the conversation and get the
// replies, never the desk's internal notes. Outside addresses appear only
// while the workspace allows outside senders (GET /api/helpdesk/cc-options).

import { useEffect, useState } from "react";
import { HD_CC_LIMIT } from "@/lib/helpdesk/ccs-shared";
import { AddPeopleButton, CcChip, type CcPick } from "../ccs/AddPeople";
import { fetchJson } from "./shared";

export function NewRequestPeople({ value, onChange, viewerId }: { value: CcPick[]; onChange: (v: CcPick[]) => void; viewerId?: number }) {
  const [outside, setOutside] = useState(false);
  useEffect(() => {
    void fetchJson<{ outside_allowed?: boolean }>("/api/helpdesk/cc-options", undefined, "").then((r) => r.ok && setOutside(!!r.data.outside_allowed));
  }, []);
  const key = (p: CcPick) => ("user_id" in p ? `u${p.user_id}` : `e${p.email}`);
  function add(p: CcPick) {
    if (value.some((v) => key(v) === key(p)) || value.length >= HD_CC_LIMIT) return;
    onChange([...value, p]);
  }
  const ids = value.flatMap((v) => ("user_id" in v ? [v.user_id] : []));
  return (
    <div role="group" aria-labelledby="hd-new-people" data-testid="new-request-people">
      <span id="hd-new-people" className="mb-1 block text-xs font-medium text-slate-500">
        Add people <span className="font-normal">(optional)</span>
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((p) => (
          <CcChip
            key={key(p)}
            name={p.name}
            outside={!("user_id" in p)}
            onRemove={() => onChange(value.filter((v) => key(v) !== key(p)))}
            removeLabel={`Remove ${p.name}`}
          />
        ))}
        <AddPeopleButton
          label="Add people"
          variant="button"
          outsideAllowed={outside}
          excludeIds={viewerId ? [viewerId, ...ids] : ids}
          onAdd={add}
          disabled={value.length >= HD_CC_LIMIT}
        />
      </div>
      <span className="mt-1 block text-xs text-slate-500">They&rsquo;ll see the conversation and get the replies.</span>
    </div>
  );
}
