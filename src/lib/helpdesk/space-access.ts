// Helpdesk 1.19.0: the "Request access" workflow's one special action.
//
// When a request raised from a private space someone cannot open (source
// 'space_access', source_ref.space_id) finishes with every approval
// approved, the requester is given READ access to that space: a
// space-scoped assignment of the seeded `space-member` role, the same row
// the roles console's "Assign" writes (lib/db assignRole). Never more than
// read: the role key is fixed here, not taken from the request, and a
// space that is not private is left alone (there is nothing to grant).
//
// Who may name a space, and which run may grant it (1.19.0 review fix):
// a requester's source_ref.space_id is kept only on a request of the
// "Request access" type (isAccessRequestType: its workflow asks the
// space's owner) and only for a private space they cannot read yet
// (checkRequesterSource, the requests route); anything else is dropped
// silently, so nothing tells which spaces exist. At Finish the engine
// grants only when runMayGrantSpace holds: a "Request access" run whose
// space-owner approvals were asked of that same space and approved.
// Requesters see a space-owner approval as SPACE_APPROVER_PUBLIC_LABEL,
// never the owner's name.
//
// The grant is written inside the engine's transaction (grantReadInTx), so
// a run is never "done" without it; what follows a membership change (the
// space's policy audiences, lib/db reconcilePoliciesForSpace) and the audit
// row run after the commit (afterGrant). Audit: helpdesk.space_access.granted
// on the space, actor the approver whose decision finished the run.
//
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { reconcilePoliciesForSpace } from "../db";
import { audit } from "../audit";
import type { AuditActor } from "../audit";
import { scopeAllows } from "../space-scope";
import type { Role } from "../types";
import { hq, hqOne } from "./db-core";
import type { HdQueryable } from "./db-core";

/** The only role this module ever assigns. */
export const SPACE_ACCESS_ROLE_KEY = "space-member";

export interface SpaceGrant {
  space_id: number;
  space_name: string;
  user_id: number;
  /** False when the person could already read the space (nothing new written). */
  granted: boolean;
}

/** The space a request asks access to, when it is one ("space_access" with a numeric space_id). */
export function requestedSpaceId(ticket: { source: string; source_ref: Record<string, unknown> | null }): number | null {
  if (ticket.source !== "space_access") return null;
  const id = Number(ticket.source_ref?.space_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** What requesters see for a space-owner approval, whoever it resolved to (so it tells nothing about the space). */
export const SPACE_APPROVER_PUBLIC_LABEL = "the people who look after the space";

/** The keys of a definition's approval steps that ask the space's owner (top level: approvals never sit in a group). */
export function spaceApprovalKeys(def: { steps?: unknown[] } | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const s of (def?.steps ?? []) as { kind?: string; key?: string; approver?: { kind?: string } }[]) {
    if (s?.kind === "approval" && s.approver?.kind === "space_owner" && typeof s.key === "string") keys.add(s.key);
  }
  return keys;
}

/**
 * Is this the "Request access" type: an active type whose published
 * workflow (the one a new request of it starts, the same choice as
 * lib/helpdesk/engine startWorkflowForRequest) has an approval step that
 * asks the space's owner? Only such a request may name a space, and only
 * its run may grant one.
 */
export async function isAccessRequestType(requestTypeId: number, client?: HdQueryable): Promise<boolean> {
  const rows = await hq<{ definition: { steps?: unknown[] } }>(
    `SELECT w.definition FROM hd_request_types rt
       JOIN hd_workflows w ON w.published = 1
        AND (w.id = rt.workflow_id OR (rt.workflow_id IS NULL AND (w.definition->'trigger'->>'request_type_id')::int = rt.id))
      WHERE rt.id = $1 AND rt.active = 1
      ORDER BY w.id LIMIT 1`,
    [requestTypeId],
    client
  );
  return rows.length > 0 && spaceApprovalKeys(rows[0].definition).size > 0;
}

/**
 * Where a requester's new request says it came from, checked on the
 * server (the requests route). A space may be named only by a "Request
 * access" request (isAccessRequestType), and only a space that exists, is
 * private and that the requester cannot read already; anything else is
 * dropped without a word, so the answer is the same whether or not a space
 * is there. Source 'space_access' on any other type becomes 'portal': no
 * other type's run may ever grant a space.
 */
export async function checkRequesterSource<S extends string>(
  user: { id: number; role: Role },
  source: S,
  sourceRef: Record<string, number>,
  requestTypeId: number | null
): Promise<{ source: S | "portal"; source_ref: Record<string, number> }> {
  const { space_id: spaceId, ...rest } = sourceRef;
  if (source !== "space_access") return { source, source_ref: rest };
  if (!requestTypeId || !(await isAccessRequestType(requestTypeId))) return { source: "portal", source_ref: rest };
  if (spaceId && (await spaceAccessCanBeAsked(user, spaceId))) return { source, source_ref: { ...rest, space_id: spaceId } };
  return { source, source_ref: rest };
}

/**
 * May this run grant `spaceId`? Only a "Request access" run (its pinned
 * definition asks the space's owner), only when every approval of the run
 * was approved, and only when its space-owner approvals (one at least)
 * were asked of that same space's owner or space managers (approver kind
 * 'user' or 'space', step result.space_id = spaceId). A fallback approver
 * (no space named) never counts: whoever approved never saw a space.
 */
export async function runMayGrantSpace(
  client: HdQueryable,
  runId: number,
  definition: { steps?: unknown[] } | null | undefined,
  spaceId: number
): Promise<boolean> {
  const keys = spaceApprovalKeys(definition);
  if (!keys.size) return false;
  const rows = await hq<{ decision: string; approver_kind: string; step_key: string; space_id: string | null }>(
    `SELECT a.decision, a.approver_kind, s.step_key, s.result->>'space_id' AS space_id
       FROM hd_approvals a JOIN hd_workflow_steps s ON s.id = a.step_id
      WHERE a.run_id = $1`,
    [runId],
    client
  );
  if (!rows.length || rows.some((r) => r.decision !== "approved")) return false;
  const space = rows.filter((r) => keys.has(r.step_key));
  return space.length > 0 && space.every((r) => (r.approver_kind === "user" || r.approver_kind === "space") && Number(r.space_id) === spaceId);
}

/** A private space that exists and that this person cannot read yet. */
async function spaceAccessCanBeAsked(user: { id: number; role: Role }, spaceId: number): Promise<boolean> {
  const space = await hqOne<{ visibility: string }>("SELECT visibility FROM spaces WHERE id = $1", [spaceId]);
  if (!space || space.visibility !== "private") return false;
  const { spaceScopeFor } = await import("../access");
  return !scopeAllows(await spaceScopeFor(user), spaceId);
}

/**
 * Grant `userId` read on `spaceId` inside the caller's transaction. Null
 * when the space is gone, not private, or the account is not active.
 */
export async function grantReadInTx(client: PoolClient, spaceId: number, userId: number): Promise<SpaceGrant | null> {
  const s = await client.query<{ id: number; name: string; visibility: string }>(
    "SELECT id, name, visibility FROM spaces WHERE id = $1",
    [spaceId]
  );
  const space = s.rows[0];
  if (!space || space.visibility !== "private") return null;
  const u = await client.query("SELECT 1 FROM users WHERE id = $1 AND status = 'active'", [userId]);
  if (!u.rowCount) return null;
  const r = await client.query(
    `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
     SELECT r.id, $2, 'space', $1 FROM roles r WHERE r.key = $3
     ON CONFLICT DO NOTHING RETURNING id`,
    [spaceId, userId, SPACE_ACCESS_ROLE_KEY]
  );
  return { space_id: space.id, space_name: space.name, user_id: userId, granted: (r.rowCount ?? 0) > 0 };
}

/** After the commit: the space's policy audiences follow the new member, and the grant is on the record. */
export async function afterGrant(
  grant: SpaceGrant,
  ctx: { actor: AuditActor | null; ticketNumber: number; ticketId: number; requesterName: string }
): Promise<void> {
  if (grant.granted) {
    await reconcilePoliciesForSpace(grant.space_id).catch((e) =>
      console.error("[helpdesk] could not reconcile the space's policies after an access grant:", e)
    );
  }
  await audit({
    actor: ctx.actor ?? { name: "system" },
    action: "helpdesk.space_access.granted",
    targetType: "space",
    targetId: grant.space_id,
    targetLabel: grant.space_name,
    details: {
      user_id: grant.user_id,
      user_name: ctx.requesterName,
      role: SPACE_ACCESS_ROLE_KEY,
      ticket_id: ctx.ticketId,
      ticket_number: ctx.ticketNumber,
      already_member: !grant.granted,
    },
  });
}
