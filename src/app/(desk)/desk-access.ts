// Who may use the desk, and what they see in it (1.19.0). Server-only.
//
// The desk is open to anyone holding a desk-side helpdesk permission:
// helpdesk.agent / helpdesk.agent_all (queues), helpdesk.admin
// (configuration) and helpdesk.reports (reports). The answers come from the
// core's helpdeskCapabilities (lib/helpdesk/access), the same checks the
// API's helpdeskGate makes, so a page never admits someone its routes
// would refuse.

import "server-only";
import { cache } from "react";
import { userHolds } from "@/lib/access";
import { helpdeskCapabilities } from "@/lib/helpdesk/access";
import { getAvailability } from "@/lib/helpdesk/teams";
import { hdCapsFor } from "@/lib/helpdesk/roles";
import { HD_ROLE_LABEL } from "@/lib/helpdesk/roles-shared";
import type { SessionUser } from "@/lib/types";
import type { HdAvailability } from "@/lib/helpdesk/types";

export interface DeskAccess {
  licensed: boolean;
  agent: boolean;
  agentAll: boolean;
  admin: boolean;
  reports: boolean;
  /** May open Settings → License (the gate's button). */
  manageLicense: boolean;
  /** Any desk-side permission at all. */
  any: boolean;
}

export const deskAccess = cache(async (user: SessionUser): Promise<DeskAccess> => {
  const [caps, manageLicense] = await Promise.all([
    helpdeskCapabilities(user),
    userHolds(user, "workspace.settings_read", { legacyMin: "admin" }),
  ]);
  return {
    licensed: caps.licensed,
    agent: caps.agent,
    agentAll: caps.agent_all,
    admin: caps.admin,
    reports: caps.reports,
    manageLicense,
    any: caps.agent || caps.admin || caps.reports,
  };
});

/** The agent's availability (hd_agent_prefs); "available" until they set one. */
export async function agentAvailability(userId: number): Promise<HdAvailability> {
  return getAvailability(userId).catch(() => "available" as const);
}

/**
 * The agent's desk role (Newbie, Agent, Team lead, Manager, Admin) and its
 * capabilities (agent J's lib/helpdesk/roles hdCapsFor), which decide which
 * controls the desk shows: assign to others, change priority or status,
 * transfer, delete, export, review replies, and each settings page. The
 * routes check the same capabilities, so hiding a control never hides
 * something the person could do.
 */
export interface DeskRoleCaps {
  role: { key: string; label: string } | null;
  caps: string[];
  can: (cap: string) => boolean;
}

export const deskRoleCaps = cache(async (user: SessionUser): Promise<DeskRoleCaps> => {
  const v = await hdCapsFor(user).catch(() => null);
  const caps: string[] = v ? [...v.caps] : [];
  const role = v?.role ? { key: v.role, label: HD_ROLE_LABEL[v.role] } : null;
  return { role, caps, can: (c) => caps.includes(c) };
});

/** The settings pages and the capability each needs (the nav and the pages read this). */
export const SETTINGS_CAP: Record<string, string[]> = {
  setup: ["settings.manage"],
  teams: ["teams.manage"],
  "request-types": ["request_types.manage"],
  sla: ["sla.manage"],
  email: ["channels.manage"],
  automations: ["automations.manage"],
  macros: ["macros.manage_all", "macros.manage_team", "macros.manage_personal"],
  csat: ["csat.manage"],
  workflows: ["workflows.manage"],
  "contact-cards": ["settings.manage"],
  // Team settings, people and on call: agents.manage_team (a lead for their own teams); rules: automations.manage (agent N).
  assignment: ["agents.manage_team", "automations.manage"],
  integrations: ["settings.manage", "channels.manage"],
};

/** May this person open that settings page? */
export async function canOpenSettings(user: SessionUser, page: keyof typeof SETTINGS_CAP): Promise<boolean> {
  const r = await deskRoleCaps(user);
  return SETTINGS_CAP[page].some((c) => r.can(c));
}
