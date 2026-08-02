# CompassDocs — Draft Permission Catalog (RBAC v1)

**Status:** draft contract. Derived from the authorization map plus a completing pass over the routes the census truncated (`src/app/api/admin/{backup-destinations,diagnostics,directory,license,link-categories,links,migrate,newsletter,templates,update,version}`, `src/app/api/{backups,export,import,addin,setup,oauth,plantuml,integrations}`, all 18 `requireRole` pages, all `featureEnabled` sites, `src/app/api/mcp/route.ts`).

**Totals:** 209 permission keys across 30 resource families, reproducing 253 catalogued check sites across five enforcement mechanisms plus four non-session principal types.

---

## 1. How to read this catalog

### 1.1 Grant scope

| Scope | Meaning | Backing store today |
|---|---|---|
| `global` | Granted once, applies workspace-wide | `users.role` column |
| `space` | Granted per space (directly or via group) | `space_groups`, `space_editors`, `space_editor_groups` + `spaces.visibility` |
| `section` | Granted per operational section (announcements / compliance / training) | `settings` row `section_access_<section>` (JSON, no FK) |

Three further qualifiers appear in the **Conditions** column and are *not* grant scopes — they are object-level predicates evaluated after the grant check:

- **self** — the permission only ever applies to rows the principal owns (`/api/account/*`, own training assignment, own comment). Grantable at `global`; the ownership filter is not negotiable.
- **status** — gated on the object's lifecycle state (`draft` vs `published`, newsletter `draft|in_review|approved|sent`).
- **mode** — gated on an org-wide setting (`approval_mode`, `editors_edit_all`, `public_site_enabled`, `shares_enabled`).

### 1.2 Legacy role column

`V` = viewer, `E` = editor, `A` = approver, `Ad` = admin. Additional principal markers:

- `S` — additionally requires a space grant (read scope and/or edit grant)
- `Sec` — granted by section delegation, **not** by role (a viewer holding the grant qualifies)
- `N` — granted by `users.newsletter_role`, orthogonal to the ladder
- `L` — granted by group leadership (`userLeadGroups`)
- `T` — reachable via API token / MCP token, subject to `read`/`write` scope
- `∅` — anonymous; no principal exists today

Because of the ordinal ladder, a role listed implies every role to its right. `Ad` appearing on a row is almost always **transitive, not explicit** — see §4.

### 1.3 EE column

`EE:<feature>` means the capability is additionally gated by `featureEnabled(f)` = *enterprise code present in this build* **AND** *a valid, non-expired license grants `f`*. Entitlement composes as **AND** with permission; it never grants. See §6.

---

## 2. Principal model (must be settled before the catalog is implementable)

Today there are **six** distinct principal types. Only the first carries a role on the session.

| Principal | Resolved by | Carries | Notes |
|---|---|---|---|
| Session user | `getCurrentUser()` → `SessionUser` | `role`, `newsletter_role` | 12 fields; **no** space grants, **no** section grants, **no** permission list |
| API token user | `v1Auth()` → `V1User = User & {token_scopes}` | full DB row + `read`/`write` scope | Cookie-free; every `/api/v1` handler re-implements the role/space checks by hand |
| MCP token user | `src/app/api/mcp/route.ts:912,924` | full user row + `token_scopes` | OAuth-issued 1h tokens; same `read`/`write` scope split; re-implements the same checks a third time |
| SCIM provisioner | `src/lib/scim.ts:59` bearer token | no user at all | Writes `users.role` directly — a **privilege-granting** principal outside the ladder |
| Anonymous | none | none | Public site, share links, public search, PlantUML render |
| Integration (chat) | Slack/Teams request signature | none — fixed synthetic scope (`chatSpaceScope()`, non-private spaces) | `src/lib/chat-ask.ts:112`. Answers are bounded by a *workspace* scope, not any user's scope |

**Contract decision required:** the catalog below assumes a single `Principal { id?, kind, role?, grants }` that all six can be projected onto, with `anonymous` and `integration` modelled as real principals holding narrow preset roles (§5.6, §5.7). If instead they stay outside the model, families 30 (`public.*`) and the `integration` rows must be marked out-of-scope rather than deleted.

---

## 3. The catalog

### 3.1 `document` — 31 permissions

| Key | Label | Description | Scope | Legacy roles | Conditions / notes |
|---|---|---|---|---|---|
| `document.read` | Read document | Read a published document | space | V,E,A,Ad · S · T(read) · ∅ | Denial is **404**, not 403, to avoid an existence oracle |
| `document.read_draft` | Read drafts | See drafts and branch working copies in reads, search, trees, palette recents, relation pickers, tracking | space | E,A,Ad · S · T(read) | The hidden second read tier; ~10 sites use `status==="draft" && !roleAtLeast(editor)` |
| `document.lookup` | Look up documents | Query the link-insertion picker in the editor | space | E,A,Ad · S | `documents/lookup/route.ts:12,21` |
| `document.create` | Create document | Create a document in a space | space | E,A,Ad · S(edit) | Requires read **and** edit on the target space |
| `document.update` | Edit document | Edit title/body/metadata | space | E,A,Ad · S(edit) | Denial of `document.publish` downgrades this to a change request, not a 403 |
| `document.publish` | Publish document | Publish directly to live | space | A,Ad · **E when `approval_mode=open`** | **Conditional grant**, 11 duplicated sites. Denial = fallback behaviour (draft / queued CR), not rejection. See §7.1 |
| `document.schedule` | Schedule publish/expiry | Set `publish_at` / `archive_at` | space | A,Ad · E(open) | The **only** publish-derived check that hard-403s (`documents/[id]/route.ts:157`) — it bypasses review |
| `document.move` | Move document | Move a document between spaces | space | E,A,Ad · S(edit, **both** source and target) | Two independent space checks per call |
| `document.reorder` | Reorder pages | Reorder sub-pages among siblings | space | E,A,Ad · S(edit) | `documents/[id]/move/route.ts` |
| `document.branch` | Branch document | Create a working copy | space | E,A,Ad · S(edit) | |
| `document.merge` | Merge branch | Merge a working copy back to source | space | E,A,Ad · S(edit) | Merging into live additionally needs `document.publish` |
| `document.version_read` | Read version history | View the version list and diffs | space | E,A,Ad · S | `doc/[id]/history/page.tsx` |
| `document.version_restore` | Restore version | Roll a document back to an earlier version | space | E,A,Ad · S(edit) | Restoring over published additionally needs `document.publish` |
| `document.review_manage` | Manage review schedule | Set/clear the review date, mark reviewed | space | E,A,Ad · S(edit) | |
| `document.delete_draft` | Delete draft | Move a draft to trash | space | E,A,Ad · S(edit) | status |
| `document.delete_published` | Delete published document | Move a published document to trash | space | A,Ad · S(edit) | status — the split at `documents/[id]/route.ts:290` |
| `document.restore` | Restore from trash | Restore a trashed document to its space | space | E,A,Ad · S(edit) | ⚠ **missing visibility pre-check today** — see §9.2 |
| `document.purge` | Purge permanently | Irreversibly delete from trash | global | Ad | `trash/[id]/route.ts:33` |
| `document.relation_read` | Read relations | List related documents | space | V,E,A,Ad · S | Draft candidates need `document.read_draft` |
| `document.relation_manage` | Manage relations | Add/remove document relations | space | E,A,Ad · S(edit) | Relation target must also be in read scope |
| `document.dms_link_read` | Read DMS links | List external DMS links on a document | space | V,E,A,Ad · S | |
| `document.dms_link_manage` | Manage DMS links | Add/remove external DMS links | space | E,A,Ad · S(edit) | |
| `document.share_read` | View share link | Read a document's existing public share token | space | E,A,Ad · S(edit) | ⚠ **missing visibility pre-check today** — see §9.1 |
| `document.share_create` | Create share link | Mint an anonymous public link to a document | space | E,A,Ad · S(edit) | mode (`shares_enabled`). ⚠ Same gap. This is the highest-severity finding |
| `document.share_revoke` | Revoke share link | Invalidate a share token | space | E,A,Ad · S(edit) | |
| `document.presence` | Editing presence | Publish/read the "who else is editing" heartbeat | space | E,A,Ad · S | |
| `document.track_view` | Record a view | Send a view-tracking ping | space | V,E,A,Ad · S | Draft tracking needs `document.read_draft` |
| `document.feedback_vote` | Vote helpfulness | Cast/read your own "was this helpful?" vote | space | V,E,A,Ad · S | self |
| `document.ack_submit` | Acknowledge policy | Attest to having read a policy document | space | V,E,A,Ad · S | **EE:policy_ack** · self |
| `document.ack_require` | Require acknowledgement | Toggle whether a document demands attestation | space | A,Ad · S | **EE:policy_ack** |
| `document.ack_roster_read` | Read acknowledgement roster | See who has and hasn't attested | space | A,Ad · S | **EE:policy_ack** |

### 3.2 `attachment` — 3

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `attachment.read` | Download attachment | Read a file attached to a document | space | V,E,A,Ad · S · ∅ | Inherits the parent document's space and draft tier. Anonymous via public site **or** share token (`attachments/[id]/route.ts:39,45`) |
| `attachment.upload` | Upload attachment | Attach a file to a document | space | E,A,Ad · S(edit) | |
| `attachment.delete` | Delete attachment | Remove an attachment | space | E,A,Ad · S(edit) | |

### 3.3 `comment` — 4

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `comment.read` | Read comments | Read a document's comment thread | space | V,E,A,Ad · S | Draft threads need `document.read_draft` |
| `comment.create` | Post comment | Comment on a document | space | V,E,A,Ad · S | |
| `comment.delete_own` | Delete own comment | Remove a comment you authored | space | V,E,A,Ad · S | self |
| `comment.delete_any` | Moderate comments | Delete any user's comment | space | Ad | Today admin-only and **not** delegable — a natural candidate for space scope in RBAC |

### 3.4 `suggestion` — 2

| Key | Label | Description | Scope | Legacy roles |
|---|---|---|---|---|
| `suggestion.create` | Suggest an edit | Submit an inline suggestion as a reader | space | V,E,A,Ad · S |
| `suggestion.review` | Review suggestions | Accept or dismiss reader suggestions | space | A,Ad · S |

### 3.5 `change_request` — 2

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `change_request.read` | Read review queue | See pending change requests | space | A,Ad · S | `review/page.tsx` |
| `change_request.decide` | Approve/reject change | Approve or reject a queued change request | space | A,Ad · S | Both the CR's source space **and** any move-on-approve target must be in scope |

> `change_request.create` is deliberately **not** a permission: it is the fallback path taken when `document.publish` is denied. Modelling it as a permission would let it be revoked independently, which no current code path allows.

### 3.6 `space` — 11

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `space.read` | Read space | See a space and its contents | space | V,E,A,Ad · S · ∅(public) | Derived from `spaces.visibility` + group grants; `Ad` short-circuits to the `"all"` sentinel |
| `space.tree_read` | Read page tree | Read a space's page hierarchy | space | V,E,A,Ad · S | Draft pages need `document.read_draft` |
| `space.author` | Author in space | Create/edit/move/trash/attach within a space | space | E,A,Ad · S(edit) | mode (`editors_edit_all`, default **on**). **Visibility-blind by design** — see §8.2 |
| `space.subscribe` | Subscribe to space | Subscribe yourself to a space's change notifications | space | V,E,A,Ad · S | self |
| `space.create` | Create space | Create a new space | global | Ad | |
| `space.update` | Update space | Rename a space, change its visibility | global | Ad | Today conflated with `space.manage_members` in one handler |
| `space.manage_members` | Manage space access | Grant/revoke the viewer groups and editor users/groups on a space | global | Ad | **The single most important thing RBAC should move to `space` scope.** Today undelegable |
| `space.delete` | Delete space | Delete a space and its contents | global | Ad | |
| `space.category_read` | Read space categories | List a space's categories | global | Ad | |
| `space.category_manage` | Manage space categories | Create/rename/delete space categories | global | Ad | |
| `space.edit_policy_manage` | Set org edit policy | Toggle `editors_edit_all` — whether any editor may author anywhere | global | Ad | **Meta-permission** over `space.author` |

### 3.7 `search` — 3

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `search.query` | Search | Full-text/hybrid search | global | V,E,A,Ad · T(read) | Always intersected with read scope; explicit `?space=` filters cannot escape it |
| `search.ai_query` | Ask AI | Ask a grounded natural-language question | global | V,E,A,Ad | Answers grounded only in readable spaces; draft citation needs `document.read_draft` |
| `search.public_query` | Public search | Anonymous search of the public site | global | ∅ | mode (`public_site_enabled`); rate-limited 30/min/IP, 300/min global |

### 3.8 `ai` — 2

| Key | Label | Description | Scope | Legacy roles |
|---|---|---|---|---|
| `ai.write_assist` | Use writing assistant | Generate/rewrite prose in the editor | global | E,A,Ad |
| `ai.proofread` | Use proofreader | Run the AI proofreader | global | E,A,Ad |

### 3.9 `analytics` — 2

| Key | Label | Description | Scope | Legacy roles |
|---|---|---|---|---|
| `analytics.read` | Read analytics | Workspace analytics dashboard | global | A,Ad · S(results scoped) |
| `analytics.document_read` | Read document analytics | Per-document metrics | space | A,Ad · S |

### 3.10 `newsletter` — 18 (fully parallel ladder today)

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `newsletter.use` | Use newsletter | Access the newsletter module at all | global | Ad · N(contributor, approver) | `role==="admin" \|\| newsletter_role!=="none"` |
| `newsletter.read` | Read newsletter | View a newsletter's detail and files | global | Ad · N · **all users once `sent`** | status |
| `newsletter.read_all` | Read all in-flight newsletters | See other people's unsent drafts | global | Ad · N(approver) | Contributors see only their own |
| `newsletter.create` | Create newsletter | Start a newsletter draft | global | Ad · N | |
| `newsletter.edit_content` | Edit newsletter | Edit subject/body | global | Ad · N(approver always; author until approved) | status — `sent` and `approved` are frozen to the author |
| `newsletter.submit` | Submit for review | Move a draft into review | global | Ad · N(author) | status ∈ {draft, changes_requested} |
| `newsletter.decide` | Approve / request changes | Rule on a newsletter in review | global | Ad · N(approver, subject to per-newsletter override list) | status = in_review |
| `newsletter.schedule` | Schedule send | Schedule an approved newsletter | global | Ad · N(approver) | status = approved |
| `newsletter.send` | Send newsletter | Send to the whole organization | global | Ad · N(approver) | status = approved |
| `newsletter.send_test` | Send test copy | Send a test to yourself | global | Ad · N(author or approver) | status ≠ sent |
| `newsletter.comment` | Comment on newsletter | Post editorial comments | global | Ad · N(author or approver) | status ≠ sent |
| `newsletter.delete` | Delete newsletter | Delete a newsletter | global | Ad(any time) · N(author while draft/changes_requested) | status |
| `newsletter.manage_approvers` | Set approver override | Change a newsletter's approver allow-list | global | Ad · N(author while draft-ish, or an approver) | **Object-level meta-permission** — an approver can widen who may approve |
| `newsletter.asset_upload` | Upload newsletter image | Upload an image asset | global | Ad · N | |
| `newsletter.file_read` | Download newsletter file | Download an attached file | global | same as `newsletter.read` | |
| `newsletter.file_manage` | Manage newsletter files | Attach/delete newsletter files | global | same as `newsletter.edit_content` | |
| `newsletter.dismiss` | Dismiss newsletter | Dismiss a sent newsletter from your dashboard | global | V,E,A,Ad | self |
| `newsletter.configure` | Configure newsletter | Senders, appearance, recipient people list | global | Ad | |

### 3.11 `training` — 22 · **all EE:training**

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `training.read_own` | Read own training | See your own assignments | global | V,E,A,Ad | self |
| `training.progress_own` | Record own progress | Advance/complete your own assignment | global | V,E,A,Ad | self — **ownership enforced inside the query** (`getMyTrainingAssignment(id, user.id)`), not by a visible guard |
| `training.certificate_read_own` | Read own certificate | View your completion certificate | global | V,E,A,Ad | self |
| `training.certificate_read_any` | Read any certificate | View anyone's certificate | section | Sec(training) · Ad | |
| `training.team_read` | Read team training | See training status for groups you lead | global | **L only** — no role, no section grant | Undeclared sixth mechanism (`userLeadGroups`) |
| `training.deck_read` | Read training decks | List decks | section | Sec(training) · Ad | |
| `training.deck_manage` | Manage training decks | Create/update/delete decks | section | Sec(training) · Ad | |
| `training.deck_preview` | Preview a deck | Preview deck content before assigning | section | Sec(training) · Ad | |
| `training.program_manage` | Manage training programs | Create/update/delete programs | section | Sec(training) · Ad | |
| `training.overview_read` | Read training overview | Org-wide completion dashboard | section | Sec(training) · Ad | |
| `training.assignment_manage` | Manage assignments | Assign, waive, reassign training | section | Sec(training) · Ad | |
| `training.matrix_read` | Read coverage matrix | People × deck coverage grid | section | Sec(training) · Ad | |
| `training.person_read` | Read a person's record | One person's full training record | section | Sec(training) · Ad | |
| `training.archive_read` | Read archived training | Archived assignments/decks | section | Sec(training) · Ad | |
| `training.lead_read` | Read group leads | See the group-lead roster | section | Sec(training) · Ad | |
| `training.lead_manage` | Manage group leads | Assign/remove group leads | section | Sec(training) · Ad | **Meta-permission over `training.team_read`** |
| `training.report_read` | Read training report | View a compliance report | section | Sec(training) · Ad | |
| `training.report_export` | Export training report | Generate/download a report | section | Sec(training) · Ad | |
| `training.snapshot_read` | Read snapshots | List compliance snapshots | section | Sec(training) · Ad | |
| `training.snapshot_create` | Create snapshot | Freeze a compliance snapshot | section | Sec(training) · Ad | |
| `training.snapshot_delete` | Delete snapshot | Remove a snapshot | section | Sec(training) · Ad | |
| `training.audit_package_export` | Export audit package | Produce the evidence bundle | section | Sec(training) · Ad | Highest-sensitivity export in the section |

### 3.12 `announcement` — 3

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `announcement.read` | Read announcements | See announcements on the dashboard | global | V,E,A,Ad | |
| `announcement.dismiss` | Dismiss announcement | Dismiss for yourself | global | V,E,A,Ad | self |
| `announcement.manage` | Manage announcements | Post/edit/expire org-wide announcements with email + chat delivery | section | Sec(announcements) · Ad | High blast radius — reaches every inbox |

### 3.13 `compliance` — 3 · **all EE:policy_ack**

| Key | Label | Description | Scope | Legacy roles |
|---|---|---|---|---|
| `compliance.program_read` | Read compliance program | Acknowledgement progress and outstanding requests | section | Sec(compliance) · Ad |
| `compliance.program_manage` | Run compliance program | Issue requests, send reminders | section | Sec(compliance) · Ad |
| `compliance.export` | Export compliance evidence | Download attestation evidence | section | Sec(compliance) · Ad |

### 3.14 `status` — 3

| Key | Label | Description | Scope | Legacy roles |
|---|---|---|---|---|
| `status.read` | Read status board | View service status and incidents | global | V,E,A,Ad |
| `status.incident_manage` | Manage incidents | Declare, update, resolve incidents (notifies the workspace) | global | A,Ad |
| `status.service_manage` | Manage monitored systems | Add/remove monitored services | global | Ad |

### 3.15 `directory` — 7

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `directory.read` | Read staff directory | Browse the directory | global | V,E,A,Ad | |
| `directory.search` | Search directory | Search people | global | V,E,A,Ad | |
| `directory.photo_read` | Read directory photo | Fetch a person's photo | global | V,E,A,Ad | |
| `directory.person_manage` | Manage people | Create/update/delete directory person records | global | Ad | |
| `directory.field_manage` | Manage directory fields | Define custom directory fields | global | Ad | |
| `directory.print_columns_manage` | Manage print layout | Configure directory print columns | global | Ad | |
| `directory.sync_manage` | Manage directory sync | Configure Graph/directory synchronisation | global | Ad | **EE:directory_sync** |

### 3.16 `link` — 5

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `link.read` | Read quick links | See quick links | global | V,E,A,Ad | Per-link group restriction (`linkVisibleTo`); **admin bypasses** |
| `link.icon_read` | Read link icon | Fetch a link's cached icon | global | V,E,A,Ad | Same per-link restriction |
| `link.favicon_fetch` | Fetch remote favicon | Fetch a remote favicon for previews | global | V,E,A,Ad | SSRF-sensitive; authenticated-only by design |
| `link.manage` | Manage quick links | Create/update/delete quick links and their group restrictions | global | Ad | |
| `link.category_manage` | Manage link categories | Create/rename/delete link categories | global | Ad | |

### 3.17 `user` — 9

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `user.read` | Read users | List user accounts | global | Ad | |
| `user.create` | Create user | Create an account | global | Ad | |
| `user.update_role` | Change a user's role | Assign viewer/editor/approver/admin | global | Ad | **Privilege-granting.** Integrity guard: last active admin cannot be demoted |
| `user.update_status` | Enable/disable a user | Activate or disable an account | global | Ad | Integrity guard: last active admin cannot be disabled |
| `user.reset_password` | Reset a password | Force-reset another user's password and invalidate sessions | global | Ad | Account-takeover-equivalent |
| `user.reset_2fa` | Reset 2FA | Clear another user's TOTP enrolment | global | Ad | Bypasses the second factor |
| `user.delete` | Delete a user | Delete an account | global | Ad | Guards: cannot delete self; cannot delete the last admin |
| `user.link_directory` | Link to directory person | Bind a user account to a directory record | global | Ad | |
| `user.mention_list` | List mentionable users | Read the @-mention candidate list | global | V,E,A,Ad | |

### 3.18 `group` — 5

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `group.read` | Read groups | List groups and members | global | Ad | |
| `group.create` | Create group | Create a group | global | Ad | |
| `group.update` | Rename group | Rename a group | global | Ad | |
| `group.manage_members` | Manage group membership | Add/remove members | global | Ad | **Privilege-granting** — membership drives space read grants, space edit grants, section delegation, and training leadership. Must be classified as sensitive as `user.update_role` |
| `group.delete` | Delete group | Delete a group | global | Ad | Silently orphans section grants (stored as raw ids in JSON, no FK) |

### 3.19 `audit` — 2

| Key | Label | Description | Scope | Legacy roles |
|---|---|---|---|---|
| `audit.read` | Read audit log | Browse the audit trail | global | Ad |
| `audit.export` | Export audit log | Download the audit trail | global | Ad · **EE:audit_export** |

### 3.20 `workspace` — 6

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `workspace.settings_read` | Read workspace settings | Read the settings surface | global | Ad | |
| `workspace.settings_manage` | Change workspace settings | Approval mode, session timeout, nested pages, secure-cookie mode | global | Ad | **Includes `approval_mode` — a meta-permission over `document.publish` for every editor** |
| `workspace.branding_manage` | Manage branding | Upload/remove the workspace logo | global | Ad | |
| `workspace.public_site_manage` | Manage public site | Enable/configure anonymous public access and indexing | global | Ad | **Meta-permission over the entire anonymous surface.** Both settings default OFF |
| `workspace.domain_manage` | Manage custom domain | Set the custom domain (drives TLS provisioning) | global | Ad | |
| `workspace.section_access_manage` | Manage section delegation | Grant/revoke Announcements, Compliance, Training delegation | global | Ad | **Meta-permission over every `Sec` row in this catalog** |

### 3.21 `integration` — 16

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `integration.smtp_read` | Read SMTP config | View mail transport settings | global | Ad | |
| `integration.smtp_manage` | Manage SMTP config | Change SMTP credentials (sealed secrets) | global | Ad | |
| `integration.email_template_read` | Read email templates | View notification templates | global | Ad | |
| `integration.email_template_manage` | Manage email templates | Edit/reset notification templates | global | Ad | |
| `integration.email_test_send` | Send test email | Send a template test message | global | Ad | |
| `integration.webhook_read` | Read webhooks | List outbound webhooks | global | Ad | |
| `integration.webhook_manage` | Manage webhooks | Create/update/delete outbound webhooks | global | Ad | Exfiltration-sensitive |
| `integration.ai_config_read` | Read AI config | View AI provider configuration | global | Ad | |
| `integration.ai_config_manage` | Manage AI config | Change provider and API keys | global | Ad | |
| `integration.chat_ask_read` | Read chat integration | View Slack/Teams ask config | global | Ad | |
| `integration.chat_ask_manage` | Manage chat integration | Enable Slack/Teams ask and its signing secrets | global | Ad | Enables an **unauthenticated, workspace-scoped** answer surface |
| `integration.embeddings_read` | Read index status | Embedding index health | global | Ad | |
| `integration.embeddings_reindex` | Trigger reindex | Rebuild the embedding index | global | Ad | |
| `integration.addin_manifest_read` | Read add-in manifest | Fetch the Office add-in manifest | global | Ad | |
| `integration.backup_destination_read` | Read backup destinations | View configured backup targets | global | Ad | |
| `integration.backup_destination_manage` | Manage backup destinations | Configure off-box backup targets | global | Ad | Exfiltration-sensitive |

### 3.22 `identity` — 8

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `identity.saml_read` | Read SAML config | View SAML settings | global | Ad | **EE:sso** |
| `identity.saml_manage` | Manage SAML | Change identity-provider trust | global | Ad | **EE:sso** — trust-establishing |
| `identity.sso_read` | Read SSO settings | View SSO settings | global | Ad | **EE:sso** |
| `identity.sso_manage` | Manage SSO | Change SSO settings | global | Ad | **EE:sso** |
| `identity.scim_read` | Read SCIM config | View provisioning configuration | global | Ad | **EE:scim** |
| `identity.scim_manage` | Manage SCIM | Change provisioning configuration | global | Ad | **EE:scim** |
| `identity.scim_token_mint` | Mint SCIM token | Issue a provisioning bearer token | global | Ad | **EE:scim** — issues a principal that can write `users.role` |
| `identity.scim_provision` | Provision users (SCIM) | Create/update/deprovision users and groups over SCIM | global | *(SCIM token principal only)* | **EE:scim** — no user, no role; must be represented as its own preset (§5.7) |

### 3.23 `license` — 2

| Key | Label | Description | Scope | Legacy roles |
|---|---|---|---|---|
| `license.read` | Read license | View license state, seats, expiry | global | Ad |
| `license.install` | Install license | Apply a license key — **grants every EE entitlement** | global | Ad |

### 3.24 `system` — 12

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `system.diagnostics_read` | Read diagnostics | Instance diagnostics | global | Ad | |
| `system.version_read` | Read version | Build/version info | global | Ad | |
| `system.update_apply` | Apply update | Trigger an in-place upgrade | global | Ad | |
| `system.migrate_run` | Run migration | Execute a data migration | global | Ad | |
| `system.backup_read` | List backups | Enumerate backups | global | Ad | |
| `system.backup_create` | Create backup | Take a backup | global | Ad | |
| `system.backup_download` | Download backup | Download a backup archive | global | Ad | Whole-workspace data egress |
| `system.backup_delete` | Delete backup | Remove a backup | global | Ad | |
| `system.backup_restore` | Restore backup | Restore the workspace from a backup | global | Ad | Destructive; overwrites all authorization state |
| `system.export` | Export workspace | Full workspace export | global | Ad | Whole-workspace data egress |
| `system.import` | Import workspace | Import content into the workspace | global | Ad | |
| `system.bootstrap` | First-run setup | Create the initial admin account | global | ∅ **while `needsSetup()`**, then permanently closed (409) | The only self-elevating unauthenticated path; time-bounded, not role-bounded |

### 3.25 `template` — 2

| Key | Label | Description | Scope | Legacy roles |
|---|---|---|---|---|
| `template.read` | Use templates | List document templates while authoring | global | E,A,Ad |
| `template.manage` | Manage templates | Create/update/delete document templates | global | Ad |

### 3.26 `account` — 13 (self-service; every authenticated principal)

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `account.profile_manage` | Edit own profile | Name, email, avatar | global | V,E,A,Ad | self |
| `account.preferences_manage` | Edit own preferences | Theme, page width, timezone, date format | global | V,E,A,Ad | self |
| `account.password_change` | Change own password | Set a new password | global | V,E,A,Ad | self — forced when `must_change_password` |
| `account.notification_prefs_read` | Read own notification settings | View notification preferences | global | V,E,A,Ad | self |
| `account.notification_prefs_manage` | Edit own notification settings | Change notification preferences | global | V,E,A,Ad | self |
| `account.twofa_manage` | Manage own 2FA | Enrol/disable TOTP, view recovery codes | global | V,E,A,Ad | self |
| `account.session_read` | List own sessions | See active sessions | global | V,E,A,Ad | self |
| `account.session_revoke` | Revoke own sessions | Sign other devices out | global | V,E,A,Ad | self |
| `account.token_read` | List own API tokens | See personal access tokens | global | V,E,A,Ad | self |
| `account.token_create` | Mint API token | Create a `cdk_` personal access token | global | V,E,A,Ad | self — **the token inherits the full role**; this is a privilege-carrying credential granted to every viewer today |
| `account.token_revoke` | Revoke own API token | Delete a personal access token | global | V,E,A,Ad | self |
| `account.connection_read` | List OAuth connections | See connected OAuth/MCP clients | global | V,E,A,Ad | self |
| `account.connection_revoke` | Revoke OAuth connection | Disconnect a client | global | V,E,A,Ad | self |

### 3.27 `notification` — 2

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `notification.read` | Read notifications | Read your notification feed | global | V,E,A,Ad | self |
| `notification.mark_read` | Mark notifications read | Clear your unread badge | global | V,E,A,Ad | self |

### 3.28 `ui` — 1

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `ui.command_palette` | Use command palette | Bootstrap the palette with recents and the server-computed allowed-command list | global | V,E,A,Ad | **Derived, not granted.** The allow-list is a real security boundary computed from every other permission — regenerate it from the resolved permission set, never author it independently |

### 3.29 `api` — 3

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `api.read` | API read scope | Token may perform read operations on `/api/v1` | global | *(token scope)* | Intersects with — never widens — the owner's permissions. Rate limit 120/min keyed on **user id**, shared across all that user's tokens |
| `api.write` | API write scope | Token may perform mutations on `/api/v1` | global | *(token scope)* | Same intersection rule |
| `mcp.connect` | Connect MCP client | Use the MCP tool surface with an OAuth access token | global | *(OAuth token, 1h)* | Reuses the same `read`/`write` scope split; re-implements the space/publish checks a third time |

### 3.30 `public` — 7 (anonymous; **no principal exists today**)

| Key | Label | Description | Scope | Legacy roles | Conditions |
|---|---|---|---|---|---|
| `public.document_read` | Read public document | Anonymous read of a published doc in a public space | space | ∅ | mode (`public_site_enabled`). Enforced by hardcoded `visibility='public' AND status='published'` SQL, **not** by any guard |
| `public.attachment_read` | Read public attachment | Anonymous attachment download via the public site | space | ∅ | mode |
| `public.search` | Search public site | Anonymous search | global | ∅ | mode; rate-limited |
| `public.indexing` | Allow search indexing | Permit crawlers to index the public site | global | ∅ | mode (`public_site_indexing`, defaults OFF independently) |
| `public.share_read` | Read shared document | Anonymous read of one document via a `/share/<token>` link | *(object)* | ∅ | mode (`shares_enabled`); bearer of the token is the entire authorization |
| `public.share_attachment_read` | Read shared attachment | Anonymous attachment read scoped to exactly the shared document | *(object)* | ∅ | mode |
| `public.diagram_render` | Render diagram | Anonymous PlantUML render | global | ∅ | mode (PlantUML server configured); rate-limited per IP |

> The Slack/Teams ask endpoints are *not* in this family because they authenticate by request signature and answer from a fixed synthetic scope (`chatSpaceScope()` — non-private spaces). They are gated by `integration.chat_ask_manage` at configuration time and by nothing at request time. **Flag for review**: this is the one surface where an answer's grounding scope is decoupled from any principal.

---

## 4. Ordinal-ladder artefacts — where a flat catalog changes behaviour

These are the places where the current model's meaning comes from `ROLE_ORDER.indexOf()` rather than from any explicit grant. A flat catalog that simply lists `Ad` on every row will *look* equivalent but will not be, because the ladder also carries three **bypasses** that are not permissions at all.

### 4.1 Transitive implication (cosmetic, but must be made explicit)

| Artefact | Today | In a flat catalog |
|---|---|---|
| `admin` implies every editor and approver permission | By `indexOf` comparison — never written down anywhere | Must be a wildcard grant or an exhaustively enumerated preset. **If enumerated, every new permission added later silently fails to reach admins.** Recommend a wildcard (`*`) with an explicit deny-list of nothing |
| `approver` implies every editor permission | By `indexOf` | The `approver` preset must include all 40+ editor-tier keys. There is no code path today that grants approver-tier without editor-tier |
| `editor` implies every viewer permission | By `indexOf` | Same |
| An unknown/garbage role string fails every check | Emergent: `indexOf === -1` | Must become an **explicit** fail-closed default. `toSessionUser` passes `role` through unvalidated while defensively coercing `newsletter_role` — SCIM/SAML/OAuth can all write the column |

### 4.2 Admin bypasses — the three that a flat catalog will silently drop

These are the dangerous ones. They are not "admin has permission X"; they are "the permission check does not run for admins".

| Bypass | Site | Consequence if lost |
|---|---|---|
| **Space read scope** — `spaceScopeFor` returns the `"all"` sentinel for admins, short-circuiting before any grant lookup | `access.ts:20` | An admin with no group memberships currently reads every private space. A flat catalog granting `space.read` at `space` scope gives them **nothing**. Admin must hold a wildcard space grant, materialised or virtual |
| **Space edit grants** — `canEditSpace` returns true for admins before consulting `editorsEditAll` or the grant table | `access.ts:49` | Same failure mode for `space.author` |
| **Section delegation** — `canAccessSection` returns true for admins before checking grants | `section-access.ts:63` | Admins lose Announcements/Compliance/Training unless granted per-section |

Additionally, **`approver` does *not* bypass space scope** — `change-requests/[id]/route.ts:40` exists specifically to stop a non-admin approver enumerating CR ids into private spaces. Preserve this asymmetry; it is deliberate.

Two smaller bypasses in the same class: `comment.delete_any` (`gate.role === "admin"`, not `roleAtLeast`) and `link.read` (`user.role !== "admin" && !linkVisibleTo(...)`). Both are written as **equality against `"admin"`**, not ladder comparisons — so they are already flat-catalog-shaped and translate cleanly.

### 4.3 Non-ladder authority that the four roles do not express at all

| Authority | Holder | Note |
|---|---|---|
| Section delegation | Any user with the grant — **including a viewer** | `canAccessSection` has **no role floor**. A viewer with the training grant can manage decks, assignments, and export the audit package |
| Newsletter capability | `users.newsletter_role`, independent of role | A viewer can be a newsletter approver; an admin is one automatically |
| Group leadership | `userLeadGroups` | The **only** grant for `training.team_read`. No role, no section grant, no admin bypass — an admin who leads no groups gets a 403 |
| Token scope | `token_scopes` on the token row | Narrows, never widens |

### 4.4 Permissions whose denial is not a rejection

Flagged separately because a naïve `if (!can(...)) return 403` rewrite changes user-visible behaviour:

| Permission | Denial behaviour today |
|---|---|
| `document.publish` (on create) | Silently saves as a **draft** |
| `document.publish` (on update to live content) | Silently creates a **queued change request** |
| `document.publish` (on merge / version restore into live) | Same |
| `document.publish` (on `document.schedule`) | **403** — the one hard rejection |
| `document.read` / `document.read_draft` | **404**, not 403 (existence hiding) |
| Page-level role denial (`requireRole`) | **redirect to `/`**, not 403 (existence hiding) |
| API role denial (`apiGuard`) | 403 with a single generic message that never names the missing permission |

Recommend the permission API return a three-state result (`allow` / `deny` / `deny_with_fallback`) rather than a boolean, or these behaviours must be re-encoded at all 11 publish sites and ~10 draft-read sites individually.

---

## 5. Built-in preset roles (behaviour-preserving upgrade)

The upgrade is behaviour-preserving **only if all seven preset families below are created and the data migration in §8 runs.** The four legacy roles alone do not reproduce today's behaviour, because four of the five current mechanisms are not roles.

### 5.1 `preset.viewer` — global

`document.read`, `attachment.read`, `comment.{read,create,delete_own}`, `suggestion.create`, `document.{relation_read,dms_link_read,track_view,feedback_vote,ack_submit}`, `space.{read,tree_read,subscribe}`, `search.{query,ai_query}`, `status.read`, `directory.{read,search,photo_read}`, `link.{read,icon_read,favicon_fetch}`, `user.mention_list`, `announcement.{read,dismiss}`, `newsletter.dismiss`, `training.{read_own,progress_own,certificate_read_own}`, `notification.*`, `account.*` (all 13), `ui.command_palette`.

*Note:* `account.token_create` is in the viewer preset today. Every viewer can mint a role-inheriting bearer credential. Preserved for behaviour parity; flagged for a follow-up policy decision.

### 5.2 `preset.editor` — global — includes `preset.viewer`

\+ `document.{read_draft,lookup,create,update,move,reorder,branch,merge,version_read,version_restore,review_manage,delete_draft,restore,relation_manage,dms_link_manage,share_read,share_create,share_revoke,presence}`, `attachment.{upload,delete}`, `ai.{write_assist,proofread}`, `template.read`, `space.author`.

*All space-scoped permissions in this preset are additionally conditional on the space grant materialised in §8.1.*

### 5.3 `preset.approver` — global — includes `preset.editor`

\+ `document.{publish,schedule,delete_published,ack_require,ack_roster_read}`, `change_request.{read,decide}`, `suggestion.review`, `analytics.{read,document_read}`, `status.incident_manage`.

`document.publish` must be marked **conditional** in this preset's definition so that the `approval_mode=open` variant (§5.8) can grant it to editors without duplicating the whole preset.

### 5.4 `preset.admin` — global — **wildcard**

Everything, expressed as `*` — **not** as an enumeration — plus three explicit bypass grants that are not permissions:

- `space.*` at **wildcard space scope** (reproduces the `SpaceScope = "all"` sentinel)
- `section.*` at **wildcard section scope** (reproduces `canAccessSection`'s admin short-circuit)
- `newsletter.*` unconditionally (reproduces `canUseNewsletter`'s admin arm)

Integrity constraints that survive as code, not permissions: last-active-admin cannot be demoted, disabled, or deleted; no one may delete their own account.

### 5.5 Space-scoped presets (materialised from today's grant tables)

| Preset | Reproduces | Contents |
|---|---|---|
| `preset.space_reader` | `spaces.visibility` + `space_groups` | `space.read`, `space.tree_read`, `document.read`, `attachment.read`, `comment.*`, `suggestion.create`, `document.{feedback_vote,track_view,relation_read,dms_link_read,ack_submit}`, `space.subscribe` |
| `preset.space_author` | `space_editors` + `space_editor_groups` (+ `editors_edit_all`) | `space.author` and every space-scoped key in `preset.editor` |
| `preset.space_admin` | **does not exist today** | Reserved. `space.manage_members` + `comment.delete_any` at space scope are the two obvious members. Ship the key, grant it to nobody, so the ladder's "non-comparable role" gap has a landing spot |

### 5.6 Section presets

`preset.announcements_manager` → `announcement.manage`
`preset.compliance_manager` → `compliance.{program_read,program_manage,export}`
`preset.training_manager` → all 22 `training.*` **except** the three `*_own` keys
`preset.team_lead` → `training.team_read` only (bound to `userLeadGroups`, not to a section grant)

### 5.7 Non-user principal presets

`preset.newsletter_contributor` → `newsletter.{use,read,create,edit_content,submit,comment,delete,manage_approvers,asset_upload,file_read,file_manage,send_test}` — all author- and status-conditioned
`preset.newsletter_approver` → the above + `newsletter.{read_all,decide,schedule,send}`
`preset.anonymous` → `public.*` (7 keys), all mode-gated
`preset.scim_provisioner` → `identity.scim_provision` **only**
`preset.chat_integration` → `search.ai_query` bounded to `chatSpaceScope()`
`preset.api_token_read` / `preset.api_token_write` → `api.read` / `api.write`, **intersected** with the owner's effective permission set

### 5.8 Mode-conditional grant (not a preset)

```
grant document.publish to preset.editor when setting.approval_mode == "open"
```

This is the only dynamic role→permission binding in the system. Modelling it as a static preset variant (`preset.editor_open`) would work but would require re-binding every editor on a settings change; a conditional grant evaluated at check time preserves today's semantics exactly, including the fact that flipping `approval_mode` takes effect on the very next request.

---

## 6. Enterprise entitlement gating

`featureEnabled(f)` = **EE code present in this build** AND **valid license grants `f`**. It is an independent axis: `permission AND entitlement`. It never grants and must never be folded into a permission key.

| Entitlement | Permissions gated | Count |
|---|---|---|
| `training` | all `training.*` | 22 |
| `policy_ack` | `document.{ack_submit,ack_require,ack_roster_read}`, `compliance.*` | 6 |
| `sso` | `identity.{saml_read,saml_manage,sso_read,sso_manage}` | 4 |
| `scim` | `identity.{scim_read,scim_manage,scim_token_mint,scim_provision}` | 4 |
| `audit_export` | `audit.export` | 1 |
| `directory_sync` | `directory.sync_manage` | 1 |
| `priority_support` | *(no code gate — marketing entitlement only)* | 0 |

**38 of 209 keys are enterprise-gated.** Denial returns **402**, distinct from 403 — preserve this, it is how the UI distinguishes "not licensed" from "not permitted".

License state is itself a gate: `licenseGrants` returns true only for `active` and `grace`. An expired license revokes 38 permissions atomically without touching any role assignment — a behaviour a naïve RBAC implementation would break by baking entitlements into presets.

**EE overlay caveat:** per CLAUDE.md, `ee/` feature-list changes ship from the **compassdocs-ee overlay repo**, which is overlaid at image build. This catalog covers core's enforcement of the entitlements only; the overlay may add guards this map cannot see. Confirm before freezing the contract.

---

## 7. Contract decisions this catalog forces

### 7.1 `document.publish` is conditional and has a fallback
See §4.4 and §5.8. Eleven verbatim duplications of `roleAtLeast(user.role,"approver") || (await getApprovalMode())==="open"` collapse to one permission — but only if the check API can express "denied, take path B".

### 7.2 Read and write must stay two checks, or the collapsed check must fold visibility in
`canEditSpace` is documented as visibility-blind (`access.ts:43`). A single `can(user, 'space.author', spaceId)` that does not internally verify `space.read` is **strictly more permissive** than today's two-step and will ship the §9.1 bug everywhere.

### 7.3 Freshness vs. staleness
Every check today is a live DB read; a revoked grant takes effect on the next request. Role is also fresh (the sliding-window session read re-reads the user row each request). Putting a resolved permission set on the session inverts `nav-capabilities.ts:3-7` and introduces staleness the current model does not have. Either preserve per-request resolution, or document the staleness window explicitly and add an invalidation path for `group.manage_members`, `user.update_role`, and `space.manage_members`.

### 7.4 The `gate` return type
`SessionUser | NextResponse` is narrowed at 209 sites; 186 bind `const gate = await apiGuard(`. Keep `apiGuard`'s shape and add a parallel `apiGuardP(permission, scopeRef?)` so both can coexist during migration. If the return becomes `{user, permissions}`, every route body that passes `gate` into a db function must also change.

### 7.5 Token scopes vs. permissions
`api.read`/`api.write` currently *intersect* with the owner's role — "a token can never see or do more than its user" (`v1-auth.ts:4-6`). If scopes become permission-shaped, decide explicitly whether they intersect (safe, preserves the invariant) or replace (lets a token exceed its owner in principle). Recommend **intersect**, and state it in the catalog as a hard invariant.

### 7.6 `ui.command_palette` must be derived
`allowedCommandIds` is a real security boundary, not cosmetics. `CapKey` (`nav-items.ts:24-32`) and the 8-boolean `NavCapabilities` struct are consumed by the `NAV_ITEMS` and `PALETTE_COMMANDS` config tables — regenerate the struct from the permission set; renaming the booleans is a breaking change to those tables.

---

## 8. Data migration required for behaviour preservation

### 8.1 Default-open space edit grants — **blocker**
`editors_edit_all` defaults **on** (any setting value ≠ `"0"`), and a space with **zero** editor grants is treated as unrestricted. A default-deny grant model will lock out every editor on every existing space on upgrade.

Required: either materialise today's implicit grants (for every space with no rows in `space_editors`/`space_editor_groups`, grant `preset.space_author` to every editor+ user — or to a synthetic "all editors" principal), **or** preserve an `unrestricted` boolean per space that the check honours. The synthetic-principal option is preferable: it keeps the migration O(spaces) instead of O(spaces × users) and stays correct as users are added.

### 8.2 Section grants have no referential integrity
`section_access_<section>` is JSON in the `settings` table. Deleted users and groups linger as stale ids and are silently dropped by the `ids()` coercion. Migrating to real rows will **change behaviour** for any workspace with stale ids — it will surface grants that are currently inert only because the coercion drops them, or drop grants an admin believes exist. Audit and report before migrating; do not migrate silently.

### 8.3 Three parallel role enumerations
`ROLE_ORDER` (a mutable `Role[]`, not `readonly`), `ROLE_LABEL`, `ROLE_BLURB` must stay in sync. Collapsing these into one role-definition table is a cheap, zero-guard-touching first step.

### 8.4 The `SpaceScope = "all" | number[]` sentinel
Highest-fanout type in the access layer; every `db.ts` consumer (`listSpaces`, search, document listing, digest, backlinks, analytics) branches on `scope === "all"`. Enumerate all consumers before replacing the sentinel with a predicate or wildcard.

---

## 9. Defects surfaced while building this catalog

### 9.1 `document.share_*` — live scope bypass (**high**)
`src/app/api/documents/[id]/share/route.ts:17-34` calls `canEditSpace(user, doc.space_id)` with **no** preceding `scopeAllows(spaceScopeFor(user), doc.space_id)`. Its siblings `move/route.ts:23-25` and `review/route.ts:19-21` both carry the comment explaining why that pre-check is mandatory. Because `editors_edit_all` defaults on, `canEditSpace` returns true for any editor on any space id. Consequence: **any editor can enumerate document ids and mint an anonymous public share link to a document in a private space they cannot read in-app** — and the share token additionally unlocks that document's attachments to anonymous callers (`attachments/[id]/route.ts:44-50`). Fix independently of the RBAC work; do not let it ride the migration.

### 9.2 `document.restore` — same missing pre-check (**medium**)
`src/app/api/trash/[id]/route.ts:11-24`. Allows restoring a document into an out-of-scope private space. Lower impact — exposes no content — but the same one-line fix.

### 9.3 `showTraining` nav inconsistency (**low, now resolved as a nav-only bug**)
`nav-capabilities.ts:46` gates the Training nav item on `featureEnabled("training")` alone, while every training page and API **does** enforce `canAccessSection(user,"training")` (verified: `training/{page,archived,preview/[id],person/[id]}`, `certificate/[id]` self-or-grant, all `sectionApiGuard("training")` routes). So the section grant is **not** dead config — the nav item is merely over-offered, walking ungranted users into a 404. Fix the nav check to `featureEnabled && canAccessSection`; do not "resolve" it by loosening the pages.

---

## 10. Open items before this contract can be frozen

1. **EE overlay surface.** Does the compassdocs-ee overlay add roles, permissions, or guards not visible in core? The image build overlays that repo's `ee/` — this catalog is core-only.
2. **MCP scope model.** `src/app/api/mcp/route.ts` re-implements `roleAtLeast` + `spaceScopeFor` + `canEditSpace` + `getApprovalMode` a third time and re-checks `token_scopes` at line 924. Confirm whether MCP scopes are the same two-value vocabulary as `/api/v1` or diverge.
3. **Chat-ask grounding scope.** `chatAnswer` answers with no user principal, bounded only by `chatSpaceScope()`. Confirm that scope excludes private *and* draft content, and decide whether it becomes a real preset principal (§5.7) or stays out of the model.
4. **`account.token_create` for viewers.** Preserved for parity, but every viewer minting a role-inheriting bearer credential deserves an explicit policy decision, not an inherited default.
5. **`identity.scim_provision` write path.** SCIM writes `users.role` (and potentially `newsletter_role`) directly. Confirm whether SCIM group mapping should drive the new role/permission bindings, and what happens to a SCIM-provisioned user whose mapped preset no longer exists.
6. **`apiGuard()`'s bare default.** `min: Role = "viewer"` means "any authenticated active user". In a permission model this needs an explicit name (e.g. an `authenticated` guard) rather than a defaulted permission argument. Audit the bare call sites before removing the default.