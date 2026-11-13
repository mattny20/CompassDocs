// Helpdesk 1.19.0: the desk role ladder (agent J). One desk role per person
// (Newbie, Agent, Team lead, Manager, Admin) decides what they may do in the
// desk; this module is the one place that answers "may this person do X?"
// (hdCan) and lib/helpdesk/access delegates its agent/admin/reports
// questions here.
//
// Effective role (resolveRole in roles-shared):
//   1. a workspace helpdesk.admin holder is desk Admin, always (a floor the
//      desk cannot lower; shown "Admin (from workspace role)");
//   2. otherwise their hd_agent_roles row;
//   3. otherwise derived from the workspace permissions, so nobody who
//      worked tickets before 1.19.0's ladder loses access: agent_all +
//      reports → Manager, lead of a team → Team lead, agent → Agent.
// The workspace permissions also stay as floors on capabilities:
// helpdesk.agent_all always sees every team (tickets.view_all) and
// helpdesk.reports always reads every report (reports.all).
//
// Team-scoped capabilities (HD_CAP_SCOPE) apply in the teams a person
// belongs to unless they hold the lifting capability (tickets.view_all,
// macros.manage_all, reports.all, teams.manage).
//
// Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { cache } from "react";
import { apiSession, crossOriginRejection } from "../api-auth";
import { featureEnabled } from "../ee";
import { userHolds } from "../access";
import { getSetting, setSetting } from "../db";
import type { Role, SessionUser } from "../types";
import type { PermissionKey } from "../permissions";
import { hq, hqOne } from "./db-core";
import {
  HD_CAP_SCOPE,
  HD_CAP_KEYS,
  HD_MATRIX_VERSION,
  assignableRolesFor,
  resolveMatrix,
  resolveRole,
  roleDisplayLabel,
  toOverrides,
  type HdCap,
  type HdCapsView,
  type HdRole,
  type HdRoleFacts,
  type HdRoleMatrix,
  type HdRoleSource,
} from "./roles-shared";

export { HD_ROLES_SCHEMA } from "./roles-schema";
export { HD_ROLES, HD_ROLE_LABEL, HD_CAPABILITIES, HD_DEFAULT_MATRIX } from "./roles-shared";
export type { HdRole, HdCap, HdRoleMatrix, HdCapsView } from "./roles-shared";

type U = { id: number; role: Role };

export const HD_ROLE_CAPS_KEY = "helpdesk_role_caps";

// --- The matrix ---------------------------------------------------------------------

// A short in-process cache: hdCan runs several times a request, and the
// matrix changes rarely (writes here clear it).
let matrixCache: { at: number; value: HdRoleMatrix } | null = null;
const MATRIX_TTL_MS = 2000;

let matrixOverride: HdRoleMatrix | null = null;
/** Test seam: this process reads `m` as the matrix (null: the stored one again). Never touches the shared setting. */
export function setRoleMatrixForTests(m: HdRoleMatrix | null): void {
  matrixOverride = m;
  matrixCache = null;
}

/** The effective matrix: defaults with the stored overrides on top. */
export async function getRoleMatrix(): Promise<HdRoleMatrix> {
  if (matrixOverride) return matrixOverride;
  if (matrixCache && Date.now() - matrixCache.at < MATRIX_TTL_MS) return matrixCache.value;
  let raw: unknown = null;
  try {
    const s = await getSetting(HD_ROLE_CAPS_KEY);
    raw = s ? JSON.parse(s) : null;
  } catch {
    raw = null;
  }
  const value = resolveMatrix(raw);
  matrixCache = { at: Date.now(), value };
  return value;
}

/** Store a checked matrix (roles-shared checkMatrix) as overrides. */
export async function saveRoleMatrix(m: HdRoleMatrix): Promise<HdRoleMatrix> {
  // `v`: the catalog version these lists are complete for (roles-shared HD_MATRIX_VERSION).
  await setSetting(HD_ROLE_CAPS_KEY, JSON.stringify({ ...toOverrides(m), v: HD_MATRIX_VERSION }));
  matrixCache = null;
  return getRoleMatrix();
}

/** Forget the cached matrix (tests that write the setting directly). */
export function clearRoleMatrixCache(): void {
  matrixCache = null;
}

// --- Effective role -------------------------------------------------------------------

async function holds(user: U, key: PermissionKey): Promise<boolean> {
  return userHolds(user, key, { legacyMin: "admin" });
}

async function loadUser(userOrId: U | number): Promise<U | null> {
  if (typeof userOrId !== "number") return userOrId;
  const row = await hqOne<{ id: number; role: Role }>("SELECT id, role FROM users WHERE id = $1 AND status = 'active'", [userOrId]);
  return row ?? null;
}

// 1.19.4 (C2, lib/helpdesk/api-tokens): an API token's service account has
// no hd_agent_roles or hd_team_members row; its live token's role and teams
// stand in for them (`api` below is empty for everyone else).
const roleRowFacts = cache(async (userId: number) => {
  const row = await hqOne<{ explicit: HdRole | null; lead: boolean; teams: number[] }>(
    `WITH api AS (SELECT role, team_ids FROM hd_api_tokens
                   WHERE principal_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))
     SELECT COALESCE((SELECT role FROM hd_agent_roles WHERE user_id = $1), (SELECT role FROM api)) AS explicit,
            EXISTS (SELECT 1 FROM hd_team_members WHERE user_id = $1 AND role = 'lead') AS lead,
            COALESCE((SELECT array_agg(x ORDER BY x) FROM (SELECT team_id AS x FROM hd_team_members WHERE user_id = $1
                                                          UNION SELECT unnest(team_ids) FROM api) s), '{}') AS teams`,
    [userId]
  );
  return { explicit: row?.explicit ?? null, lead: Boolean(row?.lead), teams: row?.teams ?? [] };
});

/** Everything the role rules read about one person. */
export async function roleFacts(user: U): Promise<HdRoleFacts & { teams: number[] }> {
  const [row, admin, agentAll, agent, reports] = await Promise.all([
    roleRowFacts(user.id),
    holds(user, "helpdesk.admin"),
    holds(user, "helpdesk.agent_all"),
    holds(user, "helpdesk.agent"),
    holds(user, "helpdesk.reports"),
  ]);
  return { explicit: row.explicit, admin, agentAll, agent, reports, leadAnywhere: row.lead, teams: row.teams };
}

/** The person's effective desk role, or null (no desk access). Takes a user or a user id. */
export async function hdRoleOf(userOrId: U | number): Promise<{ role: HdRole; source: HdRoleSource } | null> {
  const user = await loadUser(userOrId);
  if (!user) return null;
  return resolveRole(await roleFacts(user));
}

interface Effective {
  role: HdRole | null;
  source: HdRoleSource | null;
  caps: Set<HdCap>;
  teams: number[];
  facts: HdRoleFacts;
}

async function effective(user: U): Promise<Effective> {
  const [facts, matrix] = await Promise.all([roleFacts(user), getRoleMatrix()]);
  const r = resolveRole(facts);
  const caps = new Set<HdCap>(r ? matrix[r.role] : []);
  // The workspace permissions stay as floors.
  if (r && facts.agentAll) caps.add("tickets.view_all");
  if (facts.reports) caps.add("reports.all");
  return { role: r?.role ?? null, source: r?.source ?? null, caps, teams: facts.teams, facts };
}

/**
 * May this person use capability `cap`? With `teamId`, a team-scoped
 * capability needs membership of that team (or the lifting capability).
 * A null or missing teamId checks the capability only: the caller has
 * already checked the ticket itself (canWorkTicket).
 */
export async function hdCan(user: U, cap: HdCap, opts: { teamId?: number | null } = {}): Promise<boolean> {
  const e = await effective(user);
  if (!e.caps.has(cap)) return false;
  if (opts.teamId == null) return true;
  const wide = HD_CAP_SCOPE[cap];
  if (!wide || e.caps.has(wide)) return true;
  return e.teams.includes(opts.teamId);
}

/** The teams this person leads (as the desk understands it): an explicit Team lead leads all their teams. */
export async function hdLeadTeamIds(userId: number): Promise<number[]> {
  const row = await roleRowFacts(userId);
  if (row.explicit === "team_lead") return row.teams;
  if (row.explicit) return [];
  const rows = await hq<{ team_id: number }>("SELECT team_id FROM hd_team_members WHERE user_id = $1 AND role = 'lead' ORDER BY team_id", [userId]);
  return rows.map((r) => r.team_id);
}

/** The person's desk standing for the UI (rail, settings nav, row controls). */
export async function hdCapsFor(user: U): Promise<HdCapsView> {
  const [e, lead] = await Promise.all([effective(user), hdLeadTeamIds(user.id)]);
  const caps = HD_CAP_KEYS.filter((c) => e.caps.has(c));
  return {
    role: e.role,
    role_label: e.role && e.source ? roleDisplayLabel(e.role, e.source) : "No desk role",
    source: e.source,
    locked: e.source === "workspace",
    caps,
    team_ids: e.teams,
    lead_team_ids: lead,
    assignable_roles: assignableRolesFor(e.role, caps),
  };
}

/** The roles `byUser` may hand out (see roles-shared assignableRolesFor). */
export async function assignableRoles(byUser: U): Promise<HdRole[]> {
  const e = await effective(byUser);
  return assignableRolesFor(e.role, HD_CAP_KEYS.filter((c) => e.caps.has(c)));
}

/** hd_team_members.role for this person's teams: 'lead' for an explicit Team lead, 'agent' for other explicit roles, null = keep. */
export async function teamRoleFor(userId: number): Promise<"agent" | "lead" | null> {
  const row = await roleRowFacts(userId);
  if (!row.explicit) return null;
  return row.explicit === "team_lead" ? "lead" : "agent";
}

// --- Route guard -------------------------------------------------------------------------

export const HD_FORBIDDEN = "You don't have permission for that.";

/**
 * helpdeskGate for a capability: same-origin, signed in (401), licensed
 * (402), then hdCan (403; 503 when permissions can't be read).
 */
export async function hdCapGate(cap: HdCap, opts: { teamId?: number | null } = {}): Promise<SessionUser | NextResponse> {
  const cross = await crossOriginRejection();
  if (cross) return cross;
  const user = await apiSession("desk"); // 1.20.5: desk side, so the Duo desk rule applies
  if (user instanceof NextResponse) return user;
  if (!(await featureEnabled("helpdesk"))) return NextResponse.json({ error: "The helpdesk is not included in your licence." }, { status: 402 });
  let ok: boolean;
  try {
    ok = await hdCan(user, cap, opts);
  } catch {
    return NextResponse.json({ error: "Could not evaluate permissions. Try again shortly." }, { status: 503 });
  }
  if (!ok) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  return user;
}

/** Like hdCapGate, admitting anyone holding at least one of `caps`. */
export async function hdAnyCapGate(caps: HdCap[]): Promise<SessionUser | NextResponse> {
  const cross = await crossOriginRejection();
  if (cross) return cross;
  const user = await apiSession("desk"); // 1.20.5: desk side, so the Duo desk rule applies
  if (user instanceof NextResponse) return user;
  if (!(await featureEnabled("helpdesk"))) return NextResponse.json({ error: "The helpdesk is not included in your licence." }, { status: 402 });
  try {
    for (const c of caps) if (await hdCan(user, c)) return user;
  } catch {
    return NextResponse.json({ error: "Could not evaluate permissions. Try again shortly." }, { status: 503 });
  }
  return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
}
