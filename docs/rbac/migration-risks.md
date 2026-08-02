# CompassDocs RBAC Migration — Risk Analysis

Ranked by severity. Each risk is tagged with the brief's topic number. Evidence is file:line from this tree (verified against source, not just the map).

---

## S0 — BLOCKERS (must be resolved before any code is written)

### R1. Fix the two live scope-bypass bugs *before* migrating — otherwise you encode them as grants [3,6]
Verified in source, not just inferred:
- `src/app/api/documents/[id]/share/route.ts:28` — `if (!(await canEditSpace(user, doc.space_id)))` with **no** preceding `scopeAllows(spaceScopeFor(user), doc.space_id)`.
- `src/app/api/trash/[id]/route.ts:19` — same omission on restore.
- Siblings do it correctly and say why: `documents/[id]/move/route.ts:25` and `documents/[id]/review/route.ts:21`.

Because `editorsEditAll()` defaults on (`src/lib/access.ts:39-41`, `getSetting("editors_edit_all") !== "0"`), `canEditSpace` returns true for any editor on any space id. The share route mints an **anonymous** `/share/<token>` link (and unlocks attachments — `api/attachments/[id]/route.ts:44-50`) for a document in a private space the editor cannot read. Any RBAC migration that derives grants from "what does the code allow today" will faithfully reproduce this. Fix, ship, and let it bake as a separate release first.

### R2. `canEditSpace` is documented as visibility-blind; a unified `can(user, "space:author", id)` silently widens it [1,3,6]
`src/lib/access.ts:43` — *"(Assumes caller verified visibility.)"*. 30 `canEditSpace(` call sites; the two above prove the unenforced contract already fails. The single highest-value design decision in this migration: **the new permission check must fold visibility in** (`space:author` implies `space:read`), and the old two-step must be deleted, not wrapped. Do a full audit of all 30 sites during the port and record the delta — any site where the new fold-in *changes* behavior is a latent bug being fixed, and needs a changelog line.

### R3. Fail-open default parameters in the data layer [3,5]
21 functions declare `scope?: number[] | "all"` (`src/lib/db.ts:1563,1701,1740,1778,1797,1824,1839,2306,2403,3663,5865,5884,5962`, `src/lib/embeddings.ts:354,410,477`, `src/lib/ai.ts:334`) and 25 sites branch `Array.isArray(scope) ? " WHERE s.id = ANY($1)" : ""` (`db.ts:1564`). **Omitting the argument produces an unfiltered query.** This is the mechanism by which a missed check becomes an open one today, and it is invisible to the type checker.

Non-negotiable in the rewrite: make scope a **required** parameter of a branded/opaque type that only `spaceScopeFor()` can construct (`export type SpaceScope = { readonly __brand: unique symbol; ... }`). Then a forgotten scope is a compile error, and `"all"` can only exist because someone resolved a principal. This single change converts the largest fail-open surface into fail-closed, and it can land **before** RBAC as an independent refactor.

### R4. The last-admin lockout guard stops being expressible [6]
`src/app/api/admin/users/[id]/route.ts:76-78` (`demoting`/`disabling` + `countAdmins() <= 1`) and `:119` (delete). `countAdmins()` counts `role = 'admin'`. Under custom roles there is no `admin` row to count — you must count *active users holding the user-management permission through any assignment at global scope*, and that query must run inside the same transaction as the demotion or you get a TOCTOU lockout. Getting this wrong bricks the workspace with no recovery path short of DB surgery. Treat it as the acceptance test for the whole model: **"can the system still prove at least one principal can restore any other principal's access?"**

### R5. `ROLE_ORDER` is doing three unrelated jobs [1]
`src/lib/types.ts:9` is simultaneously (a) the privilege ladder consumed by `roleAtLeast` (`types.ts:26`), (b) the **input validation allow-list** at `src/app/api/admin/users/route.ts:34` and `admin/users/[id]/route.ts:71` (`ROLE_ORDER.includes(role)`), and (c) the render order of the role picker (`src/components/UsersClient.tsx:156,286`). Splitting the ladder without splitting these three uses is how an unvalidated role string reaches the DB. Note the current fail-closed behavior is *accidental*: `toSessionUser` passes `role` through unvalidated (`src/lib/auth.ts:74`, contrast the defensive `newsletter_role` coercion at `:78-81`), and an unknown string only fails because `indexOf` returns `-1`. Make that explicit — unknown role/permission ⇒ deny, asserted by a test.

---

## S1 — CRITICAL

### R6. Ordinal reliance inventory (the concrete break list) [1]
| Site | Count | What breaks |
|---|---|---|
| `apiGuard(min)` `src/lib/api-auth.ts:64` | 186 bind sites, 209 `instanceof` narrows | Every API route |
| `requireRole(min)` `src/lib/auth.ts:116` | 19 | Page guards; note redirect-to-`/` existence-hiding at `:118` must be preserved (contrast `api-auth.ts:70`'s 403 JSON) |
| inline `roleAtLeast(...)` | 62 | Publish/draft/delete tiers |
| literal `role === "admin"` / `!== "admin"` | 35 | Every admin bypass: `access.ts:20`, `section-access.ts:59`, `comments/[id]/route.ts:24`, `links/icon/[id]/route.ts:22`, `digest.ts:162,200,210,229` |

Three semantic tiers hide inside the ordinal and must become **named permissions**, not rungs:
- **Publish** — `roleAtLeast(user.role,"approver") || (await getApprovalMode()) === "open"` duplicated at 11 sites (`api/documents/route.ts:61`, `documents/[id]/route.ts:136`, `bulk/route.ts:86`, `merge/route.ts:63`, `versions/[vid]/restore/route.ts:63`, `v1/documents/route.ts:94`, `v1/documents/[id]/route.ts:84`, `mcp/route.ts:505,614`, plus page mirrors). Critically, **denial is not a 403** — it downgrades to draft or queues a change request. `document:publish` must be a permission whose denial has a *declared fallback*, or the migration turns silent queueing into hard errors. `ApprovalMode` (`types.ts:29`, `db.ts:2455-2457`, default `strict`) becomes a **conditional grant** of `document:publish` to the editor role — model it explicitly or it is lost.
- **Draft visibility** — `doc.status === "draft" && !roleAtLeast(user.role,"editor")` at ~10 sites, 404 not 403. `document:read` ≠ `document:read_draft`.
- **Status-split delete** — `documents/[id]/route.ts:290` (editors delete drafts, approver+ delete published), `trash/[id]/route.ts:33` (admin purge).

### R7. Sorting: there is an ordinal dependency in SQL, and it is already wrong [1]
`src/lib/db.ts:2492` — `listUsers()` does `ORDER BY role DESC, username`. That is a **lexical** sort on the text column that only coincidentally yields viewer→editor→approver→admin (alphabetical descending). It is not `ROLE_ORDER` and it is not privilege order. The moment a custom role named `"compliance-manager"` exists, the admin user list orders arbitrarily. The role registry table needs an explicit `rank int` (or `sort_order`) column and this query needs a join — trivial, but it will be missed because nobody greps for `ORDER BY role`.

### R8. Batch/cron paths compute authorization with no request context [1,3,5]
`src/lib/digest.ts:162,200,210,229` reads `u.role` off raw DB rows and branches (`u.role === "admin" || u.role === "approver"`), embedding the ladder into SQL parameter selection. Same class: `newsletter-scheduler.ts`, `doc-schedule.ts`, `reviews.ts`, `backlinks.ts` (both in the `=== "all"` grep). These have **no `SessionUser`**. The RBAC engine therefore needs an offline resolver `effectivePermissions(userId)` usable outside a request, and the digest must not be allowed to fall back to "no scope ⇒ everything" (see R3 — `reviews.ts` and `backlinks.ts` are in the fail-open list).

### R9. SSO email-linking hardening depends on "is this an admin account" [6]
`CHANGELOG.md:762-766`: *"SSO no longer silently links to an admin account or one already bound to a different provider; OIDC now ignores an explicitly-unverified email and never treats the mutable `preferred_username` as an identity; multi-tenant Entra requires an email-domain allowlist."* Backing primitives: `db.ts:2495-2545` (`getUserByExternalId` / `getUserByEmail` / `linkSsoIdentity` / `createSsoUser`), replay guard table `db.ts:329` (`saml_seen_responses`).

Two compounding risks:
1. **"Admin account" becomes uncountable.** Under custom roles the guard must be *"the target holds any permission above the auto-provision default role"* — a permission-set superset test, not `role === "admin"`. A custom "Compliance Manager" role holding `user:manage` would become silently email-linkable. This is the most likely security regression in the entire migration.
2. **The login flow is not in this repo.** `src/lib/sso-config.ts:1-4` — *"the login flow itself is implemented in the enterprise overlay (`/api/ee/sso/*`)"*, and `getUserByEmail`/`createSsoUser`/`linkSsoIdentity` have **zero call sites in core** (verified by repo-wide grep). Per CLAUDE.md the `ee/` overlay ships from a separate repo. So the hardening logic cannot be refactored atomically with core, and core's compile errors will not surface the overlay's breakage. Requires a versioned contract in `src/ee-contract.ts` plus a coordinated two-repo release, and the enterprise image build must be pinned to a core version that matches.

Also persisted: `sso_default_role` / SAML default role — `sso-config.ts:24` (`const ROLES: Role[] = [...]`) with `ROLES.includes(role as Role) ? role : "viewer"` fallback. Those are role **strings in the settings table**, written by admins and by SCIM.

### R10. Change-request space-scoping is a *two*-space invariant [6]
`src/app/api/change-requests/[id]/route.ts:32-46` checks `scopeAllows(scope, crDoc.space_id)` **and** the move-on-approve target `cr.space_id` (schema at `db.ts:475`), 404 not 403, with the reasoning in-comment. `CHANGELOG.md:758-761` records this as a security fix. A naive `can(user, "change_request:decide", cr)` that resolves scope from the CR's *current* document space reopens the exact hole that was closed. Encode the target-space check as part of the permission's resource resolution, and keep the 404 (not 403) response — the 403 leaks existence of private-space CRs.

---

## S2 — MAJOR

### R11. Data migration: the additive idempotent idiom, and its two traps [2]
The idiom is precise and must be followed exactly:
- `initialize()` (`db.ts:104-127`) takes advisory lock `728341`, runs `SCHEMA_SQL` (pure `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), then ordered one-shot migrations, then `seedIfEmpty` / `bootstrapAuth`.
- One-shot data migrations use a **settings sentinel**: `migrateVisibilityTiers` (`db.ts:1066-1073`) — `SELECT 1 FROM settings WHERE key='migrated_visibility_tiers'` → early return; do work; `INSERT ... ON CONFLICT (key) DO NOTHING`. `migrateSecuritySealing` (`db.ts:1082-1109`) shows the variant where part is idempotent-by-predicate (`isSealed`) and part is sentinel-guarded.

Add `migrateRbacV1(client)` after `migrateWeightedSearch`, sentinel `migrated_rbac_v1` (version the key — never reuse it, or a rollback+roll-forward silently skips the backfill).

**Trap A — the advisory lock serializes every cold start.** A backfill sized O(users × spaces) runs inside lock `728341` and blocks every other instance's boot → rolling-deploy startup timeouts and an effective outage. Keep the backfill O(existing grant rows): `space_groups` → `space.reader` assignments, `space_editors`/`space_editor_groups` → `space.author`, `users.role` → one global assignment per user, `users.newsletter_role` → newsletter assignments, `settings.section_access_<s>` JSON → section-scoped assignments, `userLeadGroups` → group-scoped `training.lead`. That is thousands of rows, not millions.

**Trap B — default-open semantics must not be materialized.** `editors_edit_all` defaults **on** (`access.ts:39-41`) and a space with **zero** edit grants is *unrestricted* (`db.ts:3112-3115`). Exploding these into explicit rows is both the O(users × spaces) blowup and semantically wrong (spaces created *after* the migration would get no grants and lock everyone out). Instead preserve them as first-class model concepts: an org-level implicit-grant rule for `editors_edit_all`, and a per-space `authoring_unrestricted` boolean derived at migration time from "has no edit grants". Otherwise the migration silently locks out every editor on every space.

**Trap C — section grants have no FK integrity.** `section-access.ts:43` reads `section_access_<section>` JSON; the `ids()` coercion at `:38-39` silently drops garbage, so deleted users/groups linger as stale ids. The backfill must filter dangling ids against `users`/`groups`, and must not fail the whole migration on malformed JSON (match the current silent-degrade-to-no-grants behavior).

**No-downtime sequencing** (rolling deploys run old and new images simultaneously):
1. Ship tables + backfill; `users.role` remains authoritative; nothing reads the new tables.
2. Dual-write: every role/grant mutation writes both old and new.
3. Flip reads to the new engine behind an `rbac_enabled` setting; old columns still written.
4. Only after a full deprecation window, stop writing legacy. **Never drop `users.role`** (see R13).

### R12. Enforcement completeness — make a missed check fail closed [3]
There is **no unit test runner**: `package.json:6-11` has only `next lint` and `playwright test`. So the mechanism must be a lint rule and/or a CI node script, not a jest suite.

Proposed, in increasing strength:
1. **Manifest test** — enumerate `src/app/api/**/route.ts`, assert every exported HTTP method is produced by the wrapper HOF. Cheap, catches new routes.
2. **Wrapper HOF, not a bare guard.** Keep `apiGuard`'s `SessionUser | NextResponse` shape (186 + 209 sites make changing it a blocker per the map) and add `withPermission(perm, handler)` alongside, so both coexist during migration. Do **not** change `apiGuard`'s return type.
3. **Runtime fail-closed tripwire (the real answer).** Put an `AsyncLocalStorage` request context holding an `authorizationAsserted` flag. Every `can()`/`spaceScopeFor()` sets it. The wrapper checks it after the handler resolves: **not set ⇒ discard the response, return 500**. A forgotten check then fails loudly in dev/CI (the e2e suite would catch it) instead of returning data. Combine with R3's branded `SpaceScope` so the *data* layer can't be called unscoped either.
4. Ban raw `getCurrentUser()` in `src/app/api/**` via lint; require it to flow through a guard.

**Non-browser surfaces that will be missed if you only fix `apiGuard`:**
- **API v1** (`src/lib/v1-auth.ts:24`) performs *zero* role/space checks by design (`v1-auth.ts:4-6`); all 4 route trees (`api/v1/{documents,me,search,spaces}`) hand-roll `roleAtLeast` + `spaceScopeFor` + `canEditSpace` + `getApprovalMode` (`v1/documents/route.ts:30,63,81,84,94`). Different narrowing idiom too — `user instanceof NextResponse`, 8 sites, not `gate`.
- **MCP** (`src/app/api/mcp/route.ts:912` `authenticate()`) accepts both `cdk_` and `cdo_` tokens, returns a bare `User`, and re-implements checks at `:355,485,505,579,590,614,723,796`. Credit where due: MCP *does* pre-check `scopeAllows` before `canEditSpace` at `:477/576/588/720` — it is currently safer than the share route.
- **Share links** (`src/lib/shares.ts`, `(public)/share/[token]/page.tsx`) — no principal at all; `attachments/[id]/route.ts:44-50` grants anonymous attachment reads scoped to exactly that doc.
- **Public site** (`(public)/public/layout.tsx:28` `notFound()`) and anonymous search (`public-site.ts:38-39`, 30/min per IP, 300/min global) — hand-written `visibility='public' AND status='published'` SQL. **Recommendation: explicitly declare these out of scope for RBAC v1.** Introducing an "anonymous principal" means porting hand-written SQL, and the layout `notFound()` master switch is a single enforcement point with no defense in depth. Document the exclusion; don't half-migrate it.
- **SCIM** (`src/lib/scim.ts`, `api/scim`) writes `users.role` via a token-authed path outside every guard.

### R13. Backwards compatibility: what is a public contract [4]
Must not change:
- **Token scopes.** `API_TOKEN_SCOPES = ["read","write"] as const` (`db.ts:2707`), persisted as `jsonb NOT NULL DEFAULT '["read","write"]'` (`db.ts:390-391`, with the comment that pre-scope tokens keep full read+write). `v1Auth(req, need)` takes `"read"|"write"` (`v1-auth.ts:24`). **MCP hard-requires `write` up front** (`mcp/route.ts:~923`, "This token is read-only. The Claude connector needs a read + write token."). Keep `read`/`write` as the **wire vocabulary** and map them internally to permission sets. If you ever add per-resource scopes, decide explicitly whether scopes *intersect* the owner's permissions or replace them — the current guarantee (`v1-auth.ts:4-6`, "a token can never see or do more than its user") is one-directional and must remain an intersection.
- **`role` in API responses.** `api/v1/me/route.ts:15` returns `role: user.role`. A custom role name appearing there breaks consumers parsing the four literals. Keep emitting a legacy-compatible rung (nearest **lower** ladder rung) and add a separate `roles`/`permissions` field.
- **Error strings** are effectively contract: `v1/documents/route.ts:64` "Creating documents needs the editor role.", `api-auth.ts:70` "You don't have permission for that.", the three v1 statuses (401/429/403, `v1-auth.ts:32-37`).
- **Persisted role strings** beyond `users.role`: `sso_default_role`, SAML default role (`sso-config.ts:24`), admin API request bodies validated by `ROLE_ORDER.includes` (`admin/users/route.ts:34`, `admin/users/[id]/route.ts:71`), and the e2e helper's role union (`e2e/helpers.ts:38`).
- **`SessionUser`'s 12 fields** (`types.ts:68-85`) — `newsletter_role` is narrowed to a 3-value union at `:77` while `User.newsletter_role` is a bare string (`:51`); the coercion at `auth.ts:78-81` is the only thing keeping them consistent.
- **`NavCapabilities` / `CapKey`** (`nav-capabilities.ts:18-28`, `nav-items.ts:24-32`) — the 8 boolean names are consumed by the `NAV_ITEMS` and `PALETTE_COMMANDS` config tables. **Regenerate them from the permission set; do not rename them.** `allowedCommandIds` (`nav-capabilities.ts:70-73`) is a real security boundary, not cosmetics.

### R14. Performance and where caching is safe [5]
Current per-request cost: 58 `spaceScopeFor(` sites, 30 `canEditSpace(` sites (each hitting `editorsEditAll()` = a settings read, plus possibly `spaceEditGrantAllows` at `db.ts:3117`), and `navCapabilities` fanning out 4 parallel subsystem queries on **every page render** (`nav-capabilities.ts:42-48`). `accessibleSpaceIdsFor` (`db.ts:3153-3162`) is a UNION over `spaces` ∪ (`space_groups` ⋈ `group_members`) per request. `getCurrentUser` also *writes* (session touch, throttled 60s — `auth.ts:31,102-104`).

**Safe:** request-scoped memoization (React `cache()` / `AsyncLocalStorage`) of `spaceScopeFor`, `editorsEditAll`, `getSetting`, and a single `effectivePermissions(userId)` resolution. A request is already a consistent snapshot; this is pure win and removes the `navCapabilities` fan-out.

**Dangerous:**
- **Permissions on the session.** Today revocation is immediate: every check is a live DB read, and `getSessionUser` re-reads the user row each request with `u.status = 'active'` enforced in the same SQL (`db.ts:5814-5828`). Caching permissions on the session row or cookie destroys that property. `nav-capabilities.ts:3-7` explicitly documents that grants are deliberately *not* on the session.
- **Cross-request / module-scope caches.** There is no shared cache infrastructure in this codebase — `rate-limit.ts` is per-instance in-memory (which is why the v1 limit is per-pod). A TTL cache therefore makes revocation eventually-consistent with no invalidation channel, and stale windows multiply by instance count. If you must, cache only the *policy* (role→permission definitions, invalidated by a `settings` version counter read cheaply) and never the *assignments*.
- Measure first. A permission-set model resolved once per request should be faster than 4+ fan-out queries, but only if it doesn't re-introduce staleness.

### R15. Newsletter is the parallel model that proves the ladder was insufficient — and it runs on the client [1,3]
`src/lib/newsletter-access.ts` has 10 exported predicates mixing an admin override, `users.newsletter_role`, authorship, a per-newsletter approver override list, and a status state machine (`:13,18,23,29,38,46,52,57,62,68,78`). It is the natural first absorption candidate. **But it is the only auth module without `import "server-only"`** (contrast `access.ts:6`, `section-access.ts:8`, `v1-auth.ts:8`, `nav-capabilities.ts:1`), and its predicates are **synchronous**. If RBAC checks become async DB lookups, every client-side call site breaks. Either keep a synchronous client-evaluable capability struct (the `api/newsletter/[id]/route.ts:57` capability block is already the right shape) or accept a component-level refactor.

---

## S3 — MODERATE

- **R16 [3].** `sectionApiGuard` (`api-auth.ts:80`) bypasses the role ladder entirely — a **viewer** holding a section grant qualifies (`section-access.ts:59-63`). 21 call sites. Sections are the existing proof that grants ≠ rungs; model them as scoped assignments, not as a role floor. Note the dynamic `await import("./section-access")` at `api-auth.ts:87` — preserve or deliberately remove.
- **R17 [3].** Undeclared mechanism: **group leadership**. `api/training/team/route.ts:22` — `userLeadGroups(user.id)` empty ⇒ 403. No role, no section grant. Easy to lose entirely; there is no other reference to it in the guard layer.
- **R18 [3].** Ownership enforced *inside the query*: `getMyTrainingAssignment(id, user.id)` (`api/training/assignments/[id]/route.ts:34`) is the whole gate. A refactor that "adds a proper permission check" and relaxes the query loses it. Same class: `/api/account/*` (~14 self-scoped routes), comment self-delete (`api/comments/[id]/route.ts:24-26`), self-delete guard (`admin/users/[id]/route.ts:116`).
- **R19 [3,4].** Existing inconsistency the migration will surface: `showTraining` is gated **only** by `featureEnabled("training")` (`nav-capabilities.ts:46`) while announcements/compliance call `canAccessSection` (`:44-45`) — even though `training` is a declared `Section` (`section-access.ts:12`) and every `/api/training/*` admin route enforces `sectionApiGuard("training")`. Nav is under-restrictive relative to the API. Resolve deliberately; don't mechanically preserve.
- **R20 [3,6].** Entitlement composes with, not replaces, permission: `featureEnabled` requires **both** code presence and a license grant (`src/lib/ee.ts:24-27`). RBAC must be `permission AND entitlement` — e.g. `api/documents/[id]/ack/route.ts:18` returns **402**, a third denial status alongside 401/403/404. Three denial vocabularies (redirect / 403 JSON / 402 / 404-hide) must survive.
- **R21 [3,6].** Keep `crossOriginRejection()` **first** in any replacement guard — `apiGuard` runs it before resolving the user (`api-auth.ts:65-67`), and it passes requests with no `Origin` (curl, server-to-server) by design (`:33-43`), so it is browser-only CSRF defense. Moving any mutation from `/api/v1` (token, CSRF-immune) to `/api` (cookie) inherits the weaker property.
- **R22 [4].** `apiGuard()` defaults to `min = "viewer"` (`api-auth.ts:64`) — used bare at ~10 sites meaning "any authenticated active user". A permission model has no "default least privilege" value; give it an explicit name (`requireAuthenticated()`) rather than defaulting a permission argument. `requireRole` has no default (`auth.ts:116`) — keep it that way.

---

## S4 — ROLLBACK STORY [7]

Rollback is image-redeploy (`RELEASING.md` §1-2: version bump in both package files → squash-merge → docker-publish → release.yml → enterprise image). Three specific hazards:

1. **Forward-compat is free in phases 1-3, lethal in phase 4.** Old images ignore new tables, and `SCHEMA_SQL` is purely additive, so a downgrade boots fine — *provided `users.role` is still authoritative*. The instant writes go new-only, rollback loses every assignment made post-cutover and users silently revert to a stale `users.role`.
2. **Compat write-back, flooring never ceiling.** For the entire deprecation window, project each user's effective permission set onto the nearest legacy rung and write it to `users.role`. Map to the **lowest** rung whose permissions are a superset-free match; an unmappable custom role writes `viewer` plus an admin-visible warning. Rounding *up* on rollback is privilege escalation; rounding down is a support ticket.
3. **Sentinel keys are one-way.** `migrateRbacV1` will not re-run after a rollback + roll-forward (`db.ts:1067-1072` pattern). Version the key and, if you ever need to re-backfill, ship `migrateRbacV2` rather than deleting the settings row.

Additionally:
- **Kill switch:** an `rbac_enabled` setting read by the guard so a bad policy is disabled without a redeploy. It must fall back to the legacy ladder (which still works, because `users.role` is still written) and it must fail **closed** if the setting is unreadable. It is a permanent authorization branch — put a removal date in the changelog.
- **You cannot currently test a rollback.** There are 10 Playwright specs (`e2e/`), none of which is a role matrix; `approvals.spec.ts` and `api-v1.spec.ts` are the closest. **Before touching any guard**, add a matrix spec: {viewer, editor, approver, admin} × {~25 representative endpoints incl. `/api/v1/*`, MCP tools, share create, CR decide, trash purge}, asserting **exact status codes** (403 vs 404 vs 402 vs redirect — the asymmetry is deliberate and load-bearing). That spec is the golden test in both directions and the only credible rollback gate. `e2e/helpers.ts:34-38` already has `ensureUser(page, user, role, name)` to build it on.

---

## Recommended sequencing (each step independently shippable and revertible)

1. Fix R1 (share + trash scope pre-checks). Ship.
2. Add the role-matrix e2e spec (R7 of rollback). Ship.
3. R3: brand `SpaceScope`, make scope required across the 21 signatures. Pure refactor, no behavior change, removes the biggest fail-open surface. Ship.
4. Collapse `ROLE_ORDER`/`ROLE_LABEL`/`ROLE_BLURB` into one role registry with an explicit `rank`, fix `db.ts:2492`'s lexical sort, split the validation allow-list from the ladder (R5, R7). Ship.
5. Introduce `withPermission` + the `AsyncLocalStorage` fail-closed tripwire (R12) alongside the existing `apiGuard`, migrating a handful of routes. Ship.
6. Tables + backfill (R11) behind `rbac_enabled=0`, dual-write. Ship.
7. Flip reads per-surface: session API → v1 → MCP. Coordinate the EE overlay for R9 **before** the flip.
8. Deprecation window with compat write-back, then remove.