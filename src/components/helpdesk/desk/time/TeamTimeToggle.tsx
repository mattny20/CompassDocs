"use client";

// A team's "Ask for time when solving" switch (1.19.1, agent V8), on the
// team's card in Desk settings → Teams. Saves at once (optimistic, rolled
// back with the server's sentence). With it on, Solve asks the agent to log
// their time first when they have none on the ticket.

import { useEffect, useState } from "react";
import { Toggle } from "@/components/form";
import { toast } from "@/components/Toasts";
import { getJson, sendJson } from "../api";

export function TeamTimeToggle({ teamId, teamName }: { teamId: number; teamName: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    getJson<{ ask_time_on_solve: boolean }>(`/api/helpdesk/admin/teams/${teamId}/time`)
      .then((r) => live && setOn(r.ask_time_on_solve))
      .catch(() => live && setOn(null));
    return () => {
      live = false;
    };
  }, [teamId]);
  if (on === null) return null;
  return (
    <Toggle
      label="Ask for time when solving"
      help={`Agents in ${teamName} log the time they spent before a ticket is solved. They can leave it empty.`}
      checked={on}
      onChange={async (v) => {
        setOn(v);
        try {
          await sendJson(`/api/helpdesk/admin/teams/${teamId}/time`, "PATCH", { ask_time_on_solve: v }, "Couldn't save that.");
          toast("ok", v ? `${teamName} is asked for time when solving.` : `${teamName} is no longer asked for time.`);
        } catch (e) {
          setOn(!v);
          toast("error", (e as Error).message);
        }
      }}
    />
  );
}
