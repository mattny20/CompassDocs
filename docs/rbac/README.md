# RBAC design notes

Working documents for the move from the four-rung role ladder
(`viewer < editor < approver < admin`) to full role-based access control, and
for adding Google Workspace alongside Microsoft as an identity source.

These are **design notes, not user documentation** — user-facing docs live in
the `compassdocs-docs` site. They're kept in-repo because the permission
catalog is the contract the implementation is checked against, and because the
risk list is the reason several things are done the awkward way.

| File | What it is |
| ---- | ---------- |
| [permission-catalog.md](permission-catalog.md) | Every capability the app guards today, as `resource.action` keys — 209 permissions across 30 families, mapped back to the checks they replace. The contract for the port. |
| [migration-risks.md](migration-risks.md) | What breaks, ranked. Read R2–R5 before touching `lib/access.ts` or `lib/types.ts`. |
| [google-workspace-provider.md](google-workspace-provider.md) | The provider interface extracted from the Microsoft stack, and the Google implementation: scopes, auth, field mapping, sync mechanics. |

## Why this is a rewrite and not a patch

Authorization is currently spread across six mechanisms that don't know about
each other:

1. the ordinal role ladder (`users.role`, `roleAtLeast`)
2. per-space read access (group grants → `SpaceScope`)
3. per-space edit rights (`editors_edit_all` + edit grants)
4. section delegation (JSON blobs in the `settings` table)
5. `users.newsletter_role` plus per-newsletter approver lists
6. training team-leads, via group leadership

Each one independently hard-codes `role === "admin"` as a superuser bypass, and
they disagree about basics — section delegation has no role floor at all, so a
Viewer holding the training grant can manage decks and export the audit
package, while `training.team_read` is reachable *only* through group
leadership, with no admin bypass at all.

## Two decisions that make it tractable

**The compiler proves completeness.** There are 214 role checks across 55
files. A migration that misses one fails *open*. So `role` comes off
`SessionUser` entirely: every one of those sites becomes a type error, and
coverage stops depending on anyone's diligence.

**Scope becomes unforgeable.** 21 data-layer functions declare
`scope?: number[] | "all"`, and omitting the argument returns unfiltered rows —
that is how a missed check becomes an open one today, invisibly to the type
checker. `SpaceScope` becomes a branded type only `spaceScopeFor()` can
construct, and forgetting it stops compiling.

## Ground rules

- **Allow-only. No deny rules.** Deny precedence is where these systems become
  unexplainable. The restrictive posture is already available by turning
  `editors_edit_all` off and granting explicitly.
- **Behaviour-preserving upgrade.** The four built-in presets must reproduce
  today's permissions exactly, so upgrading changes nothing until an admin
  chooses otherwise.
- **The last-admin guard must survive.** `countAdmins() <= 1` has no meaning
  once roles are custom. It becomes "count active principals holding
  user-management at global scope", evaluated in the same transaction as the
  demotion. Treat it as the acceptance test for the whole model: *can the
  system still prove someone can restore anyone else's access?*
- **Enforcement is not a UI concern.** The v1 API, MCP tools, share links and
  public routes authorize themselves today and must go through the same
  `can()`. The v1 `read`/`write` scope stays a *ceiling* on top of the user's
  permissions, never a grant.

## How the port itself is done (0.92)

Measured, rather than assumed: the ~280 authorization sites are not 280
bespoke decisions. They concentrate in two helpers —

| Pattern | Sites |
| ------- | ----- |
| `apiGuard("admin")` | 105 |
| `apiGuard(<other role>)` | 61 |
| `roleAtLeast(...)` | 63 |
| `role === "admin"` | 32 |
| `requireRole(...)` | 19 |

so `apiGuard` and `requireRole` gaining a permission-taking overload covers
about two thirds of them with one consistent transformation.

**The port runs in shadow mode first.** Rather than swapping enforcement
site-by-site and hoping, each ported guard evaluates *both* the legacy ladder
check and the new permission check, **enforces the legacy answer**, and records
any disagreement with the route and the permission involved. A workspace can
then run a build where the new model is fully wired but cannot yet deny anyone,
and the question "is the port correct?" becomes a number on a page instead of a
matter of review diligence. Enforcement flips only once that number is zero.

This is deliberately slower than a big-bang swap. A wrong substitution in an
authorization port is not a build failure — it is a silent grant or a silent
denial, and 0.89.1 is a recent reminder of what the silent-grant version costs.

## The flip (0.93)

Enforcement now reads the permission, not the ladder. `apiGuard(min, permission)`
resolves the caller's grants and answers from those; `min` is still passed and
still evaluated, but only to keep recording agreement so a regression surfaces
as a number on **Settings → Roles & permissions → Health** instead of a support
ticket. A route with no permission attached still falls back to the ladder.

Three things the flip needed that the design above didn't anticipate:

- **A space you don't have yet.** A guard runs before the route knows which
  document — and therefore which space — it is dealing with. `admits()` handles
  that: with no `spaceId` in hand, a space-scoped permission is admitted if the
  caller holds it *anywhere*, and the route's existing `SpaceScope` /
  `canEditSpace` check does the narrowing, exactly as it did under the ladder.
  Nothing widens; per-space enforcement at the guard arrives with 0.94.

- **The settings console was all-or-nothing.** The `/admin` layout gated the
  whole thing on being an Administrator, so a role holding one settings
  permission could call the API but not open the page that calls it. Each
  section now declares its permission in `lib/settings-sections.ts` — one value,
  read by the page guard (`requireSettingsSection`) and by the rail, so a nav
  entry that redirects home is not expressible.

- **A way back when the model is the problem.** `COMPASSDOCS_AUTHZ_LEGACY=1`
  restores ladder enforcement at boot. An environment variable rather than a
  setting, because the failure it exists for is "nobody can sign in to change
  the setting". The console says so in a banner when it is on.

Every mutation that could reduce access — editing a role, deleting one,
revoking an assignment — **applies the change and then asserts the invariant in
the same transaction**, rolling back if no active user still holds
`RECOVERY_PERMISSION` globally. Apply-then-assert rather than predict-then-apply:
predicting whether an edit strands the workspace means reimplementing the
resolver inside the guard, and any drift between the two is a lockout. Asking
the database what became true cannot drift.

Built-in roles stay read-only in the editor. `syncPresetRoles()` re-derives them
from the catalog on every boot — that is what makes an upgrade that adds a
permission grant it without a migration — so an edit would silently revert on
restart. Duplicating a preset gives an editable copy.

## Collapsing the parallel systems (0.94)

Three of the six are gone. Each was the same shape — "these people and these
groups may do this set of things" — which is an assignment, so each became one:

| Was | Now |
| --- | --- |
| `settings.section_access_*` JSON + its own resolver | Assignments of the seeded **Announcements / Compliance / Training manager** roles |
| `users.newsletter_role` text column + `newsletter-access.ts` | Assignments of **Newsletter contributor / approver** |
| training team view reachable *only* by group leadership | leadership **or** `training.team_read` |

The settings pages did not change. `getSectionGrants`/`setSectionGrants` kept
their signatures and swapped their storage, so the console gained a shared model
without learning a new vocabulary. Existing grants migrate once on first boot,
guarded by a flag — unlike the ladder backfill this is not self-healing, because
re-running it after an admin revoked a migrated grant would put it back. The old
rows are left in place: they cost nothing, they are the only record of the prior
state, and a downgrade to 0.93 reads them.

**The bug this nearly shipped with.** The trigger mirroring `users.role` deleted
every `is_builtin` global assignment that wasn't the user's rung. The moment
delegated roles became built-in — which they must be, so upgrades extend them
from the catalog — that trigger would have revoked someone's section access on
any role change, with no error and no log line. The trigger is now scoped to the
four ladder keys, and `unassignRole`'s "this mirrors the ladder" refusal with
it. Proven both ways on the rig: under the old trigger the grant count went
1 → 0 on a role change; under the new one it stayed 1.

Two remain, both per-space, and they belong together with the per-space guard
enforcement 0.93 deferred: **space visibility** (`spaceScopeFor`) and **space
edit rights** (`editors_edit_all` + edit grants). They are the next piece.

## Per-space grants (0.95)

The space scope on an assignment finally decides something. `spaceScopeFor` and
`canEditSpace` read role assignments, and the last two hard-coded
`role === "admin"` bypasses in the authorization path become named permissions:

| Was | Now |
| --- | --- |
| `spaceScopeFor`: `role === "admin"` ⇒ every space | `space.read_all` |
| `canEditSpace`: `role === "admin"` ⇒ author anywhere | `space.author_all` |
| private-space membership: group grant only | group grant **or** space-scoped `space.member` |
| authoring: `editors_edit_all` + edit grants | those **or** space-scoped `space.author` |

**Everything is additive or an exact swap.** The Administrator preset holds both
`*_all` keys, so administrators are unchanged; a space-scoped grant is unioned
with the existing sources rather than replacing them. That is deliberate, and it
is the whole reason this shipped as its own release: when the failure mode is
"a private space became visible" or "an author lost their space", a migration
that can only widen is the only kind worth attempting without a cutover flag.

`editableScopeFor` had to be changed in lockstep with `canEditSpace` — one
decides what a list shows, the other whether a write succeeds, and a
disagreement is either a document you can see but not save or one you can save
but never find.

**Still to retire.** `space_groups`, `space_editors`, and `space_editor_groups`
remain as a second source consulted alongside assignments. Migrating their rows
into space-scoped assignments and deleting the tables is a data change with no
behavioural component, which makes it a good standalone piece of work and a bad
thing to bundle with the semantics change above.

## Status

All of RBAC ships in the community edition; only the Google and Microsoft
identity syncs are enterprise-gated. That keeps `can()` a pure function of
role assignments with no entitlement checks threaded through it.

Unverified at time of writing, flagged in the Google document and to be
confirmed against a live tenant: derived-membership behaviour for dynamic
groups nested in static ones, Reports API event coverage and latency, and
current Directory API quota values.
