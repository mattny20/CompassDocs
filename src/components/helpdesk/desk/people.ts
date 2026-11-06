"use client";

// The workspace's people for the desk's pickers (a ticket's requester, a
// team's members, a named approver): /api/users/mentionable, which any
// signed-in user may read (names and ids only). Loaded once per tab and
// shared; the helpdesk teams come from the counts or the admin routes.

import { useEffect, useState } from "react";
import { getJson, listOf } from "./api";

export interface PersonLite {
  id: number;
  name: string;
  username: string;
}

let cache: Promise<PersonLite[]> | null = null;

export function loadPeople(): Promise<PersonLite[]> {
  if (!cache) {
    cache = getJson("/api/users/mentionable")
      .then((d) => listOf<PersonLite>(d, "users"))
      .catch(() => {
        cache = null;
        return [];
      });
  }
  return cache;
}

export function usePeople(): PersonLite[] | null {
  const [people, setPeople] = useState<PersonLite[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadPeople().then((p) => live && setPeople(p));
    return () => {
      live = false;
    };
  }, []);
  return people;
}

export const personOption = (p: PersonLite) => ({ id: p.id, label: p.name || p.username, sublabel: p.username });
