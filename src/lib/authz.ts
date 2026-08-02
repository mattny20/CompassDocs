// The authorization engine: resolve what a principal may do, and prove why.
//
// Model, deliberately small:
//   - Roles hold permissions. Assignments bind a role to a subject (a user, or
//     a group they belong to) at a scope (global, or one space).
//   - Effective permissions are the UNION of every assignment that applies.
//   - There are no deny rules, no hierarchy, and no wildcards. A permission is
//     held or it is not. Deny precedence is where these systems become
//     impossible to reason about at 2am; the restrictive posture is available
//     by granting narrowly instead.
//   - `admin` is not special to the checker. The Administrator preset simply
//     holds nearly every key, and can be edited like any other role.
//
// Unknown permission keys — a downgrade reading rows written by a newer build —
// are ignored, so an unrecognised grant denies rather than allows.
//
// Server-only.

import "server-only";
import { pool } from "./db";
import { isPermissionKey, permission } from "./permissions";
import type { PermissionKey } from "./permissions";

/** Everything a principal holds, resolved once and then queried in memory. */
export interface Grants {
  userId: number;
  /** Permissions held everywhere. */
  global: Set<PermissionKey>;
  /** Permissions held only within specific spaces: permission → space ids. */
  perSpace: Map<PermissionKey, Set<number>>;
}

interface GrantRow {
  permission: string;
  scope_type: string;
  space_id: number | null;
  role_name: string;
  via_group: string | null;
}

/**
 * One query per request. Joins the user's direct assignments and the ones they
 * inherit through group membership, and returns the permission rows plus enough
 * provenance for the explainer below.
 */
async function grantRows(userId: number): Promise<GrantRow[]> {
  const { rows } = await pool().query<GrantRow>(
    `SELECT rp.permission, ra.scope_type, ra.space_id, r.name AS role_name, g.name AS via_group
       FROM role_assignments ra
       JOIN roles r ON r.id = ra.role_id
       JOIN role_permissions rp ON rp.role_id = ra.role_id
       LEFT JOIN groups g ON g.id = ra.group_id
      WHERE ra.user_id = $1
         OR ra.group_id IN (SELECT group_id FROM group_members WHERE user_id = $1)`,
    [userId]
  );
  return rows;
}

export async function grantsFor(userId: number): Promise<Grants> {
  const rows = await grantRows(userId);
  const global = new Set<PermissionKey>();
  const perSpace = new Map<PermissionKey, Set<number>>();
  for (const r of rows) {
    if (!isPermissionKey(r.permission)) continue; // unknown key ⇒ no grant
    const key = r.permission as PermissionKey;
    if (r.scope_type === "global") {
      global.add(key);
    } else if (r.space_id !== null) {
      let set = perSpace.get(key);
      if (!set) perSpace.set(key, (set = new Set()));
      set.add(r.space_id);
    }
  }
  return { userId, global, perSpace };
}

/**
 * Does this principal hold `key`?
 *
 * `spaceId` is required for space-scoped permissions and rejected for the
 * others, so "did I remember to pass the space?" is a type-level question at
 * the call sites rather than a runtime accident. A space-scoped permission held
 * globally applies in every space.
 */
export function holds(g: Grants, key: PermissionKey, spaceId?: number): boolean {
  if (g.global.has(key)) return true;
  if (spaceId === undefined) return false;
  return g.perSpace.get(key)?.has(spaceId) === true;
}

/** The space ids in which this principal holds `key`, or "all". */
export function spacesWith(g: Grants, key: PermissionKey): "all" | number[] {
  if (g.global.has(key)) return "all";
  return [...(g.perSpace.get(key) ?? [])];
}

// --- Explaining a decision -------------------------------------------------

export interface GrantExplanation {
  permission: PermissionKey;
  label: string;
  granted: boolean;
  /** Every assignment that confers it, in the order they were found. */
  via: { role: string; scope: string; group: string | null }[];
}

/**
 * "Why can Priya publish in Engineering?" — traces a decision back to the
 * assignments that produced it. Cheap now that grants are relational, and the
 * difference between an RBAC system people trust and one they fight.
 */
export async function explain(
  userId: number,
  key: PermissionKey,
  spaceId?: number
): Promise<GrantExplanation> {
  const rows = await grantRows(userId);
  const via = rows
    .filter((r) => r.permission === key)
    .filter((r) => r.scope_type === "global" || (spaceId !== undefined && r.space_id === spaceId))
    .map((r) => ({
      role: r.role_name,
      scope: r.scope_type === "global" ? "the whole workspace" : `this space`,
      group: r.via_group,
    }));
  return {
    permission: key,
    label: permission(key).label,
    granted: via.length > 0,
    via,
  };
}

// --- The lockout guard -----------------------------------------------------

/**
 * The permission that defines "can still let everyone else back in". Typed as a
 * PermissionKey rather than inlined into the SQL below, so renaming it in the
 * catalog is a compile error here instead of a query that silently counts zero
 * and bricks the workspace.
 */
export const RECOVERY_PERMISSION: PermissionKey = "user.update_role";

/**
 * How many ACTIVE users can still administer other users?
 *
 * This replaces countAdmins(). Under custom roles there is no `admin` row to
 * count — what matters is whether anyone can still restore everyone else's
 * access, which is exactly "holds RECOVERY_PERMISSION at global scope".
 *
 * Callers MUST pass the client of the transaction performing the demotion or
 * deletion. Counting on a different connection is a time-of-check/time-of-use
 * race: two concurrent demotions each see two admins, and the workspace ends up
 * with none and no recovery short of database surgery.
 */
export async function countGlobalUserAdmins(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { n: string }[] }> },
  excludingUserId?: number
): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(DISTINCT u.id)::text AS n
       FROM users u
       JOIN role_assignments ra
         ON ra.user_id = u.id
         OR ra.group_id IN (SELECT group_id FROM group_members WHERE user_id = u.id)
       JOIN role_permissions rp ON rp.role_id = ra.role_id
      WHERE u.status = 'active'
        AND ra.scope_type = 'global'
        AND rp.permission = $1
        AND ($2::int IS NULL OR u.id <> $2)`,
    [RECOVERY_PERMISSION, excludingUserId ?? null]
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Who, specifically, can still administer users? The console needs this to
 * answer "if I demote this person, is anyone left?" before the admin clicks,
 * rather than only refusing afterwards.
 */
export async function recoveryHolders(): Promise<{ id: number; username: string; name: string }[]> {
  const { rows } = await pool().query<{ id: number; username: string; name: string }>(
    `SELECT DISTINCT u.id, u.username, u.name
       FROM users u
       JOIN role_assignments ra
         ON ra.user_id = u.id
         OR ra.group_id IN (SELECT group_id FROM group_members WHERE user_id = u.id)
       JOIN role_permissions rp ON rp.role_id = ra.role_id
      WHERE u.status = 'active' AND ra.scope_type = 'global' AND rp.permission = $1
      ORDER BY u.username`,
    [RECOVERY_PERMISSION]
  );
  return rows;
}

/**
 * Would this change leave nobody able to administer users? Run inside the same
 * transaction as the change itself.
 */
export async function wouldOrphanWorkspace(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { n: string }[] }> },
  userIdBeingRemoved: number
): Promise<boolean> {
  return (await countGlobalUserAdmins(client, userIdBeingRemoved)) === 0;
}
