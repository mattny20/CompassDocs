"use client";

// The ticket pane's CC and Following rows and the header's Follow button
// (1.19.1, agent V3; mock-up #3). One GET /api/helpdesk/tickets/[n]/people
// feeds the rows, the button and the composer's "Reply to Daniel + 2 CC";
// each change answers with the new people, so nothing reloads the ticket.

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Users } from "lucide-react";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { toast } from "@/components/Toasts";
import { SectionEmpty } from "@/components/form";
import { HD_CC_SKIP_TEXT, type HdTicketPeople } from "@/lib/helpdesk/ccs-shared";
import { AddPeopleButton, CcChip, type CcPick } from "@/components/helpdesk/ccs/AddPeople";
import { getJson, sendJson } from "../api";

export interface TicketPeopleState {
  people: HdTicketPeople | null;
  set: (p: HdTicketPeople) => void;
  reload: () => void;
}

export function useTicketPeople(number: number): TicketPeopleState {
  const [people, setPeople] = useState<HdTicketPeople | null>(null);
  const reload = useCallback(() => {
    getJson<HdTicketPeople>(`/api/helpdesk/tickets/${number}/people`, "Couldn't load the people on this ticket.")
      .then(setPeople)
      .catch(() => undefined);
  }, [number]);
  useEffect(() => {
    setPeople(null);
    reload();
  }, [reload]);
  return { people, set: setPeople, reload };
}

type Skipped = { input: { userId?: number | null; email?: string }; reason: string }[];

export function TicketCcRow({
  number,
  state,
  meId,
  requesterId,
  canEdit,
}: {
  number: number;
  state: TicketPeopleState;
  meId: number;
  requesterId: number | null;
  /** Works the ticket and may reply to the requester: adds and removes CCs. */
  canEdit: boolean;
}) {
  const p = state.people;
  if (!p) return null;

  async function add(pick: CcPick) {
    try {
      const r = await sendJson<{ added: unknown[]; skipped: Skipped; people: HdTicketPeople }>(
        `/api/helpdesk/tickets/${number}/ccs`,
        "POST",
        { people: ["user_id" in pick ? { user_id: pick.user_id } : { email: pick.email }] },
        "Couldn't add that person."
      );
      state.set(r.people);
      if (r.skipped.length) toast("error", `${pick.name} ${HD_CC_SKIP_TEXT[r.skipped[0].reason] ?? "could not be added"}.`);
      else toast("ok", `${pick.name} added as CC.`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function remove(id: number, name: string) {
    try {
      const r = await sendJson<{ people: HdTicketPeople }>(`/api/helpdesk/tickets/${number}/ccs/${id}`, "DELETE", undefined, "Couldn't remove that person.");
      state.set(r.people);
      toast("ok", `${name} removed from CC.`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const followers = [...p.followers].sort((a, b) => (a.user_id === meId ? -1 : b.user_id === meId ? 1 : 0));
  const exclude = [...p.ccs.map((c) => c.user_id).filter((x): x is number => x !== null), ...(requesterId ? [requesterId] : [])];

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm" data-testid="ticket-people">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="CC">
        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
          <Users className="h-3.5 w-3.5" aria-hidden />
          CC
        </span>
        {p.ccs.length === 0 && !canEdit && <SectionEmpty className="!text-xs">No one</SectionEmpty>}
        {p.ccs.map((c) => (
          <CcChip
            key={c.id}
            name={c.name}
            email={c.email}
            outside={c.outside}
            onRemove={canEdit ? () => void remove(c.id, c.name) : undefined}
            removeLabel={`Remove ${c.name} from CC`}
          />
        ))}
        {canEdit && <AddPeopleButton label="Add" outsideAllowed={p.outside_allowed} excludeIds={exclude} onAdd={add} />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Following">
        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
          <Eye className="h-3.5 w-3.5" aria-hidden />
          Following
        </span>
        {followers.length === 0 ? (
          <SectionEmpty className="!text-xs">No one</SectionEmpty>
        ) : (
          followers.map((f) => (
            <span key={f.user_id} className={chipClass("neutral")}>
              {f.user_id === meId ? "You" : f.name}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

export function FollowButton({ number, state }: { number: number; state: TicketPeopleState }) {
  const [busy, setBusy] = useState(false);
  const p = state.people;
  if (!p) return null;
  async function toggle() {
    setBusy(true);
    try {
      const r = await sendJson<{ people: HdTicketPeople }>(
        `/api/helpdesk/tickets/${number}/follow`,
        p!.following ? "DELETE" : "POST",
        undefined,
        "Couldn't change following."
      );
      state.set(r.people);
      toast("ok", r.people.following ? `You're following #${number}.` : `You've unfollowed #${number}.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button
      variant="secondary"
      icon={p.following ? <EyeOff /> : <Eye />}
      busy={busy}
      onClick={toggle}
      data-tt={p.following ? "Stop getting updates on this ticket" : "Get updates on new replies, notes and status"}
    >
      {p.following ? "Unfollow" : "Follow"}
    </Button>
  );
}
