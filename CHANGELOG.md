# Changelog

All notable changes to CompassDocs are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/).

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

[0.3.1]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.1
[0.3.0]: https://github.com/mattny20/CompassDocs/releases/tag/v0.3.0
