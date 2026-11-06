"use client";

// "Pause auto-assign" in the desk's availability menu (agent N): an agent
// opts out of round robin and load balancing in every team for a while,
// without going away (their tickets stay theirs; rules that name them and
// the on-call rota still reach them). A menuitemcheckbox, so the menu reads
// it as a switch; it only shows for someone in at least one team.

import { useEffect, useState } from "react";
import { Check, PauseCircle } from "lucide-react";
import { toast } from "@/components/Toasts";
import { getJson, sendJson } from "../api";

interface Mine {
  paused: boolean;
  teams: { team_id: number; name: string; mode: string; paused: number }[];
}

export function AutoAssignToggle({ onDone }: { onDone?: () => void }) {
  const [mine, setMine] = useState<Mine | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getJson<Mine>("/api/helpdesk/me/auto-assign")
      .then((d) => live && setMine(d))
      .catch(() => live && setMine(null));
    return () => {
      live = false;
    };
  }, []);

  if (!mine || mine.teams.length === 0) return null;
  const auto = mine.teams.some((t) => t.mode !== "manual");

  async function flip() {
    if (!mine || busy) return;
    const next = !mine.paused;
    setBusy(true);
    try {
      const d = await sendJson<Mine>("/api/helpdesk/me/auto-assign", "PATCH", { paused: next }, "Couldn't change auto-assign.");
      setMine(d);
      toast("ok", next ? "Auto-assign paused. New tickets skip you." : "Auto-assign is back on.");
      onDone?.();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={mine.paused}
      disabled={busy}
      onClick={flip}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
    >
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">Pause auto-assign</span>
        <span className="block text-xs text-slate-500">
          {mine.paused ? "New tickets skip you until you turn this off" : auto ? "Stop getting new tickets by turn, stay available" : "Your teams assign by hand right now"}
        </span>
      </span>
      {mine.paused && <Check className="mt-0.5 h-4 w-4 shrink-0 text-compass-700" aria-hidden />}
    </button>
  );
}
