// Helpdesk 1.19.4 (area C2): API tokens for the helpdesk REST API
// (/api/helpdesk/v1, lib/helpdesk/api-v1). Desk settings → API and webhooks
// (settings.manage) creates, lists and revokes them.
//
// A token: "cdh_" + 32 random bytes in base64url, shown once. Only its
// SHA-256 is stored (looked up by that hash) and its last four characters
// for display. Name, expiry (a date or never), last used.
//
// "Acts as": each token gets its own service account, a users row with
// status 'service', no password and no sign-in path (sessions, the
// sign-in lookup and every people list read status 'active' only;
// lib/db listUsers leaves 'service' out), holding only the base Viewer
// rung every account has (the ladder trigger), which the API never reaches.
// The desk role ladder reads the token's role and teams for that account
// (lib/helpdesk/roles roleRowFacts, lib/helpdesk/access memberTeamIds), so
// hdCan / canWorkTicket / patchRefusal / prepareReply answer for the token
// exactly as for a person with that role in those teams, under the
// workspace's role matrix (a customised role applies). The account is never
// a team member (hd_team_members), so it is never assigned, never an
// approver or a reviewer, never in a rotation or an agent list. A token can
// be given only a role its creator may hand out (assignableRoles) and only
// teams its creator works, never Admin.
//
// Server-only.

import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { audit, type AuditActor } from "../audit";
import type { Role } from "../types";
import { hq, hqOne, withTx } from "./db-core";
import { agentTeamIds } from "./access";
import { assignableRoles, getRoleMatrix, HD_ROLE_LABEL, type HdCap } from "./roles";
import { HD_API_LIMITS, HD_API_TOKEN_PREFIX, HD_API_TOKEN_ROLES, isApiTokenRole, type HdApiOptions, type HdApiTokenRole, type HdApiTokenView } from "./api-shared";

export const API_TOKEN_RE = /^cdh_[A-Za-z0-9_-]{43}$/;

export function hashApiToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function newToken(): string {
  return `${HD_API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export class ApiTokenError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

// --- What a role can do through the API --------------------------------------------------

/** "Read tickets · update status and tags · add notes": the API's view of a capability list. */
export function apiCanLine(caps: readonly HdCap[]): string {
  const has = (c: HdCap) => caps.includes(c);
  const parts: string[] = [];
  if (!has("tickets.view_team") && !has("tickets.view_all")) return "Nothing yet (the role can't see a queue)";
  parts.push(has("tickets.view_all") ? "Read every team's tickets" : "Read tickets");
  const fields: string[] = [];
  if (has("tickets.change_status")) fields.push("status");
  if (has("tickets.change_priority")) fields.push("priority");
  if (has("tickets.transfer_team")) fields.push("team");
  if (has("tickets.assign_team") || has("tickets.assign_any")) fields.push("owner");
  fields.push("tags");
  parts.push(`update ${fields.length > 1 ? `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}` : fields[0]}`);
  if (has("tickets.internal_note")) parts.push("add notes");
  if (has("tickets.reply_public")) parts.push("reply");
  else if (has("tickets.reply_needs_review")) parts.push("reply after review");
  if (has("reports.all") || has("reports.team")) parts.push("reports");
  return parts.join(" · ");
}

// --- Creating -------------------------------------------------------------------------------

export interface ApiTokenInput {
  name: string;
  shown_as: string;
  role: HdApiTokenRole;
  team_ids: number[];
  /** ISO timestamp, or null for never. */
  expires_at: string | null;
}

type Creator = { id: number; role: Role; name: string; username?: string };

/** The teams and roles this admin may give a token. */
export async function apiOptionsFor(creator: Creator): Promise<HdApiOptions> {
  const [scope, roles, matrix, teams] = await Promise.all([
    agentTeamIds(creator),
    assignableRoles(creator),
    getRoleMatrix(),
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, name, id"),
  ]);
  return {
    teams: scope === "all" ? teams : teams.filter((t) => scope.includes(t.id)),
    all_teams: scope === "all",
    roles: HD_API_TOKEN_ROLES.filter((r) => roles.includes(r)).map((r) => ({ value: r, label: HD_ROLE_LABEL[r], can: apiCanLine(matrix[r]) })),
    base_path: "/api/helpdesk/v1",
  };
}

/** "2027-03-01" (the end of that day, UTC) or an ISO timestamp; null = never. Must be in the future, within five years. */
export function parseExpiry(raw: unknown, now = new Date()): string | null {
  if (raw === null || raw === undefined || raw === "" || raw === "never") return null;
  if (typeof raw !== "string") throw new ApiTokenError("Choose when the token expires.");
  const at = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T23:59:59.999Z`) : new Date(raw);
  if (Number.isNaN(at.getTime())) throw new ApiTokenError("That expiry date isn't a date.");
  if (at.getTime() <= now.getTime()) throw new ApiTokenError("The expiry date must be in the future.");
  if (at.getTime() > now.getTime() + 5 * 366 * 86_400_000) throw new ApiTokenError("Choose an expiry within five years, or Never.");
  return at.toISOString();
}

export async function validateTokenInput(raw: Record<string, unknown>, creator: Creator): Promise<ApiTokenInput> {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new ApiTokenError("Name the token after the tool that will use it.");
  if (name.length > HD_API_LIMITS.name) throw new ApiTokenError(`Keep the name under ${HD_API_LIMITS.name} characters.`);
  const shownRaw = typeof raw.shown_as === "string" ? raw.shown_as.trim() : "";
  if (shownRaw.length > HD_API_LIMITS.name) throw new ApiTokenError(`Keep "Shown as" under ${HD_API_LIMITS.name} characters.`);
  if (!isApiTokenRole(raw.role)) throw new ApiTokenError("Choose the desk role the token acts as.");
  const opts = await apiOptionsFor(creator);
  if (!opts.roles.some((r) => r.value === raw.role)) throw new ApiTokenError("You can't give a token that role.", 403);
  const ids = raw.team_ids ?? [];
  if (!Array.isArray(ids) || !ids.every((n) => Number.isSafeInteger(n) && (n as number) > 0)) throw new ApiTokenError("Unknown team.");
  const team_ids = [...new Set(ids as number[])].sort((a, b) => a - b);
  const allowed = new Set(opts.teams.map((t) => t.id));
  if (!team_ids.every((id) => allowed.has(id))) throw new ApiTokenError("Choose teams you work in.", 403);
  const matrix = await getRoleMatrix();
  if (!team_ids.length && !matrix[raw.role].includes("tickets.view_all")) {
    throw new ApiTokenError(`Choose at least one team: the ${HD_ROLE_LABEL[raw.role]} role only sees its teams' tickets.`);
  }
  return { name, shown_as: shownRaw || name, role: raw.role, team_ids, expires_at: parseExpiry(raw.expires_at) };
}

/** Make the token and its service account. Returns the token once; it is never stored. */
export async function createApiToken(input: ApiTokenInput, creator: Creator & AuditActor, ip: string | null = null): Promise<{ token: string; view: HdApiTokenView }> {
  const raw = newToken();
  const id = await withTx(async (client) => {
    const n = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM hd_api_tokens WHERE revoked_at IS NULL");
    if ((n.rows[0]?.n ?? 0) >= HD_API_LIMITS.tokens) throw new ApiTokenError(`A workspace can have up to ${HD_API_LIMITS.tokens} tokens. Revoke one first.`, 409);
    // The service account: never signs in (no password, status 'service'), never listed.
    const user = await client.query<{ id: number }>(
      `INSERT INTO users (username, email, name, role, status, auth_provider, password_hash, password_salt)
       VALUES ($1, '', $2, 'viewer', 'service', 'helpdesk_api', NULL, NULL) RETURNING id`,
      [`hd-api-${randomBytes(9).toString("hex")}`, input.shown_as]
    );
    const row = await client.query<{ id: number }>(
      `INSERT INTO hd_api_tokens (name, token_hash, last4, principal_id, role, team_ids, expires_at, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [input.name, hashApiToken(raw), raw.slice(-4), user.rows[0].id, input.role, input.team_ids, input.expires_at, creator.id, creator.name]
    );
    return row.rows[0].id;
  });
  const view = (await listApiTokenViews()).find((t) => t.id === id)!;
  await audit({
    actor: creator,
    action: "helpdesk.api_token.created",
    targetType: "helpdesk_api_token",
    targetId: id,
    targetLabel: input.name,
    details: { role: input.role, team_ids: input.team_ids, expires_at: input.expires_at, shown_as: input.shown_as, hint: view.hint },
    ip,
  });
  return { token: raw, view };
}

// --- Listing and revoking --------------------------------------------------------------------

interface TokenRow {
  id: number;
  name: string;
  last4: string;
  role: HdApiTokenRole;
  team_ids: number[];
  shown_as: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  created_by_name: string;
  revoked_at: string | null;
}

/** Live tokens first (newest first), then revoked ones (most recent first, the last 20). */
export async function listApiTokenViews(): Promise<HdApiTokenView[]> {
  const [rows, teams, matrix] = await Promise.all([
    hq<TokenRow>(
      `(SELECT k.id, k.name, k.last4, k.role, k.team_ids, u.name AS shown_as, k.expires_at, k.last_used_at, k.created_at, k.created_by_name, k.revoked_at
          FROM hd_api_tokens k JOIN users u ON u.id = k.principal_id WHERE k.revoked_at IS NULL ORDER BY k.id DESC)
       UNION ALL
       (SELECT k.id, k.name, k.last4, k.role, k.team_ids, u.name AS shown_as, k.expires_at, k.last_used_at, k.created_at, k.created_by_name, k.revoked_at
          FROM hd_api_tokens k JOIN users u ON u.id = k.principal_id WHERE k.revoked_at IS NOT NULL ORDER BY k.revoked_at DESC LIMIT 20)`
    ),
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams"),
    getRoleMatrix(),
  ]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    hint: `${HD_API_TOKEN_PREFIX}…${r.last4}`,
    role: r.role,
    role_label: HD_ROLE_LABEL[r.role],
    team_ids: r.team_ids,
    team_names: r.team_ids.map((id) => teamName.get(id)).filter((n): n is string => Boolean(n)),
    shown_as: r.shown_as,
    can: apiCanLine(matrix[r.role] ?? []),
    expires_at: r.expires_at,
    expired: r.expires_at !== null && Date.parse(r.expires_at) <= now,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
    created_by_name: r.created_by_name,
    revoked_at: r.revoked_at,
  }));
}

/** Revoke at once: the next call with it is a 401. The row stays for the audit trail and the name on what it wrote. */
export async function revokeApiToken(id: number, actor: AuditActor & { name: string }, ip: string | null = null): Promise<boolean> {
  const row = await hqOne<{ id: number; name: string; last4: string }>(
    "UPDATE hd_api_tokens SET revoked_at = now(), revoked_by_name = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id, name, last4",
    [id, actor.name]
  );
  if (!row) return false;
  await audit({
    actor,
    action: "helpdesk.api_token.revoked",
    targetType: "helpdesk_api_token",
    targetId: id,
    targetLabel: row.name,
    details: { hint: `${HD_API_TOKEN_PREFIX}…${row.last4}` },
    ip,
  });
  return true;
}

// --- Authenticating a request -------------------------------------------------------------------

export interface ApiPrincipal {
  token_id: number;
  token_name: string;
  role: HdApiTokenRole;
  team_ids: number[];
  expires_at: string | null;
  /** The service account the token acts as (hdCan, canWorkTicket and friends take it like a person). */
  user: { id: number; role: Role; name: string; username: string; email: string };
}

/**
 * The live token behind a raw value, or null (malformed, unknown, revoked,
 * expired: one answer for all). The last-used time is written at most once
 * a minute per token.
 */
export async function principalForToken(raw: string): Promise<ApiPrincipal | null> {
  if (!API_TOKEN_RE.test(raw)) return null;
  const row = await hqOne<{
    id: number;
    name: string;
    role: HdApiTokenRole;
    team_ids: number[];
    expires_at: string | null;
    user_id: number;
    user_role: Role;
    user_name: string;
    username: string;
  }>(
    `SELECT k.id, k.name, k.role, k.team_ids, k.expires_at, u.id AS user_id, u.role AS user_role, u.name AS user_name, u.username
       FROM hd_api_tokens k JOIN users u ON u.id = k.principal_id
      WHERE k.token_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND u.status = 'service'`,
    [hashApiToken(raw)]
  );
  if (!row) return null;
  void hq("UPDATE hd_api_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [row.id]).catch(() => {});
  return {
    token_id: row.id,
    token_name: row.name,
    role: row.role,
    team_ids: row.team_ids,
    expires_at: row.expires_at,
    user: { id: row.user_id, role: row.user_role, name: row.user_name, username: row.username, email: "" },
  };
}
