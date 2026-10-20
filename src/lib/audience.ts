// Policy audiences (D1, 1.13.0): the pure half.
//
// A policy asks either everyone who can see its space ('space' mode, what
// every policy did before 1.13.0) or the people its rules name ('targeted':
// groups, named people and ladder roles, minus exclusions). The rules are
// stored as rows; lib/db materialises the result as one policy_assignments
// row per person (reconcilePolicyAssignments) and every count reads those
// rows. This module holds what needs no database: the rule validation the
// route and the preview share, and the SQL fragments that say whether a
// person is in a policy's audience, so the reconcile, the per-person hooks
// and the preview cannot disagree about who is asked.
//
// The visibility ceiling is not a rule: lib/db ANDs its ACK_VISIBILITY
// fragment into every target, so a rule narrows and never widens. Nothing
// here interpolates user input: refs travel as parameters, and the only
// strings spliced into SQL are column aliases this module or lib/db wrote.

import type { AudienceMode, AudienceRule, AudienceRuleEffect, AudienceRuleKind } from "./types";

export const AUDIENCE_MODES = ["space", "targeted"] as const;
export const AUDIENCE_RULE_KINDS = ["group", "user", "role"] as const;
export const AUDIENCE_RULE_EFFECTS = ["include", "exclude"] as const;
/** The ladder roles a role rule may name (the Roles checkbox list on the Settings tab). */
export const AUDIENCE_ROLES = ["viewer", "editor", "approver", "admin"] as const;
/** More rules than this on one policy is a mistake, not an audience. */
export const AUDIENCE_RULES_MAX = 200;

export function isAudienceMode(v: unknown): v is AudienceMode {
  return typeof v === "string" && (AUDIENCE_MODES as readonly string[]).includes(v);
}

/**
 * The rules a request body carries, as the table stores them: unknown
 * kinds and effects are dropped, a group or user ref must be a positive
 * integer (kept as text, the column's type), a role ref one of
 * AUDIENCE_ROLES, duplicates collapse, and the list is capped. A missing
 * effect means 'include'. Never throws: a body that is not a list is an
 * empty audience, and the route says so with its own 400.
 */
export function sanitizeRules(raw: unknown): AudienceRule[] {
  if (!Array.isArray(raw)) return [];
  const out: AudienceRule[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const kind = r.kind;
    if (typeof kind !== "string" || !(AUDIENCE_RULE_KINDS as readonly string[]).includes(kind)) continue;
    const effect = r.effect === undefined ? "include" : r.effect;
    if (typeof effect !== "string" || !(AUDIENCE_RULE_EFFECTS as readonly string[]).includes(effect)) continue;
    let ref: string;
    if (kind === "role") {
      ref = String(r.ref ?? "").trim().toLowerCase();
      if (!(AUDIENCE_ROLES as readonly string[]).includes(ref)) continue;
    } else {
      const n = typeof r.ref === "number" ? r.ref : Number(String(r.ref ?? "").trim());
      if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) continue;
      ref = String(n);
    }
    const key = `${kind}:${ref}:${effect}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind as AudienceRuleKind, ref, effect: effect as AudienceRuleEffect });
    if (out.length >= AUDIENCE_RULES_MAX) break;
  }
  return out;
}

/** An assignment row that still asks: not closed, not excused. `pa` is the policy_assignments alias. */
export const PA_OPEN = `pa.removed_at IS NULL AND pa.exempt_at IS NULL`;

/**
 * The numbers the audience code falls back to when no policy, space or
 * workspace value is set: the same figures as lib/ack-due's BUILT_IN (E1),
 * repeated here so this module stays free of that one. The SQL spells them
 * as the last COALESCE arm; the resolved workspace values travel as
 * parameters.
 */
export const AUDIENCE_BUILT_IN = { due_days: 14, new_joiner_days: 14 } as const;

/**
 * The aliases and expressions the audience predicates are written over.
 * `rules` is a relation of (kind text, ref text, effect text): the saved
 * rows (audienceRulesFromTable) or a jsonb parameter (audienceRulesFromJson,
 * the preview). `mode` and `excludeStewards` are SQL expressions (a column,
 * a parameter). `visible` and `steward` are predicates lib/db supplies over
 * the same aliases (its ACK_VISIBILITY and ACK_STEWARD).
 */
export interface AudienceSqlAliases {
  /** The documents alias (id, space_id, author). */
  doc: string;
  /** The users alias (id, role, status). */
  user: string;
  rules: string;
  mode: string;
  excludeStewards: string;
  visible: string;
  steward: string;
}

/** The saved rules of the document whose id `docIdExpr` names. */
export function audienceRulesFromTable(docIdExpr: string): string {
  return `SELECT r.kind, r.ref, r.effect FROM policy_audience_rules r WHERE r.document_id = ${docIdExpr}`;
}

/** Rules from a jsonb parameter ([{kind, ref, effect}], as sanitizeRules shapes them). */
export function audienceRulesFromJson(param: string): string {
  return `SELECT x->>'kind' AS kind, x->>'ref' AS ref, COALESCE(x->>'effect', 'include') AS effect
          FROM jsonb_array_elements(${param}::jsonb) x`;
}

/**
 * EXISTS over the rules: a user rule names the person, a group rule one of
 * their groups, a role rule their ladder role. The numeric refs go through
 * CASE so a stray non-numeric ref (a hand edit) compares as NULL instead of
 * failing the statement; sanitizeRules never writes one.
 */
function ruleMatch(a: AudienceSqlAliases, effect: AudienceRuleEffect, kind?: AudienceRuleKind): string {
  const u = a.user;
  const num = `CASE WHEN r.ref ~ '^[0-9]{1,10}$' THEN r.ref::bigint END`;
  return `EXISTS (
      SELECT 1 FROM (${a.rules}) r
      WHERE r.effect = '${effect}'${kind ? ` AND r.kind = '${kind}'` : ""}
        AND (
          (r.kind = 'user' AND ${num} = ${u}.id)
          OR (r.kind = 'group' AND EXISTS (
                SELECT 1 FROM group_members gm WHERE gm.group_id = ${num} AND gm.user_id = ${u}.id))
          OR (r.kind = 'role' AND r.ref = ${u}.role)
        )
    )`;
}

/**
 * Boolean: the policy's audience admits this person. Space mode admits
 * everyone; targeted mode needs an include rule; an exclude rule or, when
 * the policy says so, being its author or an approver takes them out. The
 * account's status and the visibility ceiling are the caller's AND: they
 * apply in both modes and are not a matter of rules.
 */
export function audienceAdmitsSql(a: AudienceSqlAliases): string {
  return `(
      (${a.mode} = 'space' OR ${ruleMatch(a, "include")})
      AND NOT ${ruleMatch(a, "exclude")}
      AND NOT ((${a.excludeStewards}) AND ${a.steward})
    )`;
}

/** The source an admitted person's row records: 'space', else the first include rule that names them (user, group, role). */
export function audienceSourceSql(a: AudienceSqlAliases): string {
  return `CASE WHEN ${a.mode} = 'space' THEN 'space'
                 WHEN ${ruleMatch(a, "include", "user")} THEN 'user'
                 WHEN ${ruleMatch(a, "include", "group")} THEN 'group'
                 ELSE 'role' END`;
}

/** What a reconcile writes as removed_reason when neither the account nor the access changed: the trigger says which. */
export type AudienceNarrowing = "left_group" | "audience_narrowed";

/**
 * Why an open row closes, read from what changed: the account was
 * disabled, the person lost sight of the space, else what triggered the
 * reconcile (`narrowing`: a group hook says 'left_group', a save of the
 * rules or the hourly sweep 'audience_narrowed'). The row's own source
 * cannot tell these apart: a row from the switch-on keeps source 'space'
 * through a later move to targeted mode. Written as the row's
 * removed_reason.
 */
export function audienceRemovedReasonSql(a: AudienceSqlAliases, narrowing: AudienceNarrowing = "audience_narrowed"): string {
  const fallback = narrowing === "left_group" ? "'left_group'" : "'audience_narrowed'";
  return `CASE WHEN ${a.user}.status <> 'active' THEN 'disabled'
                 WHEN NOT ${a.visible} THEN 'access_removed'
                 ELSE ${fallback} END`;
}

/** "policy" / "policies" for a count (the welcome notice and the toast). */
export function policyNoun(n: number): string {
  return n === 1 ? "policy" : "policies";
}

/**
 * The toast the Settings tab shows after a save (wave 2 renders it): the
 * people the audience gained and lost, in the glossary's words. Re-opened
 * rows count as added: the person is asked again.
 */
export function audienceSavedToast(r: { added: number; closed: number; reopened: number }): string {
  const added = r.added + r.reopened;
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  if (added === 0 && r.closed === 0) return "Audience saved. Nobody was added or removed.";
  const parts: string[] = [];
  if (added > 0) parts.push(`${people(added)} added`);
  if (r.closed > 0) parts.push(`${people(r.closed)} removed from the audience`);
  return `Audience saved: ${parts.join(", ")}`;
}
