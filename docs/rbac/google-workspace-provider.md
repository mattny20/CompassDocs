I read the identity stack directly. Design below, grounded in the real signatures.

---

# Provider abstraction for identity provisioning: making Google Workspace a peer of Microsoft

## 0. What the Microsoft stack actually is today

Four largely independent subsystems, all EE-entitlement-gated, all with their **config in core** and their **execution in the `ee/` overlay**:

| Subsystem | Entitlement | Config module (core) | Execution |
|---|---|---|---|
| OIDC SSO | `sso` | `src/lib/sso-config.ts` | `/api/ee/sso/*` |
| SAML SSO | `sso` | `src/lib/saml-config.ts` | `/api/ee/saml/*` |
| SCIM inbound | `scim` | `src/lib/scim.ts` | **core** `src/app/api/scim/v2/*` |
| Graph people sync | `directory_sync` | `src/lib/directory-config.ts` | `/api/ee/directory/sync` |
| Entra group sync | `directory_sync` | *(reuses directory-config)* | `/api/ee/directory/groups{,/import,/sync}` |

SCIM is the odd one out — it lives in core and is gated at runtime by `scimGuard`, not by build.

---

## 1. The seams, with current signatures

### Seam A — the people-sync write path (highest value)

`src/lib/directory.ts:454-508`:

```ts
export interface GraphPersonInput extends PersonInput {
  external_id: string;
}
export async function replaceGraphPeople(people: GraphPersonInput[]): Promise<number>
```

Two provider assumptions are baked into its body:

```sql
VALUES ('graph', $1, $2, ...)                                    -- hardcoded source
DELETE FROM directory_people
 WHERE source = 'graph' AND NOT (external_id = ANY($1::text[]))  -- hardcoded source
```

If Google reused this, each provider's sync would delete the other's rows. **Extract to:**

```ts
export type PersonSource = "graph" | "google";
export interface ProviderPersonInput extends PersonInput { external_id: string }
export async function replaceProviderPeople(
  source: PersonSource,
  people: ProviderPersonInput[],
  opts?: { maxDeleteFraction?: number }   // deletion safety valve — see §6
): Promise<{ upserted: number; deleted: number; abortedDelete?: string }>
```

Keep `replaceGraphPeople` as a one-line shim (`replaceProviderPeople("graph", people)`) so the EE overlay's Microsoft sync doesn't need a coordinated release. Note also the schema comment at `src/lib/db.ts:618` and the `source` column default still describe only manual/graph — widen the comment and the `DirectoryPerson.source` union at `src/lib/directory.ts:17`:

```ts
source: "manual" | "graph";   // → "manual" | "graph" | "google"
```

### Seam B — the custom-field mapping column

`src/lib/directory.ts:34-43`:

```ts
export interface DirectoryField {
  id: number; key: string; label: string;
  graph_path: string;        // "" = manual-only field
  show_in_card: number; sort: number;
  display: "field" | "tag";
}
export async function createField(input: {
  key?: string; label: string; graph_path?: string;
  show_in_card?: boolean; display?: "field" | "tag";
}): Promise<DirectoryField>
export async function updateField(id: number, fields: {
  label?: string; graph_path?: string; show_in_card?: boolean;
  sort?: number; display?: "field" | "tag";
}): Promise<DirectoryField | undefined>
```

`graph_path` is a Microsoft-shaped property path (`onPremisesExtensionAttributes.extensionAttribute1`). Google paths are structurally different (`customSchemas.HR.employee_id`, `organizations[primary].costCenter`). **Do not rename** — the column is in the DirectorySettings API contract and the print-columns validator. Add a sibling:

```sql
ALTER TABLE directory_fields ADD COLUMN IF NOT EXISTS google_path text NOT NULL DEFAULT '';
```

and widen the two functions with `google_path?: string`. The provider interface exposes which column it reads (`fieldPathColumn`), so the mapper UI renders one input per *configured* provider rather than one generic input that means different things.

### Seam C — group source

`src/lib/db.ts:2918-2949`:

```ts
export interface Group {
  id: number; name: string;
  source: string;              // "manual" | "entra"
  external_id: string | null;
  created_at: string; last_synced_at: string | null;
}
export async function createGroup(input: {
  name: string; source?: string; externalId?: string | null;
}): Promise<Group>
export async function setGroupMembers(groupId: number, userIds: number[]): Promise<void>
```

`createGroup`/`setGroupMembers` are already provider-neutral — `setGroupMembers` takes a flat `userIds` array, which is exactly what a flattened Google membership resolves to. The only real work is:
- widen the `source` comment to `"manual" | "entra" | "google"`;
- `CREATE UNIQUE INDEX idx_groups_external ON groups(external_id) WHERE external_id IS NOT NULL` (`db.ts:305`) is **global, not per-source**. Entra GUIDs and Google numeric group ids won't collide in practice, but the index makes "the same group in two providers" unrepresentable. Recommend `DROP` + recreate as `(source, external_id)`, with a migration that is safe because today every non-null row is `source='entra'`;
- the rename guard at `src/app/api/admin/groups/[id]/route.ts:49` already reads `if (group.source !== "manual")`, which generalizes for free.

### Seam D — the SSO authority

`src/lib/sso-config.ts:49-53`:

```ts
export function ssoAuthority(cfg: Pick<SsoConfig, "authority" | "tenant">): string {
  if (cfg.authority) return cfg.authority.replace(/\/+$/, "");
  if (!cfg.tenant) return "";
  return `https://login.microsoftonline.com/${cfg.tenant}/v2.0`;
}
```

Google OIDC already works today by pasting `https://accounts.google.com` into the `authority` override — but the field is labelled "Advanced" and the panel is Microsoft-shaped. Introduce a discriminator rather than more string-sniffing:

```ts
export type SsoVendor = "microsoft" | "google" | "generic";
// new setting key: sso_vendor
export function ssoAuthority(cfg: Pick<SsoConfig, "authority"|"tenant"|"vendor">): string {
  if (cfg.authority) return cfg.authority.replace(/\/+$/, "");
  if (cfg.vendor === "google") return "https://accounts.google.com";
  if (!cfg.tenant) return "";
  return `https://login.microsoftonline.com/${cfg.tenant}/v2.0`;
}
```

Default `vendor` to `"microsoft"` when the key is absent, so existing installs are unchanged.

### Seam E — provider-scoped identity lookup

`src/lib/db.ts:2495-2560`:

```ts
export async function getUserByExternalId(provider: string, externalId: string): Promise<User | undefined>
export async function linkSsoIdentity(userId: number, provider: string, externalId: string): Promise<void>
export async function createSsoUser(input: {
  username: string; name: string; email: string; role: Role;
  provider: string; externalId: string;
}): Promise<User>
export async function getUserByAnyExternalId(externalId: string): Promise<User | undefined>
```

`getUserByExternalId` is correctly provider-scoped. Two problems:

1. **`getUserByAnyExternalId` ignores `auth_provider`** and is used by the SCIM `POST /Users` uniqueness check (`Users/route.ts:78`) and the `externalId` filter (`:38`). Once two providers can write `external_id`, "any" is the wrong scope for a uniqueness assertion.
2. **Its doc comment is wrong.** `db.ts:2554-2559`:
   ```ts
   /** Case-insensitive lookup by external id (SCIM clients vary the casing). */
   ...`SELECT ${USER_COLUMNS} FROM users WHERE external_id = $1 ORDER BY id LIMIT 1`
   ```
   That is a case-**sensitive** equality. Entra sends lowercase GUIDs consistently so it has never bitten; Google ids are digits so it won't bite there either — but the comment promises a behaviour the code doesn't have. Either add `lower(external_id) = lower($1)` or fix the comment; do it in the same PR so nobody relies on the comment when adding Google.

3. **`scimCreateUser` hardcodes the provider** (`db.ts:2564-2578`):
   ```ts
   `INSERT INTO users (username, email, name, role, status, auth_provider, external_id)
    VALUES ($1,$2,$3,'viewer',$4,'oidc',$5) RETURNING id`
   ```
   `'oidc'` is a *protocol*, not a provider, so a Google-OIDC user and an Entra-SCIM user land on the same `auth_provider` and `getUserByExternalId("oidc", …)` can cross-match. Add `authProvider?: string` to the input (default `'oidc'` for back-compat) and have the SCIM route pass the configured vendor.

### Seam F — the EE dispatcher and the admin route namespace

`src/ee-contract.ts:20`:

```ts
dispatch?(method: string, slug: string[], req: Request): Promise<Response>;
```

Already provider-neutral. Google's endpoints slot in as `/api/ee/google/{sync,groups,groups/import,groups/sync,probe}`.

The **core** admin route, however, is namespaced by vendor: `src/app/api/admin/directory/graph/route.ts`, with `GET`/`PATCH` handlers whose `view()` returns `{ tenant, client_id, has_secret, secret_expires, group, include_guests, … }`. Rather than generalize this (which breaks `DirectorySettings.tsx`'s `refreshUrl`), add a sibling `src/app/api/admin/directory/google/route.ts` with the identical `apiGuard("admin")` + `featureEnabled("directory_sync")` shape and a Google-shaped view. Two small vendor-specific config routes beat one union-typed one.

### Seam G — the SCIM Groups stub message

`src/app/api/scim/v2/Groups/route.ts` returns a 501 whose text names Entra:

```ts
"Group provisioning is not supported over SCIM — use Entra group sync (Settings → Groups)."
```

Generalize to "…use directory group sync (Settings → Groups)". Cosmetic, but a Google customer probing `/Groups` gets a nonsense pointer today. (Google's SCIM client, if a customer configures one via the Workspace "Automated user provisioning" app, also only pushes Users — so the stub stays correct in substance.)

### Seam H — sealed settings

`src/lib/db.ts:2424-2439` — `SENSITIVE_SETTINGS` must gain the Google key (see §2.4).

### Seam I — the setup wizard

`src/components/MsDeviceSetup.tsx` is generic in mechanism (`startUrl` / `pollUrl` / `refreshUrl` / `blurb` / `doneMessage` / `onDone`) but Microsoft in name and in the copy it hardcodes ("signing in as a tenant admin", "microsoft.com/devicelogin" via `data.verification_uri`). Google **has no device-code equivalent for domain-wide delegation** (§2.5), so don't try to reuse it — Google gets a static checklist + JSON paste panel.

---

## 2. Google Workspace specifics

### 2.1 The interface

```ts
// src/lib/identity-provider.ts  (core — types only, no network code)
import "server-only";

export type ProviderKey = "microsoft" | "google";

export interface ProviderPerson {
  external_id: string;          // immutable provider id
  name: string;
  title: string;
  department: string;
  email: string;                // current primary address
  phone: string;
  mobile: string;
  office: string;
  photo?: string;               // data: URL, or omitted to keep the stored one
  photo_etag?: string;          // cheap change check; skip refetch when unchanged
  custom: Record<string, string>;
  suspended: boolean;           // provider says the account is inactive
}

export interface ProviderGroup {
  external_id: string;
  name: string;
  email: string;                // "" for providers without mail-enabled groups
  description: string;
  member_count: number | null;  // null = provider didn't report it
  nested: boolean;              // contains at least one group member
}

export interface ProviderMember {
  /** Provider user id when the member is a real user account. */
  external_id: string | null;
  email: string;
  kind: "user" | "group" | "external" | "everyone";
  suspended: boolean;
}

export interface ProviderProbe {
  ok: boolean;
  detail: string;               // admin-facing; never contains secret material
  /** Scopes the provider reports as actually granted, when discoverable. */
  scopes?: string[];
}

export interface IdentityProvider {
  readonly key: ProviderKey;
  readonly label: string;                       // "Microsoft 365" | "Google Workspace"
  readonly personSource: "graph" | "google";    // directory_people.source
  readonly groupSource: "entra" | "google";     // groups.source
  readonly fieldPathColumn: "graph_path" | "google_path";

  /** Enough config stored to attempt a call. Never performs I/O. */
  configured(): Promise<boolean>;

  /** One cheap authenticated call; the "Test connection" button. */
  probe(): Promise<ProviderProbe>;

  /** Full people enumeration. Must complete every page or throw. */
  listPeople(opts: {
    scopeGroupId?: string;      // limit to one group's members
    includeGuests: boolean;
    requireTitle: boolean;
    requirePhone: boolean;
    photos: boolean;
    fieldMap: { key: string; path: string }[];  // from directory_fields
    knownPhotoEtags?: Record<string, string>;
  }): Promise<ProviderPerson[]>;

  listGroups(): Promise<ProviderGroup[]>;

  /** Flattened: nested groups resolved, cycles broken, users only. */
  listGroupMembers(externalId: string): Promise<ProviderMember[]>;

  /** Datalist suggestions for the custom-field mapper UI. */
  fieldPathSuggestions(): string[];

  /** Incremental change detection, when the provider supports it. */
  changedSince?(cursor: string): Promise<
    { userIds: string[]; groupIds: string[]; cursor: string } | null
  >;
}
```

`providerFor(key: ProviderKey): IdentityProvider | null` lives in the EE overlay and is reached through a new optional method on `EnterpriseEdition`:

```ts
// src/ee-contract.ts
identityProvider?(key: ProviderKey): IdentityProvider | null;
```

Core never imports Google client code; it only ever holds the interface and the config.

### 2.2 Admin SDK Directory API endpoints

Base: `https://admin.googleapis.com/admin/directory/v1`

**Users**
```
GET /users
  ?customer=my_customer            # literal string; resolves to the caller's account
  &maxResults=500                  # hard max is 500
  &projection=full                 # required to receive customSchemas
  &orderBy=email
  &pageToken=<nextPageToken>
  &showDeleted=false
  &query=orgUnitPath='/Sales'      # optional, for org-unit scoping
GET /users/{userKey}               # userKey = primary email | alias | immutable id
GET /users/{userKey}/photos/thumbnail
```
`users.list` returns `{ kind, etag, users: [...], nextPageToken }`. Iterate until `nextPageToken` is absent.

`photos/thumbnail` returns `{ photoData, mimeType, width, height, id, primaryEmail, etag }`. **`photoData` is web-safe base64** — convert `-`→`+`, `_`→`/` and re-pad before building the `data:` URL that `directory_people.photo` expects. It **404s** when the user has no photo; treat that as "no photo", not an error.

**Groups**
```
GET /groups?customer=my_customer&maxResults=200&pageToken=…
GET /groups/{groupKey}                        # groupKey = group email | id
GET /groups/{groupKey}/members
  ?maxResults=200
  &includeDerivedMembership=true              # flattens nested groups
  &pageToken=…
GET /groups?userKey={userEmail}               # groups a user belongs to
```
`maxResults` caps at **200** for both `groups.list` and `members.list` (vs 500 for users).

Member objects: `{ id, email, role: "OWNER"|"MANAGER"|"MEMBER", type: "USER"|"GROUP"|"CUSTOMER"|"EXTERNAL", status: "ACTIVE"|"SUSPENDED"|"UNKNOWN" }`.

**Org units / schemas / domains**
```
GET /customer/{customerId}/orgunits?type=all
GET /customer/{customerId}/schemas             # custom schema definitions
GET /customer/{customer}/domains
```
Use `my_customer` as `{customerId}`.

**Optional, for incremental sync**
```
POST /users/watch                              # push channel, requires a verified webhook domain
POST /groups/watch
```
and the Reports API: `GET https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/admin?startTime=…`

⚠️ **Uncertainty:** `includeDerivedMembership=true` and the `roles=` filter interact — I believe `roles` is not honoured (or is rejected) when derived membership is on. Verify against the live API before relying on role filtering with flattening; the safe implementation ignores `roles` entirely and does its own filtering on the returned objects.

### 2.3 Service account + DWD vs OAuth app — and why DWD wins

**Recommendation: service account with domain-wide delegation, as the primary and default path.**

| | Service account + DWD | Installed OAuth app |
|---|---|---|
| Credential lifetime | Key is long-lived until rotated | Refresh token; revoked when the granting admin leaves, changes password in some cases, or the token goes 6 months unused |
| Identity coupling | Impersonates a nominated admin, swappable in one setting | Bound to whoever clicked Consent |
| Self-hosted fit | Each customer creates their own SA in their own GCP project — nothing shipped in the image | An OSS image cannot ship a client secret; each customer must create their own client anyway, so the "easier onboarding" advantage evaporates |
| Verification | Not applicable — DWD is granted by the customer's own super admin | Public apps using `admin.directory.*` need OAuth verification; avoidable only by setting User Type = **Internal**, which is fine for a single Workspace org |
| Analogue to today | Matches the Microsoft client-credentials app-only flow already in `directory-config.ts` | Would be a new, user-context-shaped path with no Microsoft counterpart |

Support the OAuth-refresh-token path only as an explicit fallback for customers whose security policy forbids DWD. Same `IdentityProvider` implementation, different `accessToken()` — swap the JWT-bearer grant for a `refresh_token` grant.

**The JWT-bearer exchange** (implementable with `node:crypto` alone — no `googleapis` dependency, matching how `saml-config.ts` avoids an XML parser):

```
header  { "alg": "RS256", "typ": "JWT" }
claims  {
  "iss":   "<service-account>@<project>.iam.gserviceaccount.com",
  "sub":   "<impersonated-admin>@customer.com",   // REQUIRED for DWD
  "scope": "<space-separated scopes>",
  "aud":   "https://oauth2.googleapis.com/token",
  "iat":   <now>,
  "exp":   <now + 3600>                            // 1 hour maximum
}

POST https://oauth2.googleapis.com/token
  grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
  &assertion=<signed JWT>
→ { "access_token": "...", "expires_in": 3600, "token_type": "Bearer" }
```

Sign with `crypto.sign("RSA-SHA256", …)` over the SA's PKCS#8 `private_key`. Cache the access token in memory keyed by scope set, refresh at ~T−300s. Route the token request and every API call through `safeFetch` from `src/lib/safe-fetch.ts` so the existing egress-proxy handling applies.

Omitting `sub` yields a token for the service account's own identity, which the Directory API generally rejects for domain data.

⚠️ **Uncertainty:** Google Workspace now supports assigning admin roles *directly to service accounts* in the Admin console, which for some APIs (notably Cloud Identity) removes the need for `sub` impersonation. Whether that covers Admin SDK Directory endpoints has changed over time — I would not build on it. Ship the `sub` path and treat direct role assignment as a possible later simplification.

### 2.4 Exact scopes (least privilege)

**Required — request exactly these five, read-only:**

```
https://www.googleapis.com/auth/admin.directory.user.readonly
https://www.googleapis.com/auth/admin.directory.group.readonly
https://www.googleapis.com/auth/admin.directory.orgunit.readonly
https://www.googleapis.com/auth/admin.directory.userschema.readonly
https://www.googleapis.com/auth/admin.directory.domain.readonly
```

- `admin.directory.user.readonly` — `users.list`, `users.get`, **and `users.photos.get`** (there is no separate photo scope).
- `admin.directory.group.readonly` — `groups.list`, `groups.get`, **and `members.list`**. `admin.directory.group.member.readonly` is therefore **redundant** for a read-only consumer; deliberately do not request it.
- `orgunit.readonly` — only needed if the customer scopes the sync by org unit or maps `orgUnitPath` to a field. Make it optional in the UI.
- `userschema.readonly` — only needed to *enumerate* custom schemas for the field-mapper dropdown. Reading a user's `customSchemas` values works with `user.readonly` + `projection=full`. Also optional.
- `domain.readonly` — only for the "connected to domain X" confirmation in the probe. Optional.

**A truly minimal install needs just two:** `admin.directory.user.readonly` and `admin.directory.group.readonly`.

**Conditionally required:**
```
https://www.googleapis.com/auth/cloud-identity.groups.readonly       # dynamic / security groups
https://www.googleapis.com/auth/admin.reports.audit.readonly         # Reports-based incremental sync
```

**Never request:** `admin.directory.user` (read-write), `admin.directory.group` (read-write), or anything under `/auth/admin.directory.user.security`. CompassDocs is a downstream consumer and must never be able to mutate the customer's directory. Enforce this by keeping the write scopes out of the constant entirely, not just out of the docs.

### 2.5 Storing and encrypting the service-account key

The key is the whole JSON file (~2.3 KB). Store it as one sealed setting; the existing helper handles it with no changes to `secretbox.ts` — `sealSecret`/`openSecret` are size-agnostic AES-256-GCM over a UTF-8 string, and `settings.value` is `text`.

```ts
// src/lib/db.ts — SENSITIVE_SETTINGS (currently db.ts:2424-2439)
const SENSITIVE_SETTINGS = new Set([
  …,
  "directory_graph_client_secret",
  // Google Workspace service-account key (full JSON, contains an RSA private
  // key). Sealed exactly like directory_graph_client_secret; existing plaintext
  // rows auto-seal on next boot via migrateSecuritySealing().
  "directory_google_sa_key",
]);
```

This gets you three things for free:
- `setSetting` seals on write (`db.ts:2447-2448`), `getSetting`/`getAllSettings` unseal on read;
- `migrateSecuritySealing` (`db.ts:1083-1095`) seals any row written before the key was added to the set;
- `openSecret` degrades to `""` on master-key mismatch with a loud log, so a lost `COMPASSDOCS_SECRET_KEY` turns Google sync into "not configured" rather than a crash — matching every other credential.

**Never store the raw JSON in a non-sensitive key, and never echo it back.** Follow the write-only pattern from `directory-config.ts:5` exactly: the `GET` view returns only derived, non-secret facts.

```ts
// src/lib/google-config.ts  (core)
import { getSetting, setSetting } from "./db";

const KEYS = {
  enabled:        "directory_google_enabled",
  customer:       "directory_google_customer",       // "my_customer" or a customer id
  adminEmail:     "directory_google_admin_email",    // the DWD `sub`
  saKey:          "directory_google_sa_key",         // SEALED — full JSON
  authMode:       "directory_google_auth_mode",      // "service_account" | "oauth"
  refreshToken:   "directory_google_refresh_token",  // SEALED — oauth mode only
  group:          "directory_google_group",          // optional scope: group email/id
  orgUnit:        "directory_google_org_unit",       // optional scope: "/Sales"
  includeSuspended: "directory_google_include_suspended",
  requireTitle:   "directory_google_require_title",
  requirePhone:   "directory_google_require_phone",
  photos:         "directory_google_photos",
  useCloudIdentity: "directory_google_cloud_identity",
  lastSync:       "directory_google_last_sync",
} as const;

export interface GoogleDirectoryConfig {
  enabled: boolean;
  customer: string;
  adminEmail: string;
  saKey: string;            // never send to the client
  authMode: "service_account" | "oauth";
  refreshToken: string;     // never send to the client
  group: string;
  orgUnit: string;
  includeSuspended: boolean;
  requireTitle: boolean;
  requirePhone: boolean;
  photos: boolean;
  useCloudIdentity: boolean;
}

/** Non-secret facts derived from the stored key, for the admin panel. */
export interface GoogleKeyFacts {
  client_email: string;     // SA address — needed for the Admin-console step
  client_id: string;        // numeric OAuth client id — pasted into DWD
  project_id: string;
  private_key_id: string;   // for rotation tracking
}
export function googleKeyFacts(saKeyJson: string): GoogleKeyFacts | null;

export function googleConfigured(cfg: GoogleDirectoryConfig): boolean {
  return Boolean(
    cfg.enabled && cfg.adminEmail &&
    (cfg.authMode === "oauth" ? cfg.refreshToken : cfg.saKey)
  );
}

export async function getGoogleDirectoryConfig(): Promise<GoogleDirectoryConfig>;
export async function updateGoogleDirectoryConfig(patch: Partial<GoogleDirectoryConfig>): Promise<void>;
```

`googleKeyFacts` parses the JSON to surface `client_email` / `client_id` — the admin needs `client_id` for the DWD step and it is **not** secret. Parse it once on save; if `JSON.parse` fails or `private_key`/`client_email` are missing, reject the `PATCH` with a clear message rather than storing garbage. Reuse `credentialSaveError` from `src/lib/api-auth.ts:14` so a `MasterKeyError` surfaces as a 500 with the operator-fixable text, exactly like SMTP and SSO saves.

The admin `PATCH` follows `admin/directory/graph/route.ts` precisely:
```ts
...(typeof body?.sa_key === "string" && body.sa_key !== "" ? { saKey: body.sa_key } : {}),
...(body?.clear_key === true ? { saKey: "" } : {}),
```
— an empty string never clobbers a stored key; clearing is an explicit flag.

### 2.6 Admin setup flow (what a customer actually does)

There is **no one-click equivalent to `MsDeviceSetup`** for Google. Microsoft's wizard works because the device-code flow can create the app registration and grant admin consent programmatically. Google's domain-wide delegation must be granted in the Admin console by hand — nothing in the API creates a DWD grant. Ship a numbered checklist with copy buttons instead of pretending otherwise.

**In Google Cloud console (any project the customer controls):**

1. Create or pick a project. Note the project id.
2. **APIs & Services → Library** → enable **Admin SDK API** (`admin.googleapis.com`). If using Cloud Identity groups, also enable **Cloud Identity API** (`cloudidentity.googleapis.com`).
3. **IAM & Admin → Service Accounts → Create service account**. Name it `compassdocs-directory-sync`. **Grant it no project IAM roles** — its power comes entirely from DWD, not from project IAM.
4. Open the service account → **Keys → Add key → Create new key → JSON**. Download it.
5. On the service account's **Details** tab, copy the **Unique ID** (a ~21-digit number). This is the OAuth client ID for step 7.

**In Google Admin console (`admin.google.com`, as a super admin):**

6. **Security → Access and data control → API controls → Domain-wide delegation → Manage domain-wide delegation**.
7. **Add new**. Paste the Unique ID from step 5 as *Client ID*. In *OAuth scopes*, paste the comma-separated list — CompassDocs renders this with a copy button so it can't be mistyped:
   ```
   https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/admin.directory.orgunit.readonly,https://www.googleapis.com/auth/admin.directory.userschema.readonly,https://www.googleapis.com/auth/admin.directory.domain.readonly
   ```
   **Authorize.** Scopes are matched exactly — a missing scope produces `unauthorized_client` at token exchange, not a per-call 403, which is the single most common setup failure.
8. Decide which admin the sync impersonates. Simplest is an existing super admin. Least privilege is a dedicated account (e.g. `compassdocs-sync@customer.com`) with a **custom admin role** carrying only *Users → Read* and *Groups → Read* privileges. Note its address.

**In CompassDocs (Settings → Directory → Google Workspace):**

9. Paste the JSON key file contents. CompassDocs parses it, shows `client_email` / `client_id` / `project_id` read-back so the admin can confirm it matches step 5, and stores it sealed.
10. Enter the impersonated admin address from step 8.
11. Optionally scope the sync: a Google Group address, or an org unit path like `/Staff`.
12. Toggles: exclude suspended accounts (default on), require a job title, require a phone number, sync profile photos (default on).
13. **Test connection** → `probe()` calls `GET /users?customer=my_customer&maxResults=1` plus, when `domain.readonly` was granted, `GET /customer/my_customer/domains`. Reports the domain name and the user count so the admin sees they hit the right tenant. Map the common failures to plain English rather than passing Google's JSON through:
   - `unauthorized_client` → "Domain-wide delegation isn't set up for this service account, or the scope list doesn't match exactly. Re-check step 7."
   - `403 notAuthorized` / `Not Authorized to access this resource/api` → "The impersonated account isn't an admin, or lacks Users → Read."
   - `400 invalid_grant` → "The impersonated address doesn't exist in this Workspace domain, or the key has been deleted."
14. **Sync now** → first full run. Then group import: **Settings → Groups → Google Workspace groups → Browse groups**, pick which to import.

**Rotation:** surface `private_key_id` and the key's age. Google SA keys don't expire by default, so unlike the Entra secret there's no `secret_expires` to show — show "added on <date>" and a rotation nudge past 12 months. Rotation is: create a new key, paste it, verify with Test connection, then delete the old key in Cloud console.

---

## 3. User provisioning semantics

**Important scoping decision, matching Microsoft today:** the Google *directory sync* populates `directory_people` (the people directory), **not** `users`. CompassDocs accounts are created by SSO auto-provisioning (`createSsoUser`) or SCIM push. Google Workspace does have a SCIM-ish "Automated user provisioning" app, but it targets a published Workspace Marketplace listing — a vendor project, not per-customer config. So for v1, Google account provisioning is **JIT-on-first-SSO-login**, exactly as Microsoft OIDC works without SCIM.

### Identity key

```
users.auth_provider = "google"
users.external_id   = the Google `id` — immutable, numeric string, never reused
```

Resolution order on login (mirroring `scim.ts:12-15`'s documented order):
1. `getUserByExternalId("google", sub)` — the OIDC `sub` **is** the Directory `id`;
2. `getUserByEmail(email)` where the token's `email_verified` is true and the domain is in `allowedDomains` → `linkSsoIdentity(user.id, "google", sub)`;
3. if `autoProvision`, `createSsoUser({ provider: "google", externalId: sub, role: defaultRole, … })`.

Never match on email alone without `email_verified` — with `hd` (hosted domain) absent, a consumer Gmail account could otherwise claim a corporate address.

### Create
`username` ← `primaryEmail` (matching SCIM's `userName ?? email` fallback at `Users/route.ts:85`). `name` ← `name.fullName`. `role` ← `sso_default_role`, default `viewer`. `status` ← `active` unless the Google user is `suspended`.

### Update
Sync `name` and `email` from the provider on every login. **Do not sync `role`** — CompassDocs roles are assigned in CompassDocs, or derived from group membership (§4). This preserves the current invariant that `toSessionUser` passes `role` through unvalidated (`auth.ts:74`) because only trusted paths write it.

### Suspend
Google `suspended: true` (or `archived: true`) → `status = "disabled"`. Do the same thing SCIM does at `Users/[id]/route.ts:67-76`:

```ts
if (nextStatus === "disabled" && user.status === "active") {
  await deleteUserSessions(user.id);   // deactivation takes effect immediately
  await audit({ action: "google.user_disable", … });
}
```

This matters because `getSessionUser`'s SQL already requires `u.status = 'active'` (`db.ts:5822-5823`), so an un-killed session dies on the next request anyway — but killing it explicitly closes the window and produces the audit entry.

### Delete
**Never hard-delete.** Adopt SCIM's stated rationale verbatim (`Users/[id]/route.ts:127-131`): "document authorship, comments, versions, and audit history keep their author." A user deleted in Google → `status = "disabled"` + sessions killed + audit entry. Only an admin using Settings → Users can hard-delete, and that path already has the last-admin and self-delete guards at `admin/users/[id]/route.ts:78,116,119`.

Detect deletion by absence from a *complete, successful* full enumeration — never from a partial page (see §6's safety valve). `users.list?showDeleted=true` corroborates, but Google only retains deleted users for ~20 days, so absence is the primary signal and `showDeleted` is a confirmation, not a substitute.

### Rename
Display-name change (`name.givenName` / `familyName` / `fullName`): update `users.name` and `directory_people.name`. No side effects — `external_id` is the key everywhere.

**One real consequence to flag:** `resolveAuthorPerson` (`directory.ts:352-365`) resolves document bylines by `lower(u.name) = lower($1)`. Renaming a user therefore breaks byline→profile resolution for documents authored under the old name — the linked-account path survives only for users already linked via `directory_person_id`. This is a pre-existing Microsoft-path bug, not a Google one, but it becomes visible more often since Workspace name changes are self-service in some configurations. Worth a follow-up.

### Email change
Google renames preserve the old address as an **alias**. So:
- `users.external_id` is unchanged → identity survives cleanly, which is the whole reason to key on `id`.
- Update `users.email`, `users.username`, and `directory_people.email`.
- `username` collision: `scimUpdateUser` has no uniqueness check (`db.ts:2583-2606`), and the SCIM route checks it in the route body instead (`Users/[id]/route.ts:49-54`). Replicate that check in the Google path — or better, push it into `scimUpdateUser` so both callers get it.
- **`autoLinkUsersToDirectory`** (`db.ts:3186-3199`) matches on `u.external_id = p.external_id` **first**, then `lower(u.email) = lower(p.email)`. Since the Google directory sync writes the same `id` into `directory_people.external_id` that SSO writes into `users.external_id`, the link survives an email change automatically. This is a genuine advantage over the email-only path and worth preserving deliberately.

### Avoiding orphaned content
Four guarantees, all of which the current design already gets right and Google must not break:

1. Soft-delete only — `status = 'disabled'`, row retained.
2. `external_id` is the join key, never email — an email change never orphans.
3. `directory_person_id` is `ON DELETE SET NULL` (`db.ts:676`), and `autoLinkUsersToDirectory` is idempotent and never relinks, so a directory row vanishing degrades to "unlinked" and is restored on the next sync rather than cascading.
4. **New requirement for Google:** because `replaceProviderPeople` hard-deletes vanished provider rows, a full-sync failure that returns a short list would null out `directory_person_id` across the workspace. The deletion safety valve in §6 is not optional.

---

## 4. Group provisioning

### Google Groups vs Cloud Identity groups

Two APIs over an overlapping data model:

| | Directory API `groups` | Cloud Identity API `groups` |
|---|---|---|
| Resource name | numeric `id`, `email` | `groups/{id}`, `groupKey.id` = email |
| Covers | mail-enabled Google Groups | Google Groups **plus** security groups, dynamic groups, externally-mapped groups |
| Flattening | `members.list?includeDerivedMembership=true` | `memberships.searchTransitiveMemberships` |
| Dynamic groups | not represented | `dynamicGroupMetadata` with a CEL query |
| Labels | none | `cloudidentity.googleapis.com/groups.discussion_forum`, `…/groups.security` |
| Scope | `admin.directory.group.readonly` | `cloud-identity.groups.readonly` |

**Default to the Directory API.** It covers the common case, needs one fewer scope, one fewer enabled API, and `includeDerivedMembership=true` already gives flattened membership. Expose a `useCloudIdentity` toggle for customers who need dynamic or security groups, and implement it as an alternate `listGroups`/`listGroupMembers` inside the same `IdentityProvider` — the interface doesn't change.

⚠️ **Uncertainty:** whether `includeDerivedMembership=true` resolves membership through *dynamic* groups nested inside a static group. If it doesn't, Cloud Identity's `searchTransitiveMemberships` is the only correct path for those customers. Verify before advertising dynamic-group support.

### Nested groups

CompassDocs' `setGroupMembers(groupId: number, userIds: number[])` takes a **flat user id list**, so nesting must be resolved before it. Two implementations, in preference order:

1. **Provider-side flattening** — `includeDerivedMembership=true`, then drop every member whose `type !== "USER"`. One call chain, no recursion, no cycles to worry about.
2. **Client-side recursion** — fallback for Cloud Identity or if (1) proves unreliable. Required guards: a `Set<string>` of visited group ids (Google Groups **can** cycle), a depth cap of 10, and a total-member cap. Cap breaches must be *reported to the admin*, not silently truncated.

Either way, `ProviderGroup.nested` is set so the admin UI can show "contains nested groups — membership is flattened".

### Member types

| Google `type` | Handling |
|---|---|
| `USER` | Map to a CompassDocs user (below). The normal case. |
| `GROUP` | Recurse / already flattened. Never mapped directly. |
| `CUSTOMER` | "Everyone in the organization." **Do not expand to all users** — that would make one group grant equal to org-wide access and silently defeat private-space scoping. Skip it and surface a warning: "This group grants access to everyone in your domain; import it only if that's intended." |
| `EXTERNAL` | An address outside the domain. Map only if a CompassDocs user already has that email; otherwise skip and report the count. |

Members with `status: "SUSPENDED"` should be **included** in the mapping — they resolve to CompassDocs users whose `status` is already `disabled`, and `getSessionUser` blocks them at the session layer (`db.ts:5823`). Excluding them would cause churn on suspend/unsuspend cycles.

### Mapping a member to a CompassDocs user

Same order as the SSO path:
1. `getUserByExternalId("google", member.id)`;
2. `getUserByEmail(member.email)`.

Members that resolve to nothing are counted and reported — the existing UI copy already says "(N members matched to CompassDocs users)" (`GroupsPanel.tsx:373`), so the unmatched count is the useful new signal. **Do not auto-create users from group membership**: it would bypass `sso_allowed_domains` and the seat check in `withinSeatLimit` (`license.ts:127`).

### Group → RBAC

Groups reach authorization through four existing paths, none of which need changing:

- `space_groups` → private-space **read** visibility, via `accessibleSpaceIdsFor` (`db.ts:3157`);
- `space_editor_groups` → per-space **edit** grants, via `spaceEditGrantAllows` (`db.ts:3117`);
- `section_access_<section>` JSON → delegated Announcements/Compliance/Training, via `canAccessSection` (`section-access.ts:60`);
- `link_groups` → quick-link visibility.

**Explicitly do not map Google groups to the `Role` ladder.** `Role` is a per-user column with a total ordering (`types.ts:6-27`); a group→role mapping would need a conflict rule for users in multiple groups and would let a Workspace admin escalate CompassDocs privileges from outside CompassDocs. Microsoft doesn't do this today; Google shouldn't either. If customers ask for it, the honest answer is that it belongs in a broader RBAC redesign, not in the provider layer.

**Two behaviours to preserve for parity:**
- Manual membership edits on a synced group are *allowed* but overwritten on the next sync — `admin/groups/[id]/route.ts:80-81` documents this ("they'll be overwritten on the next sync — the UI warns about this"). Google groups inherit it.
- Renaming a synced group is rejected (`route.ts:49-54`, `group.source !== "manual"`). Google groups inherit this too, so `ProviderGroup.name` (from `groups.name`, falling back to the local-part of `email` when `name` is blank) is authoritative.

---

## 5. Directory (people) field mapping

`directory_people` columns are fixed (`db.ts:620-651`): `name, title, department, email, phone, mobile, office, photo`, plus `custom jsonb`, plus `assistant_id`, `hidden`, `external_id`, `source`.

### Built-in columns

| Column | Google Directory user field | Notes |
|---|---|---|
| `external_id` | `id` | Immutable numeric string. The join key everywhere. |
| `name` | `name.fullName` | Fall back to `[givenName, familyName].filter(Boolean).join(" ")`. `fullName` is output-only/computed. |
| `email` | `primaryEmail` | Aliases live in `aliases[]`; only the primary lands here. |
| `title` | `organizations[]` where `primary === true` → `.title` | Fall back to the first entry when none is flagged primary — Workspace does not always set the flag. |
| `department` | `organizations[primary].department` | Same fallback. |
| `phone` | `phones[]` where `type === "work"` (prefer `primary === true`) → `.value` | |
| `mobile` | `phones[]` where `type === "mobile"` → `.value` | |
| `office` | `locations[]` where `type === "desk"` → `buildingId` / `floorName` / `floorSection` | Fall back chain: → `organizations[primary].location` → `addresses[]` where `type === "work"` → `.formatted`. Compose as `"Building · Floor · Section"`, dropping blanks. |
| `photo` | `users.photos.get(userKey).photoData` | Web-safe base64 → standard base64 → `data:${mimeType};base64,${b64}`. 404 ⇒ no photo. |
| *(change check)* | `thumbnailPhotoEtag` on the user resource | Compare against the stored etag; skip the photo call when unchanged. This is the difference between N+1 calls per sync and near-zero. |

`replaceGraphPeople`'s existing photo rule (`directory.ts:478`) is exactly right and must be preserved:
```sql
photo = CASE WHEN EXCLUDED.photo <> '' THEN EXCLUDED.photo ELSE directory_people.photo END
```
— an empty incoming photo keeps the stored one, so an etag-skip or a photo 404 never blanks an existing picture.

### Fields with no column: manager, org unit, and everything else

`directory_people` has **no manager and no org-unit column**. Both go through `directory_fields` → `custom` jsonb, mapped by the new `google_path`:

| Concept | `google_path` | Value written |
|---|---|---|
| Manager | `relations[manager]` | The manager's **email** — that is what Google stores. |
| Org unit | `orgUnitPath` | e.g. `/Sales/West`. |
| Employee ID | `externalIds[organization]` | Or a custom-schema field, depending on the customer. |
| Cost centre | `organizations[primary].costCenter` | |
| Building | `locations[desk].buildingId` | |
| Employee type | `organizations[primary].description` | Convention varies; no fixed Google field. |
| Custom schema value | `customSchemas.<SchemaName>.<fieldName>` | Requires `projection=full`. |

**Manager is worth special handling.** `directory_people` *does* have `assistant_id` — a person→person self-reference — proving the pattern works. Recommend adding the mirror:

```sql
ALTER TABLE directory_people
  ADD COLUMN IF NOT EXISTS manager_id integer REFERENCES directory_people(id) ON DELETE SET NULL;
```

resolved in a **second pass** after all people are upserted (the manager may not exist yet during the first pass), with a self-reference guard copied from `updatePerson`'s assistant logic (`directory.ts:413-418`). This is a core change that benefits Microsoft equally — Graph's `manager` navigation property maps to it identically — so it should ship as a provider-neutral improvement, not a Google feature. If that's too much for v1, the `custom` field fallback stores the manager's email as plain text and works today with zero schema change.

⚠️ **Uncertainty:** Google's canonical storage for manager. I'm confident it is `relations[]` with `type: "manager"` and `value` = the manager's email, which is what the Admin console's "Manager's email" field writes. Google has iterated here; verify against a live tenant before shipping, and make the path configurable so a customer can point it elsewhere if needed.

### Custom schemas

Request `projection=full` on `users.list` to receive:
```json
"customSchemas": { "HR": { "employee_id": "E-4471", "start_date": "2021-03-01" } }
```
Multi-valued schema fields arrive as arrays of `{ value, type, customType }` — join with `", "` and let the admin set `display: "tag"` on the field so `directory_fields`' existing tag rendering splits them back into badges. That mechanism already exists (`DirectoryField.display`) and needs nothing new.

The alternative, `projection=custom&customFieldMask=HR,Benefits`, returns less data but requires knowing the schema names up front. Use `projection=full` for simplicity, and `customer/{id}/schemas` only to populate the field-mapper dropdown.

`fieldPathSuggestions()` for Google returns the Google analogue of `GRAPH_PATHS` (`DirectorySettings.tsx:32-37`):
```ts
["orgUnitPath", "relations[manager]", "externalIds[organization]",
 "organizations[primary].costCenter", "organizations[primary].description",
 "locations[desk].buildingId", "locations[desk].floorName",
 "addresses[work].formatted", "recoveryEmail", "languages[0].languageCode",
 "keywords[0].value", "isEnrolledIn2Sv", "lastLoginTime", "creationTime",
 ...schemaNames.flatMap(s => s.fields.map(f => `customSchemas.${s.name}.${f}`))]
```
The last line is why `userschema.readonly` is worth requesting even though it's optional — it turns a free-text box into a real picker.

`sanitizeCustom` (`directory.ts:316-326`) already drops unknown keys and truncates to 500 chars, so no new validation is needed on the write side.

---

## 6. Sync mechanics

### Full vs incremental — and an important correction

**The Admin SDK Directory API has page tokens but does not have sync tokens.** `nextPageToken` is a pagination cursor within one enumeration; it is not a delta cursor you can persist and replay. Sync tokens (`nextSyncToken` / `syncToken`) are a **Google Calendar API and People API** feature, not a Directory API one. Nor does `users.list` support an `updatedMin`-style filter. Anyone designing against "Google sync tokens" for the Directory API is designing against an API that doesn't exist.

That leaves three real options:

**(a) Full enumeration on a schedule — ship this.**
Matches the current Microsoft behaviour exactly (`replaceGraphPeople` is already a full replace). At 500 users/page and a typical few-thousand-seat tenant, a full people sync is 2–10 `users.list` calls plus, thanks to etag skipping, near-zero photo calls on steady-state runs. Perfectly affordable hourly.

**(b) Reports API change feed — the real incremental path, ship second.**
```
GET /admin/reports/v1/activity/users/all/applications/admin
  ?startTime=<last cursor ISO8601>&maxResults=1000
```
Returns admin-console change events (`CREATE_USER`, `DELETE_USER`, `SUSPEND_USER`, `UNSUSPEND_USER`, `RENAME_USER`, `CHANGE_USER_*`, `ADD_GROUP_MEMBER`, `REMOVE_GROUP_MEMBER`, …). Extract the affected user/group ids, refetch just those, cursor forward on the newest event time. This is what `changedSince?(cursor)` on the interface is for.

Two caveats that make it an optimisation, not a replacement: Reports data can lag real changes (documented latency varies by event type, historically hours for some), and it captures *admin-initiated* changes — self-service profile edits may not appear. So: **incremental between full syncs, full sync at least daily.** Never let incremental be the only path.

**(c) Push notifications (`users.watch` / `groups.watch`) — do not ship.**
Requires a publicly reachable HTTPS webhook on a domain verified in Google Search Console, and channels expire and must be renewed. Self-hosted CompassDocs instances are frequently not publicly reachable. The operational cost is disproportionate.

⚠️ **Uncertainty:** exact Reports API event-name coverage and latency. Verify the event list against a live tenant; treat (b) as a v2 optimisation behind a toggle, with (a) as the always-correct fallback.

### Pagination

```ts
async function *pages<T>(url: string, key: "users"|"groups"|"members"): AsyncGenerator<T[]> {
  let token: string | undefined;
  let guard = 0;
  do {
    if (++guard > 1000) throw new Error("Pagination guard tripped — refusing to loop.");
    const u = new URL(url);
    if (token) u.searchParams.set("pageToken", token);
    const body = await googleGet(u.toString());
    yield (body[key] ?? []) as T[];
    token = body.nextPageToken;
  } while (token);
}
```
`maxResults`: 500 for users, 200 for groups and members. The guard matters — a bug that returns the same `pageToken` forever otherwise burns the customer's quota silently.

### Rate limits and quotas

Mechanism (confident): quota is enforced per-project **and** per-impersonated-user. Exceeding it returns HTTP 403 with `reason` in `{ quotaExceeded, rateLimitExceeded, userRateLimitExceeded }`, or HTTP 429. Google's guidance is exponential backoff with jitter.

⚠️ **Uncertainty on the numbers.** I believe the Admin SDK Directory default is on the order of a couple of thousand queries per minute per user, with a separate lower ceiling for the Reports API — but I would not hardcode a specific figure. Read the live value from the project's **APIs & Services → Quotas** page, and design so the exact number doesn't matter:

- **Bounded concurrency: 5.** Comfortably under any plausible ceiling and enough to keep photo fetching from dominating wall time.
- **Backoff:** on 403/`*RateLimitExceeded*` or 429, sleep `min(60s, 2^n × 1000ms) + random(0..1000)ms`, up to 5 attempts, then fail the run with a clear message.
- **Honour `Retry-After`** when present.
- **Do not use HTTP batching.** Google deprecated the global `www.googleapis.com/batch` endpoint; per-API batch endpoints still exist but add real complexity for marginal gain given the low call volume. Bounded concurrency is simpler and sufficient.
- **Etag-gate photos.** `thumbnailPhotoEtag` turns the N+1 into ~0 on steady-state runs. This is the single highest-leverage optimisation in the whole sync.

### Scheduling

Hook into the existing hourly tick in `src/instrumentation.ts:11-52`, alongside `remindDueReviews` / `maybeSendWeeklyDigests` / `trainingHourly`:

```ts
// Directory provider syncs (entitlement-gated inside; atomic claim).
try {
  const { runDueDirectorySyncs } = await import("./lib/directory-sync-runner");
  await runDueDirectorySyncs();
} catch (e) {
  console.error("[directory] scheduler error:", e);
}
```

Follow the established multi-instance pattern documented at `instrumentation.ts:19` — "The claim is a single atomic UPDATE, so concurrent instances are safe." Claim via a conditional `setSetting`-style update on `directory_google_last_sync` guarded by a `next_due_at`, or a Postgres advisory lock as `runScheduledBackupIfDue` does. Two app instances running a full replace concurrently would produce interleaved deletes.

Default cadence: **people every 6 hours, groups every 6 hours, offset by an hour** so they don't contend. Full people sync forced daily even when incremental is on. Manual "Sync now" always runs a full sync and bypasses the schedule (matching `/api/ee/directory/sync` today).

### Conflict resolution against manual edits

`replaceGraphPeople` already establishes the rule, and Google must match it exactly so the two providers are indistinguishable in behaviour:

- **Provider wins** on `name, title, department, email, phone, mobile, office`.
- **Local wins, always preserved:** `hidden` (never in the upsert column list), `assistant_id` (ditto), and any `custom` key the sync doesn't map — guaranteed by `custom = directory_people.custom || EXCLUDED.custom` (`directory.ts:479`), a jsonb merge where synced keys win and unsynced keys survive.
- **Photo:** empty incoming keeps stored (see §5).
- **Manual rows** (`source='manual'`) are never touched; the delete is `WHERE source = 'google'`.

The one gap worth naming: an admin who fixes a typo in a synced person's title sees it reverted on the next sync with no warning. If you want to close it, add
```sql
ALTER TABLE directory_people ADD COLUMN IF NOT EXISTS pinned jsonb NOT NULL DEFAULT '{}'::jsonb;
```
holding `{"title": "Head of IT"}` overrides that the upsert applies last. I'd **defer this to v2** — shipping Google with behaviour that differs from Microsoft's is worse than shipping both with the same known limitation, and it's a provider-neutral improvement when it lands.

### Deletion safety

The current delete is unguarded:
```sql
DELETE FROM directory_people WHERE source = 'graph' AND NOT (external_id = ANY($1::text[]))
```
A truncated enumeration — a 429 on page 4 of 6 that some caller swallowed — wipes the tail of the directory, nulls `directory_person_id` across `users`, and breaks byline resolution. Three guards, all in `replaceProviderPeople`:

1. **Completeness is the caller's contract, enforced by type.** `listPeople` must either return every page or throw. Never `catch` mid-pagination and return what you have.
2. **Threshold.** If the delete would remove more than `maxDeleteFraction` (default **20%**) of that source's current rows, skip the delete, still apply upserts, and return `abortedDelete` with a message. The admin sees "Sync completed but 340 removals were held back — that's 41% of your directory, which usually means an API error. Re-run to confirm, or raise the threshold." A confirm flag on "Sync now" overrides for the legitimate case (a customer really did offboard a division).
3. **Never delete on a zero-length result.** An empty `people` array means "the API returned nothing", which is a failure, not an empty tenant. Hard-refuse.

Add the same guard to the group path: `setGroupMembers(groupId, [])` currently empties a group silently.

### Reporting to admins

Reuse the existing status shape (`directory-config.ts:33-38`), widened:

```ts
export interface DirectorySyncStatus {
  at: string;
  ok: boolean;
  count?: number;
  error?: string;
  // additions:
  provider?: "graph" | "google";
  mode?: "full" | "incremental";
  duration_ms?: number;
  created?: number;
  updated?: number;
  deleted?: number;
  skipped_no_title?: number;      // the requireTitle filter
  skipped_no_phone?: number;
  skipped_suspended?: number;
  photos_fetched?: number;
  photos_skipped_etag?: number;
  held_back_deletes?: number;     // the safety valve fired
  warnings?: string[];            // "3 nested groups exceeded depth 10", etc.
}
```

Surfaces:
1. **Settings → Directory panel** — the existing "Last sync" line, now with the counts. Warnings render as the standard `notice-warn` block per STYLEGUIDE.md.
2. **Group import/sync toasts** — already show matched counts (`GroupsPanel.tsx:373, 391`); add the unmatched count, which is the actionable number ("12 members had no CompassDocs account").
3. **Audit log**, following the existing dot-namespaced convention (`audit.ts:19`):
   - `settings.directory_google` — config change (mirrors `settings.directory_graph`), with `details: { key_changed: boolean }` and **never** the key itself;
   - `google.people_sync` — `details: { created, updated, deleted, mode, duration_ms }`;
   - `google.groups_sync`, `google.group_import`;
   - `google.user_disable` — mirroring `scim.user_disable`.
4. **Failure escalation.** Three consecutive failed scheduled syncs → notify admins through the existing notification path, the way `remindDueReviews` emails approvers. A directory sync that has been silently failing for a fortnight is the realistic failure mode, and nothing surfaces it today.

---

## 7. CE vs enterprise gating

Match Microsoft exactly — there is no principled reason for the two providers to differ, and any asymmetry becomes a support burden.

| Capability | Entitlement | Where the code lives |
|---|---|---|
| Google OIDC login | `sso` | Config in core (`sso-config.ts` + `sso_vendor`); flow in overlay `/api/ee/sso/*` |
| Google SAML login | `sso` | Already works — `saml-config.ts:1-3` names Google Workspace as a supported IdP, and `parseIdpMetadata` handles Google's metadata XML |
| Google people sync | `directory_sync` | Config in core (`google-config.ts`); `IdentityProvider` impl in overlay; execution at `/api/ee/google/sync` |
| Google group sync | `directory_sync` | Same; `/api/ee/google/groups{,/import,/sync}` |
| SCIM inbound | `scim` | Core routes, runtime-gated by `scimGuard` |

**Free in CE** (identical to Microsoft today): manual directory entry, manual groups, the custom-field definitions including `google_path` (the column and mapper UI exist; nothing populates them without a licence), print columns, and the `directory_people`/`groups` schema.

**Gating rules to follow:**

1. **Config modules live in core.** `sso-config.ts:1-4`, `saml-config.ts:2-3` and `directory-config.ts:1-3` all say the same thing: "Lives in the core so the settings survive edition switches and the admin UI can manage them." `google-config.ts` must too. A customer who downgrades and re-upgrades must not have to re-paste a service-account key.

2. **`featureEnabled` is a double gate** (`ee.ts:20-27`): the code must be in the build **and** the licence must grant it. The admin panel must distinguish the three states the way `GroupsPanel.tsx:432-447` and `DirectorySettings.tsx:263-289` already do:
   - `!bundled` → "This is the community edition — Google Workspace sync ships in the enterprise image (ghcr.io/mattny20/compassdocs-ee)."
   - `bundled && !licensed` → "Your licence doesn't include the `directory_sync` entitlement."
   - `bundled && licensed && !configured` → the setup checklist.

3. **Reuse `directory_sync`, do not add an entitlement.** Adding `google_directory_sync` would mean reissuing every existing licence and would let a customer be sold Microsoft-only sync — a distinction with no product meaning. One entitlement, two providers. Same argument for `sso`.

4. **EE feature-list changes ship from the compassdocs-ee overlay repo**, per CLAUDE.md — core only declares the `EntitlementFeature` union in `license.ts:31-38`, which needs no change here.

5. **The admin API routes stay in core** and are `apiGuard("admin")` + `featureEnabled("directory_sync")`, exactly like `admin/directory/graph/route.ts`. Only the overlay holds Google API client code. This keeps the OSS build fully buildable and testable without the private package.

---

## Open questions and things I did not verify

1. **`includeDerivedMembership` × `roles`** — whether they can be combined, and whether derived membership resolves through *dynamic* groups. Determines whether Cloud Identity is optional or mandatory for some customers.
2. **Manager storage** — `relations[]` with `type: "manager"` is my strong belief, but Google has iterated. Verify on a live tenant.
3. **Exact quota numbers** for Admin SDK Directory and Reports. The design is deliberately quota-number-agnostic, but the docs copy shouldn't state a figure I haven't confirmed.
4. **Reports API event coverage** — specifically whether self-service profile edits appear at all. If they don't, incremental sync silently misses them and the daily full sync is load-bearing rather than belt-and-braces.
5. **Direct admin-role assignment to service accounts** — whether this now covers Admin SDK Directory endpoints without `sub` impersonation. Would simplify setup meaningfully if so.
6. **OAuth scope sensitivity classification** for `admin.directory.*` (sensitive vs restricted). Only matters for the OAuth-app fallback path, and only for non-Internal apps, but it determines whether that fallback is realistically usable.
7. **`ee/` overlay contents** — I could not inspect the private repo, so I'm inferring the Microsoft sync's internals from `directory.ts`'s `replaceGraphPeople` contract, the `/api/ee/*` URLs the components call, and the config shape. If the overlay's Graph sync calls `replaceGraphPeople` differently than I assume, Seam A's shim needs adjusting.
8. **Whether a Workspace Marketplace listing is on the roadmap.** It's the only route to Microsoft-level one-click setup parity, and it's a vendor-side project, not something this design can deliver.

## Two pre-existing bugs found along the way

- `src/lib/db.ts:2554-2559` — `getUserByAnyExternalId`'s doc comment claims case-insensitivity ("SCIM clients vary the casing") but the query is `WHERE external_id = $1`, a case-sensitive equality. Latent today because Entra sends consistent lowercase GUIDs.
- `src/lib/directory.ts:495-499` — `replaceGraphPeople`'s unguarded `DELETE` will wipe the provider-sourced directory if the caller ever passes a truncated list. Not Google-specific; the safety valve in §6 should be added regardless of whether Google ships.