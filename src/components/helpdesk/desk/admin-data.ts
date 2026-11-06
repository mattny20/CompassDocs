"use client";

// Lists the desk's configuration screens share: the helpdesk teams (with
// members) and the request types, from the admin routes. Loaded on demand
// and reloadable after a change.

import { useCallback, useEffect, useState } from "react";
import type { HdRequestType, HdTeamWithMembers } from "@/lib/helpdesk/types";
import { getJson, listOf } from "./api";

export function useTeams() {
  const [teams, setTeams] = useState<HdTeamWithMembers[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    getJson("/api/helpdesk/admin/teams", "Couldn't load the teams.")
      .then((d) => {
        setTeams(listOf<HdTeamWithMembers>(d, "teams").map((t) => ({ ...t, members: t.members ?? [] })));
        setError("");
      })
      .catch((e: Error) => {
        setError(e.message);
        setTeams((prev) => prev ?? []);
      });
  }, []);
  useEffect(() => reload(), [reload]);
  return { teams, error, reload };
}

export function useRequestTypes() {
  const [types, setTypes] = useState<HdRequestType[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    getJson("/api/helpdesk/admin/request-types", "Couldn't load the request types.")
      .then((d) => {
        setTypes(listOf<HdRequestType>(d, "request_types"));
        setError("");
      })
      .catch((e: Error) => {
        setError(e.message);
        setTypes((prev) => prev ?? []);
      });
  }, []);
  useEffect(() => reload(), [reload]);
  return { types, error, reload };
}
