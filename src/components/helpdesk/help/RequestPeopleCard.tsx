"use client";

// "People on this request" in Get help (1.19.1, agent V3): the requester
// and the people copied on the request. The requester adds people from the
// directory ("Add people"; outside addresses too when the workspace allows
// outside senders) and removes them; someone copied may leave. Everyone
// listed sees the public conversation and gets the replies, never the
// desk's internal notes.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Users } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { Eyebrow } from "@/components/Heading";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { HD_CC_SKIP_TEXT, type HdRequestPeople } from "@/lib/helpdesk/ccs-shared";
import { AddPeopleButton, CcChip, type CcPick } from "../ccs/AddPeople";
import { fetchJson } from "./shared";

export function RequestPeopleCard({
  number,
  viewerId,
  requesterName,
  onChanged,
}: {
  number: number;
  viewerId: number;
  requesterName: string;
  /** The conversation gains a timeline line on every change. */
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [p, setP] = useState<HdRequestPeople | null>(null);

  const load = useCallback(async () => {
    const r = await fetchJson<HdRequestPeople>(`/api/helpdesk/requests/${number}/ccs`, undefined, "");
    if (r.ok) setP(r.data);
  }, [number]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!p) return null;
  const me = p.ccs.find((c) => c.user_id === viewerId);

  async function add(pick: CcPick) {
    const r = await fetchJson<{ skipped: { reason: string }[]; people: HdRequestPeople }>(
      `/api/helpdesk/requests/${number}/ccs`,
      { method: "POST", body: JSON.stringify({ people: ["user_id" in pick ? { user_id: pick.user_id } : { email: pick.email }] }) },
      "Couldn't add that person."
    );
    if (!r.ok) return toast("error", r.error);
    setP(r.data.people);
    if (r.data.skipped.length) toast("error", `${pick.name} ${HD_CC_SKIP_TEXT[r.data.skipped[0].reason] ?? "could not be added"}.`);
    else {
      toast("ok", `${pick.name} can now follow this request.`);
      onChanged?.();
    }
  }

  async function remove(id: number, name: string, self: boolean) {
    if (self) {
      const ok = await confirmDialog({
        title: "Leave this request?",
        body: "You'll stop getting its replies and won't be able to open it again unless someone adds you back.",
        confirmLabel: "Leave",
      });
      if (ok !== true) return;
    }
    const r = await fetchJson<{ people: HdRequestPeople | null }>(`/api/helpdesk/requests/${number}/ccs/${id}`, { method: "DELETE" }, "Couldn't remove that person.");
    if (!r.ok) return toast("error", r.error);
    if (self) {
      toast("ok", `You left request #${number}.`);
      router.push("/help/requests");
      return;
    }
    if (r.data.people) setP(r.data.people);
    toast("ok", `${name} removed.`);
    onChanged?.();
  }

  const exclude = p.ccs.map((c) => c.user_id).filter((x): x is number => x !== null);

  return (
    <section aria-labelledby="hd-people" className={`${CARD_CLASS} p-4`} data-testid="request-people">
      <Eyebrow as="h2" icon={<Users />} className="mb-3">
        <span id="hd-people">People on this request</span>
      </Eyebrow>
      <ul className="flex flex-wrap gap-1.5" aria-label="People on this request">
        <li>
          <span className={chipClass("accent")}>
            {p.viewer_is_cc ? requesterName : "You"}
            <span className="font-normal">· requester</span>
          </span>
        </li>
        {p.ccs.map((c) => (
          <li key={c.id}>
            <CcChip
              name={c.user_id === viewerId ? "You" : c.name}
              email={c.email}
              outside={c.outside}
              onRemove={p.can_add ? () => void remove(c.id, c.name, false) : undefined}
              removeLabel={`Remove ${c.name}`}
            />
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">
        {p.ccs.length === 0 && p.can_add
          ? "Add colleagues who should see the replies. They see the conversation, never the desk's private notes."
          : "Everyone here sees the conversation and gets the replies."}
      </p>
      {(p.can_add || me) && (
        <div className="mt-3 flex flex-wrap gap-2 print:hidden">
          {p.can_add && <AddPeopleButton label="Add people" variant="button" outsideAllowed={p.outside_allowed} excludeIds={[viewerId, ...exclude]} onAdd={add} />}
          {me && (
            <Button variant="ghost" size="sm" icon={<LogOut />} onClick={() => void remove(me.id, me.name, true)}>
              Leave
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
