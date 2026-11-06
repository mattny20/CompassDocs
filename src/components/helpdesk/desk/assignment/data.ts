"use client";

// Settings → Assignment's shared client data (agent N): the overview (teams
// the person configures, whether they manage rules, the rule editor's
// choices) and the selected team, kept in the address as ?team= so a link
// or a reload lands on the same team.

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getJson } from "../api";

export interface AssignmentTeam {
  id: number;
  name: string;
  icon: string;
  mode: string;
}

export interface AssignmentChoices {
  teams: { id: number; name: string }[];
  request_types: { id: number; name: string }[];
  integrations: { id: number; name: string }[];
  agents: { id: number; name: string }[];
  form_fields: { key: string; label: string }[];
}

export interface AssignmentOverview {
  teams: AssignmentTeam[];
  can_manage_rules: boolean;
  choices: AssignmentChoices;
}

export function useAssignmentOverview() {
  const [data, setData] = useState<AssignmentOverview | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      getJson<AssignmentOverview>("/api/helpdesk/admin/assignment", "Couldn't load the assignment settings.")
        .then((d) => {
          setData(d);
          setError("");
        })
        .catch((e: Error) => setError(e.message)),
    []
  );
  useEffect(() => void load(), [load]);
  return { data, error, reload: load };
}

/** The team in ?team=, else the first one the person configures. */
export function useSelectedTeam(teams: AssignmentTeam[] | undefined): [number | null, (id: number) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const raw = Number(params?.get("team"));
  const chosen = teams?.find((t) => t.id === raw)?.id ?? teams?.[0]?.id ?? null;
  const set = (id: number) => {
    const q = new URLSearchParams(params?.toString() ?? "");
    q.set("team", String(id));
    router.replace(`${path}?${q.toString()}`, { scroll: false });
  };
  return [chosen, set];
}

/** "Mon 9 Nov, 09:00" in the viewer's zone. */
export function whenLabel(iso: string, opts: { time?: boolean; day?: boolean } = { time: true, day: true }): string {
  const d = new Date(iso);
  const day = opts.day === false ? "" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const time = opts.time === false ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return [day, time].filter(Boolean).join(", ");
}
