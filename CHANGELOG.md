# Changelog

All notable changes to CompassDocs are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/).

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

[0.3.4]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.4
[0.3.2]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.2
[0.3.1]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.1
[0.3.0]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.0
