"use client";

// The signed-in agent as the desk's screens need them ("Assign to me",
// "You" on their own notes), provided by DeskShell.

import { createContext, useContext } from "react";

export interface DeskMe {
  id: number;
  name: string;
  agent: boolean;
  admin: boolean;
  reports: boolean;
  /** The desk role (Newbie, Agent, Team lead, Manager, Admin). */
  role: { key: string; label: string } | null;
  /** The role's capabilities ("tickets.assign_any", "replies.review", …). */
  caps: string[];
}

export const DeskMeContext = createContext<DeskMe>({ id: 0, name: "", agent: false, admin: false, reports: false, role: null, caps: [] });
export const useDeskMe = () => useContext(DeskMeContext);

/** Does the agent's desk role carry this capability? Controls it lacks are hidden, not just refused. */
export function useCan(): (cap: string) => boolean {
  const me = useContext(DeskMeContext);
  return (cap: string) => me.caps.includes(cap);
}
