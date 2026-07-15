# Changelog

All notable changes to CompassDocs are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/).

## [0.19.0] - 2026-07-15

### Added
- **The people directory joins the Ask feature.** Questions like "who is the
  head of IT?" or "who handles payroll?" now surface matching people —
  name, title, department, and contact details — alongside document answers.
  With an AI key configured the model cites directory facts as [Directory];
  in keyword mode the people appear as cards. Matches link to their profile.
- **Person profile pages.** Every directory entry gets a profile at
  `/directory/{id}` — photo, title, department, contact links, office,
  assistant, and custom fields — plus **Documents by {name}**: everything
  they've authored, filtered to the spaces *you* can see. Names throughout
  the directory (table, cards, and department views) now link to profiles.

## [0.18.0] - 2026-07-15

### Added
- **Workspace accent color.** Settings → Workspace → Branding gains an accent
  picker (nine presets plus any custom hex). One color re-tints the entire
  product — buttons, links, focus rings, highlights, and tinted surfaces, in
  light and dark themes, on the login page, and on the public site. The full
  color ramp is derived automatically from your single brand color.
- **A real icon picker for spaces.** The 12-emoji row becomes a searchable,
  categorized catalog of ~90 icons (General & docs, Tech & engineering,
  Business & sales, People & culture, Security & operations, Places & misc) —
  type "security" or "training" to find the right one. Any emoji can still be
  typed or pasted by hand.
- **"Ask CompassDocs" now carries your name**: the sidebar entry, the Ask
  page heading, and the dashboard link all say "Ask {your workspace name}"
  (from Settings → Workspace).

## [0.17.1] - 2026-07-15

### Fixed
- **Moving a document between spaces now works.** Changing the Space in the
  editor and saving was silently ignored — the update API never read the new
  space. Moves now apply immediately for approvers/admins (and in open
  approval mode); an editor's move of a published doc in strict mode rides
  along with their change request, applies on approval, and the review queue
  shows a "→ moves to …" badge so approvers see it. The target space must be
  one the editor can see, and moving a doc out of a Public space immediately
  removes it from the public site.

## [0.17.0] - 2026-07-15

### Added
- **Print / Save as PDF.** Every document page — in the app and on the public
  site — gains a **Print / PDF** button that opens the browser's print
  dialog, where "Save as PDF" is built in on every platform. Print
  stylesheets strip the app chrome (sidebar, buttons, breadcrumbs,
  suggestion box) so the output is a clean document: badges, title, byline,
  and content, with images and code blocks kept whole across page breaks.

## [0.16.0] - 2026-07-15

### Added
- **Image sizing.** Select an image in the rich-text editor and pick
  S / M / L / Full from the toolbar (25/50/75/100% of the text column). The
  size travels as a `"w=NN%"` title in standard markdown —
  `![shot](url "w=50%")` — so it renders consistently in the editor, the
  preview, the document page, and the public site, and can be typed by hand
  in the Markdown tab.
- **Click to zoom.** Images on document pages (app and public site) open in a
  full-screen lightbox on click; Esc or another click closes it.
- **Adjustable page width.** Document pages and the editor gain a
  Normal / Wide / Full width toggle (top right). The choice is per-person,
  remembered in the browser, and shared between reading and editing.
- **Alt text for images.** Select an image and click **Alt** in the toolbar
  to describe it for screen readers (and for when the image can't load). The
  description is stored as the markdown alt — `![description](url)` — and can
  also be edited directly in the Markdown tab.
- The rich-text editor toolbar now uses the app's icon set instead of
  emoji/ASCII labels.

### Changed
- **Copy link** on an attachment now copies a plain URL instead of a
  markdown snippet — embedding an image in the doc is done by pasting it
  straight into the editor.

## [0.15.0] - 2026-07-15

### Added
- **Inline images in documents.** Paste a screenshot (or drag one in, or use
  the new 🖼️ toolbar button) in either editor mode and it lands right at the
  cursor — write a step, paste the screenshot, write the next step. The image
  uploads as a document attachment behind the scenes (stored as standard
  markdown `![alt](/api/attachments/…)`), renders in the rich editor, the
  preview, the document page, and the anonymous public site, and respects the
  existing attachment size limit. Starting a brand-new document? The first
  pasted image quietly saves a draft so it has a document to attach to — you
  keep editing and save as usual.

### Fixed
- The attachment **upload** endpoint now enforces space access like every
  other document route — an editor can no longer upload files to a document
  in a private space they can't see.

## [0.14.0] - 2026-07-15

### Added
- **Public site — share spaces with the world, no login.** Space visibility
  now has three tiers: **Public** (anyone on the internet), **Internal**
  (everyone signed in — the default; existing spaces migrate here
  automatically), and **Private** (granted groups). A new anonymous,
  read-only site at `/public` serves the *published* documents of Public
  spaces: a branded landing page, per-space article lists, full document
  rendering with attachments, and rate-limited full-text search scoped to
  public content only. Drafts, suggestions, internal/private spaces, AI
  answers, the API, and the Claude connector all stay behind the login.
- **Settings → Public site**: master switch (off by default — nothing is
  exposed until an admin turns it on; when off every `/public` page 404s
  and public attachments stop serving) and a **search-engine indexing**
  toggle (off = `noindex`, reachable only by link).
- The review queue badges change requests that target a Public space
  ("🌐 Goes public") so approvers know a change lands on the open internet.
- The space editor warns and asks for confirmation before a space is made
  Public.

### Fixed
- Search-result snippets now HTML-escape document text before highlighting,
  so raw HTML in a document body can't be injected into the search page
  (internal search and the new public search both).

## [0.13.0] - 2026-07-15

### Added
- **Private spaces.** Settings → Spaces now has a *Who can see it* control:
  **Public** (everyone signed in — the default, and how every existing space
  keeps behaving) or **Private** (admins plus granted groups only). Private
  spaces vanish for everyone else across the whole product — sidebar,
  dashboard, space/document pages, version history, full-text search, AI
  answers, attachments, the REST API, and the Claude connector all resolve
  the signed-in user's space scope server-side and return 404s that don't
  even leak the space's name.
- **User groups** (Settings → Groups): named sets of users you can grant on
  any number of private spaces. Create/rename/delete groups and manage
  members by hand; every change is audited.
- **Microsoft Entra group sync** *(enterprise, Microsoft 365 directory sync
  entitlement)*: browse the tenant's security groups, import the ones you
  want, and keep membership mirrored with **Sync now**. Members are matched
  to CompassDocs accounts by SSO identity first, then email; group renames in
  the tenant propagate; removing someone in Entra revokes their space access
  on the next sync. Reuses the Settings → Directory app registration
  (GroupMember.Read.All — the one-click setup already grants it).

## [0.12.0] - 2026-07-15

### Added
- **Email alerts (SMTP).** Settings → Notifications gains an **Email (SMTP)**
  section — host/port/encryption/credentials (password write-only), from
  address, and a send-test-email button. Any relay works (Microsoft 365,
  Google Workspace, SES, Postmark, self-hosted). Add an *Email* channel with
  comma-separated recipients and it behaves like every other channel: same
  events, same space scoping, same Test button and delivery status.
- **Two new notification events**: **Document published** (direct publishes
  from the app or the Claude connector) and **Suggestion left** (reader
  feedback, with a preview of the suggestion text).
- **Per-space channel scoping**: each notification channel can be limited to
  specific spaces — leave unchecked for all. #engineering only hears about
  Engineering docs.

## [0.11.0] - 2026-07-15

### Added
- **Chat notifications for the approval workflow.** Settings → Notifications
  lets admins register outgoing webhooks — **Webex**, **Microsoft Teams**
  (Workflows / Adaptive Cards), **Slack**, or generic JSON — for change
  submitted / approved / rejected events, with per-event subscriptions, a Test
  button, and last-delivery status per hook. Deliveries are fired in the
  background and never slow down a save; webhook URLs are stored write-only.
  Notifications fire from the app UI and the Claude connector alike.

## [0.10.2] - 2026-07-14

### Fixed
- **Domain & HTTPS pushes were still rejected (403) even after 0.10.1.** Root
  cause found by reproducing against a real Caddy: Node's fetch marks every
  request `Sec-Fetch-Mode: cors`, so Caddy's admin API demands an allowed
  `Origin` header — and a bare admin config only accepts its own listen
  address. The app now sends `Origin: http://0.0.0.0:2019` (derived from the
  admin URL, with a fallback), which is accepted by old *and* new configs —
  existing installs self-heal on upgrade with no Caddyfile or volume surgery.

### Added
- **TLS smoke test in CI**: every change to the deploy files, Caddy
  integration, or Dockerfile now boots the real HTTPS stack and walks the full
  flow — setup → login → save a domain (internal CA) → assert the config push
  applied and HTTPS actually serves the app, with a clean Caddy admin log.

## [0.10.1] - 2026-07-14

### Fixed
- **Domain & HTTPS settings never reached the reverse proxy.** Caddy's admin
  API rejects requests whose Host isn't in its allowed origins, and ours only
  allowed the listen address — so every config push from the app (Host
  `caddy:2019`) got a 403 and saving a domain silently did nothing. Both the
  bootstrap Caddyfile and the app-generated config now allow `caddy:2019`.
  Existing HTTPS installs: re-download the Caddyfile
  (`curl -fsSL https://raw.githubusercontent.com/mattny20/CompassDocs/main/deploy/Caddyfile -o Caddyfile`),
  pull the new image, then `docker compose up -d --force-recreate caddy` and
  re-save your domain settings.

## [0.10.0] - 2026-07-14

### Added
- **One-click Deploy to Azure.** A "Deploy to Azure" button (README and docs)
  opens a guided portal wizard that launches the full stack — app, Postgres,
  optional Caddy HTTPS — on an Ubuntu VM via Docker Compose. Fully
  configurable: any VM size (native size picker), new or existing virtual
  network, public IP new/existing/none with a DNS label, separate SSH/web CIDR
  allowlists, OS disk type/size, an optional dedicated data disk (formatted
  and mounted as Docker's data root on first boot), edition + license key,
  HTTPS on/off, headless admin bootstrap, and an Anthropic API key. Templates
  live in `deploy/azure/`.

## [0.9.3] - 2026-07-14

### Fixed
- **HTTPS (Caddy) deployments failed to start** with `exec: "run": executable
  file not found in $PATH` — the TLS compose files overrode the Caddy image's
  command without naming the binary. Both TLS compose files now use
  `["caddy", "run", …]`. Existing installs: re-download the compose file (or
  edit the caddy `command:` to start with `"caddy"`), then
  `docker compose up -d`.

## [0.9.2] - 2026-07-14

### Fixed
- **Settings → System showed a stale version** (stuck at 0.5.2) because
  releases since then never bumped `package.json` — the number the app
  displays. The version is bumped again with every release from now on, and
  the release workflow refuses to tag a release whose version doesn't match
  `package.json`, so it can't silently drift again.

## [0.9.1] - 2026-07-14

### Added
- **"Connect Claude — one click" card** on the API tokens page: shows your
  instance's MCP URL with a copy button and the three steps to add it as a
  custom connector in Claude — no docs required.

## [0.9.0] - 2026-07-14

### Added
- **Two-factor authentication (TOTP).** Any user can add an authenticator-app
  code to their password sign-in under *your name → Security*: scan the QR,
  confirm a live code (so a bad scan can't lock you out), save eight one-time
  recovery codes. Password logins then require the current code — or a
  recovery code — after the password. Admins get a **Reset 2FA** escape hatch
  in Users & roles for lost devices; everything lands in the audit log. SSO
  users keep getting MFA from their identity provider.
- **Active sessions.** The Security page lists every signed-in device
  (browser/OS, IP, sign-in time, current device highlighted) with per-device
  **Sign out** and **Sign out everywhere else**.

## [0.8.0] - 2026-07-14

### Added
- **One-click Claude connect.** CompassDocs now ships its own OAuth 2.1
  authorization server for the MCP connector: discovery metadata, dynamic
  client registration, a browser consent screen ("Claude wants to connect →
  Approve"), PKCE-verified token issuance, and rotating refresh tokens. In
  Claude (desktop or claude.ai), just add `https://your-host/api/mcp` as a
  custom connector and click Connect — no tokens to copy, no config files.
  Personal API tokens keep working for clients without the OAuth flow.
- **Connected apps** on the API tokens page: see every app you've approved
  (with last-used times) and disconnect any of them instantly.
- The login page now supports a safe `next` redirect, so the consent flow
  returns you to the approval screen after signing in.

## [0.7.0] - 2026-07-14

### Added
- **Claude connector (MCP).** CompassDocs now ships a built-in MCP server at
  `/api/mcp`. Connect it to the Claude desktop app and Claude can search your
  knowledge base, read documents, draft new articles straight into CompassDocs
  as markdown, and revise existing ones — acting as you, with your role. Edits
  to published documents follow the approval workflow (queued as change
  requests when review is required), and every action is audit-logged.
  Available in every edition.
- **Personal API tokens.** Each user can mint and revoke tokens under
  *your name → API tokens* (`/account/tokens`). Tokens are shown once, stored
  hashed, display last-used times, and the page generates a ready-to-paste
  Claude Desktop config.
- **Run blocks.** Fenced code blocks now render with a header bar — language
  label and one-click **Copy**. Shell-flavored blocks (```bash, ```sh,
  ```powershell, ```run, …) get terminal styling with a **Copy commands**
  button, built for runbooks. Presentation only; nothing executes.

## [0.6.2] - 2026-07-14

### Added
- **One-click setup for the Microsoft 365 directory sync** *(Enterprise)*:
  the same "Set up automatically with Microsoft" flow as SSO, now on
  Settings → Directory. One tenant-admin sign-in creates the app registration
  with the `User.Read.All` and `GroupMember.Read.All` application permissions,
  **grants admin consent**, mints a 24-month secret, and fills in the sync
  configuration — then "Sync now" runs the first import.
- The directory sync panel also shows its client secret's expiry date.

## [0.6.1] - 2026-07-14

### Added
- **One-click SSO setup** *(Enterprise)*: a "Set up automatically with
  Microsoft" button on Settings → Single sign-on. Sign in once as a tenant
  admin (device code — no pre-existing app registration needed) and CompassDocs
  creates the Entra app registration with the right redirect URI, a 24-month
  client secret, and the service principal, then fills in and enables the
  configuration. The one-time token is discarded; no standing Microsoft
  permission is kept. Manual entry still works as before.
- The SSO panel now shows the stored client secret's expiry date when known.

## [0.6.0] - 2026-07-14

### Added — single sign-on (Enterprise)
- **Sign in with Microsoft.** With the `sso` entitlement, the login page gains
  a Microsoft Entra ID sign-in button (OpenID Connect authorization code +
  PKCE, full ID-token validation). Accounts are matched by directory identity,
  linked by email to existing users, or auto-provisioned with a role you
  choose.
- **Settings → Single sign-on**: tenant/client credentials (secret is
  write-only), auto-provisioning with a default role, an email-domain
  allowlist, an SSO-only mode that hides the password form (with a documented
  break-glass path), and a test sign-in button.
- **Works beyond Entra**: an advanced custom-authority setting points the same
  flow at any OIDC provider (Okta, Auth0, …).
- SSO activity lands in the audit log: `auth.sso_login`,
  `user.sso_provisioned`, `settings.sso`.

## [0.5.2] - 2026-07-13

### Added
- **Collapsible sidebar.** A toggle at the top of the left navigation collapses
  it to a slim icon-only rail — every destination stays one click away (with
  tooltips, and a dot in place of numeric badges) while documents and the
  directory get the extra width. Expanding restores the full layout, and the
  choice is remembered per browser.

## [0.5.1] - 2026-07-13

### Changed
- **Crisp SVG icons replace emoji in the UI chrome.** The sidebar, settings
  navigation, and the directory's view switcher / contact rows now use a
  consistent line-icon set (Lucide) instead of emoji — sharper, uniform across
  platforms, and aligned with the brand. User-chosen emoji (like space icons)
  are untouched.

## [0.5.0] - 2026-07-13

### Added — directory v2
- **Multiple views**: Cards, a sortable **List** (click a column header to
  sort), and **Departments** (grouped). The choice is remembered per browser.
- **Column chooser** for the list view — pick exactly which columns you see,
  including custom fields; preferences persist per browser.
- **Assistant links**: connect a person to their assistant; shown on cards and
  as an optional list column.
- **Custom fields**: admins define extra fields (cost center, pronouns,
  extension, …) that appear in the column picker, optionally on cards, and are
  editable per person.
- **Custom-field Graph mappings** *(Enterprise)*: map any custom field to any
  Microsoft Graph user property — including the Exchange custom attributes
  (`onPremisesExtensionAttributes.extensionAttribute1–15`) — and the Microsoft
  365 sync fills it automatically. Manual values for unmapped fields survive
  syncs.

## [0.4.0] - 2026-07-13

### Added
- **People directory.** A new **Directory** page (📇 in the sidebar) gives every
  signed-in user a searchable phone/people directory — name, title, department,
  email, phones, office — with department filtering and profile photos. Admins
  manage entries under **Settings → Directory** (add, edit, hide, remove).
- **Microsoft 365 directory sync** *(Enterprise)*. Connect a Microsoft Entra
  tenant (app registration with admin-consented `User.Read.All`) and the
  directory fills itself: users, titles, departments, phones, and profile
  photos, synced on demand. Junk-account controls included — guests excluded by
  default, optional require-title/require-phone filters, and optional scoping to
  a single Entra group. Requires the new `directory_sync` license entitlement.

## [0.3.5] - 2026-07-13

### Added
- **Anthropic API key in the setup wizard.** Optionally enter the AI key during
  first-run setup to enable AI answers and proofreading immediately — same
  write-only store as **Settings → AI**, where it can be changed later.
- **Update from a source tarball (manual installs).** The **Version & updates**
  panel now shows tarball-based update steps and a direct download link for
  installs running without Docker, using each release's source `tar.gz`.

## [0.3.4] - 2026-07-13

A first-run-experience release: install, activate a license, and set up your
domain + HTTPS entirely from the one-line installer and the setup wizard.

### Added
- **Domain & HTTPS in the setup wizard.** When CompassDocs runs behind its
  bundled Caddy reverse proxy, the first-run wizard now lets you enter your
  domain and pick an HTTPS mode — **Automatic** (Let's Encrypt, public DNS),
  **Self-signed** (internal CA, for LAN / internal DNS), or **Off** — and applies
  it to the proxy immediately. No separate trip to Settings required.
- **One-command HTTPS install.** Pass `COMPASSDOCS_TLS=1` to the installer to
  bring up CompassDocs behind Caddy on ports 80/443 (community and enterprise):
  ```
  curl -fsSL .../install.sh | COMPASSDOCS_EDITION=enterprise COMPASSDOCS_TLS=1 bash
  ```
  New `deploy/docker-compose.tls.ee.yml` provides the enterprise HTTPS stack.
- **Apply an Enterprise license during first-run setup.** The setup wizard (on
  Enterprise builds) has an optional license-key field, so a customer can
  activate Enterprise features right after install — the plain one-line installer
  is all that's needed. The key is validated before the admin account is created.

### Changed
- **Session cookie security is now automatic.** A new `secure_cookies` setting
  (**auto** / always / never) replaces the manual `COMPASSDOCS_INSECURE_COOKIES`
  toggle as the primary control. In the default **auto** mode, the login cookie
  is marked `Secure` over HTTPS and left un-Secure over plain HTTP — matching how
  each request arrives — so a plain-HTTP install no longer hits a login loop with
  no configuration. Choose it in the **setup wizard**, and switch to **Always
  require HTTPS** later under **Settings → Domain & HTTPS** once your certificate
  is installed. `COMPASSDOCS_INSECURE_COOKIES=1` still works (forces insecure in
  auto mode).

## [0.3.2] - 2026-07-13

### Fixed
- **Login loop on plain-HTTP deployments.** Session cookies are `Secure` in
  production, which browsers won't send back over `http://` — so an install
  served at `http://host:3000` bounced every request back to the login page.
  Serving over HTTPS remains the recommendation; for intentional plain-HTTP
  setups (internal LAN/VPN, or a TLS-terminating proxy the app can't detect),
  set **`COMPASSDOCS_INSECURE_COOKIES=1`** to drop the `Secure` flag. Default
  behavior is unchanged (Secure in production).

## [0.3.1] - 2026-07-13

### Enterprise licensing (open-core)
- **License settings page** (Settings → License) showing whether the running
  build is Community or Enterprise, and the status of any applied license key.
- **Offline license verification** — Enterprise licenses are Ed25519-signed
  tokens verified locally against a built-in public key. No license server and
  no phone-home; works air-gapped, with a 14-day grace period past expiry.
- **Open-core edition system** groundwork: enterprise features (SSO, SCIM,
  audit-log export, priority support) are gated by *both* the build and the
  license. The Community edition is unaffected and fully functional on its own.
- Embedded the production license-signing public key.

### Notes
- Enterprise feature implementations ship in the separate Enterprise build; this
  release provides the core-side licensing framework they plug into.

## [0.3.0] - 2026-07-13

The first public release of CompassDocs — an open-source team knowledge platform
for SOPs, technical docs, and policies, with AI-powered search, roles, and an
approval workflow. Self-hosted, AGPL-3.0.

### Knowledge & authoring
- **Spaces** to organize documents by team, product, or topic — create, edit,
  and manage them from the admin console.
- **Four document types** (SOP, technical, policy, how-to) with tags, summaries,
  and per-space browsing.
- **Rich-text editor** (WYSIWYG) with a formatting toolbar, plus a raw Markdown
  mode and live preview — both edit the same document.
- **AI proofreading** for grammar, spelling, and clarity, with apply-or-dismiss
  suggestions.
- **Full-text search** with keyword highlighting and a ⌘K quick-search.
- **Ask CompassDocs** — AI answers grounded in your own documents, with inline
  citations. Falls back to keyword search when no API key is set.
- **Version history** — every change is snapshotted and attributed.
- **Attachments** and inline images, with a configurable size limit.
- **Import & export** the whole knowledge base as front-matter Markdown.

### Governance
- **Roles** — Viewer, Editor, Approver, Admin — with a last-admin guard.
- **Approval workflow** — strict (review-required) or open publishing, with a
  review queue for change requests and suggestions.
- **Trash & retention** — soft-delete with restore and a configurable
  auto-purge window.
- **Audit log** — an append-only record of security- and content-significant
  actions (auth, users, content, settings, backups); secrets are never logged.

### Administration
- **Settings console** — branding, timezone, date/time formats, light/dark/auto
  theme, idle session timeout, and more.
- **AI configuration** — set the Anthropic API key (validated on save) and model
  from the UI.
- **Custom domain & HTTPS** — a bundled Caddy proxy with automatic Let's Encrypt,
  self-signed, or bring-your-own certificates, configured from the console.
- **Backups & restore** — scheduled full-database backups with retention and
  one-click restore, mirrored off-site to S3-compatible storage or Azure Blob.
- **System page** — version, database, storage, and resource usage at a glance.
- **Update checker** — see when a newer release is available, with the upgrade
  command.

### Deployment
- **One-command Docker install** with a browser-based first-run setup wizard.
- **Multi-arch images** (linux/amd64 and linux/arm64), published to
  `ghcr.io/mattny20/compassdocs`.
- **PostgreSQL** storage; the app migrates its own schema on start.
- Also runs manually with Node.js 20+ and PostgreSQL 14+.

[0.5.2]: https://github.com/mattny20/CompassDocs/releases/tag/v0.5.2
[0.5.1]: https://github.com/mattny20/CompassDocs/releases/tag/v0.5.1
[0.5.0]: https://github.com/mattny20/CompassDocs/releases/tag/v0.5.0
[0.4.0]: https://github.com/mattny20/CompassDocs/releases/tag/v0.4.0
[0.3.5]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.5
[0.3.4]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.4
[0.3.2]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.2
[0.3.1]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.1
[0.3.0]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.0
