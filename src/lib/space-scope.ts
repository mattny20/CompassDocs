// The space-scope value type, on its own so both the data layer (lib/db) and
// the policy layer (lib/access) can depend on it without a cycle — access.ts
// already imports db.ts, so the type cannot live there.
//
// A SpaceScope is still "all" or a list of space ids at runtime, so every query
// that branches on Array.isArray(scope) is unchanged. What is new is that the
// TYPE is branded: a bare "all" or number[] is not assignable to it, so the
// only way to get one is to ask a resolver in lib/access — which means someone
// had to decide who the caller is.
//
// The problem this solves: the data layer used to declare
// `scope?: number[] | "all"` and quietly return UNFILTERED rows when the
// argument was omitted. That is invisible to the type checker and easy to miss
// in review. With scope required and unforgeable, forgetting it is a compile
// error instead of a potential disclosure.

declare const SPACE_SCOPE: unique symbol;

/** "all" (every space) or the concrete list of visible space ids. Opaque. */
export type SpaceScope = ("all" | number[]) & { readonly [SPACE_SCOPE]: true };

/**
 * Mint a scope. Not exported beyond the policy layer by convention — call the
 * resolvers in lib/access (spaceScopeFor, editableScopeFor) instead, so the
 * scope always traces back to a principal.
 */
export const asScope = (s: "all" | number[]): SpaceScope => s as SpaceScope;

/**
 * Every space, no filtering. Deliberately verbose and greppable: only correct
 * on surfaces that have already established the caller may see the whole
 * workspace — the admin console, whose layout calls requireRole("admin"), and
 * full-export paths. Anywhere a user exists, use a resolver instead.
 */
export const EVERY_SPACE_UNFILTERED: SpaceScope = asScope("all");

export function scopeAllows(s: SpaceScope, spaceId: number): boolean {
  return s === "all" || s.includes(spaceId);
}

/** True when this scope cannot match anything, so callers can short-circuit. */
export function scopeIsEmpty(s: SpaceScope): boolean {
  return s !== "all" && s.length === 0;
}
