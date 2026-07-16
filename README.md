<div align="center">

# 🧭 CompassDocs

**The open-source, self-hosted team knowledge base.**

Write, organize, and search SOPs, technical docs, and policies — with AI answers
grounded in your own documents, a people directory, and an approval workflow.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-orange)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/mattny20/CompassDocs)](https://github.com/mattny20/CompassDocs/releases)
[![Docker image](https://img.shields.io/badge/ghcr.io-mattny20%2Fcompassdocs-blue?logo=docker)](https://github.com/mattny20/CompassDocs/pkgs/container/compassdocs)
![Next.js](https://img.shields.io/badge/Next.js-15-black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-blue)

[Website](https://compassdocs.io) · [Documentation](https://docs.compassdocs.io) · [Features](https://compassdocs.io/features) · [Pricing](https://compassdocs.io/pricing) · [Quick start](#self-hosting-one-command)

<img src="https://compassdocs.io/img/dashboard.webp" alt="The CompassDocs dashboard: organization announcements, spaces, and recently updated documents" width="800">

</div>

## Why CompassDocs

Team knowledge shouldn't be a scavenger hunt across wikis, drives, and chat
scrollback. CompassDocs is one clean, self-hosted place for it — free and
open-source (AGPL-3.0), running from a single Docker command, with no per-seat
pricing on the core product, ever.

## Features

**Find & ask**
- **Ask CompassDocs** — plain-English questions answered from your docs with inline citations, plus "who does X?" answers straight from the people directory. Powered by a lightweight RAG pipeline over PostgreSQL full-text search; works keyword-only without an API key.
- **Instant search** — ranked, keyword-highlighted results with a ⌘K quick-search everywhere. Drafts stay hidden from viewers.

**Write**
- **Rich editor or Markdown** — headings, tables, checklists, code blocks; paste screenshots inline, size them, add alt text. AI proofreading built in.
- **Version history, drafts, tags, attachments,** and one-click **Print / Save as PDF**. Readers pick their page width.

**Organize**
- **Spaces** with three visibility tiers — internal, **private** (granted groups only), or **public** (a branded, read-only site for the open internet, off by default).
- **Per-space edit rights** — restrict who can author in a space, per person or group, with an org-wide override switch.
- **People directory** — profiles, custom fields, assistants, and each person's authored docs; clickable article bylines.
- **Quick links** — a launchpad of categorized shortcuts to your other tools, group-restricted, with auto-fetched icons.

**Communicate**
- **Announcements** — org-wide dashboard alerts (info/warning/critical) with a sidebar unread badge, optional email and chat delivery.
- **Newsletter** — branded HTML email written in the doc editor, sent to everyone or selected groups.
- **Subscriptions** — anyone can follow a space and get an email when its docs change; admins can auto-subscribe groups.
- **Notifications** — Webex, Microsoft Teams, Slack, email, or any webhook on review/publish/announcement events.

**Govern**
- **Roles & approval workflow** — Viewer/Editor/Approver/Admin, with a review queue for changes to live docs (strict mode) or direct publishing (open mode), plus suggestions from any reader.
- **Security** — authenticator-app 2FA with recovery codes, per-device sessions, idle timeout, and a full audit log.
- **Trash & retention**, import/export as front-matter Markdown, scheduled backups with off-site mirroring (S3/R2/MinIO/Azure).

**Administer & integrate**
- **Your brand** — fetch your website's icon or upload a logo, pick an accent color, and the whole app re-tints (light/dark/auto).
- **Groups** — manual or synced from Microsoft Entra ID (enterprise); **custom domain with automatic HTTPS**; a system console with storage and resource usage.
- **Claude connector (MCP)** — connect the Claude app with one click and draft, search, and revise docs from Claude; approvals still apply.

**Enterprise** *(separate licensed build — [pricing](https://compassdocs.io/pricing): flat $599/yr, unlimited users)*
- **SSO** (OIDC, one-click Microsoft Entra setup) · **Microsoft 365 directory & group sync** · **Policy acknowledgements** ("I've read this" compliance records with CSV export) · **audit-log export** · optional dedicated support.
- Licenses are offline, cryptographically signed keys — no phone-home, air-gap friendly. The Community edition is complete on its own.

## Screenshots

| | |
| --- | --- |
| ![AI answer with citations](https://compassdocs.io/img/ai.webp) | ![A rendered SOP document](https://compassdocs.io/img/document.webp) |
| *Ask CompassDocs — cited answers* | *Documents — rich rendering, print to PDF* |
| ![The people directory](https://compassdocs.io/img/directory.webp) | ![The anonymous public site](https://compassdocs.io/img/public-site.webp) |
| *People directory* | *Optional public site* |

## Roles & permissions

| Action | Viewer | Editor | Approver | Admin |
| --- | :--: | :--: | :--: | :--: |
| Read / search / ask AI | ✓ | ✓ | ✓ | ✓ |
| Submit a suggestion | ✓ | ✓ | ✓ | ✓ |
| Create & edit drafts | – | ✓ | ✓ | ✓ |
| Publish / push a change live | – | –¹ | ✓ | ✓ |
| Review queue (approve edits & suggestions) | – | – | ✓ | ✓ |
| Manage users, roles & settings | – | – | – | ✓ |

¹ In **open** approval mode, Editors can publish and edit live docs directly. In **strict** mode (the default) those changes become pending change requests for an Approver.

## First-run setup

The first time you open a fresh install, CompassDocs shows a **setup wizard** at
`/setup` where you create your **admin account** (and optionally set your company
name) right in the browser — no default password to look up. From **Admin →
Users** you then add everyone else and assign roles.

Prefer to provision headlessly (CI, automation)? Set `COMPASSDOCS_ADMIN_USER`
and `COMPASSDOCS_ADMIN_PASSWORD` (see `.env.example`) and the admin is created on
first launch instead, skipping the wizard.

> **Authentication** uses local accounts (username + password hashed with Node's `scrypt`) and secure HTTP-only cookie sessions — no external services required. Authenticator-app **2FA** is available to every user. Single sign-on (OIDC, with one-click Microsoft Entra setup) ships in the Enterprise build.

## Tech stack

| Layer     | Choice                                                        |
| --------- | ------------------------------------------------------------- |
| Framework | Next.js 15 (App Router, React 19, TypeScript)                 |
| Styling   | Tailwind CSS                                                  |
| Storage   | PostgreSQL via `pg`, native full-text search (`tsvector`/GIN) |
| Rendering | `react-markdown` + `remark-gfm`                               |
| AI        | Anthropic SDK (`claude-opus-4-8`) with keyword fallback       |

## Getting started

You need **Node.js 20+** and a **PostgreSQL** database. Two easy ways to get a
local Postgres:

**Option A — Docker (recommended).** A `docker-compose.yml` is included:

```bash
docker compose up -d
# DATABASE_URL=postgres://compass:compass@localhost:5432/compassdocs
```

**Option B — Homebrew (no Docker):**

```bash
brew install postgresql@16 && brew services start postgresql@16
createdb compassdocs
# DATABASE_URL=postgres://localhost:5432/compassdocs
```

Then run the app:

```bash
npm install
cp .env.example .env        # set DATABASE_URL to the value from above
npm run dev
# open http://localhost:3000
```

On first connection the app **creates its own schema and seeds** four spaces and
nine example documents — no manual migrations to run. Schema creation is
idempotent and guarded by a Postgres advisory lock, so it's safe across
concurrent startups (e.g. serverless cold starts). Sign in with `admin` / `admin`.

### Production build

```bash
npm run build
npm run start
```

## AI-powered search (optional)

Search and answers work out of the box **without any API key** — the "Ask
CompassDocs" page falls back to returning the best-matching document snippets.

To enable synthesized, cited AI answers, set in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
# optional override:
# COMPASSDOCS_AI_MODEL=claude-opus-4-8
```

The AI answer flow is a lightweight RAG pipeline: the question is used to
retrieve the top documents via Postgres full-text search, those excerpts are
passed to Claude as grounded context, and the model is instructed to answer only
from them and cite sources. Any API error degrades gracefully to the keyword
fallback.

## Deploy to Azure (one click)

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fmattny20%2FCompassDocs%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fmattny20%2FCompassDocs%2Fmain%2Fdeploy%2Fazure%2FcreateUiDefinition.json)

Launches the full stack (app + Postgres, optional HTTPS proxy) on an Ubuntu VM
through a guided portal wizard: pick any VM size, create or join an existing
virtual network, restrict SSH/web access by CIDR, choose disk types and an
optional dedicated data disk, and set the CompassDocs edition, license, and
admin bootstrap — all before clicking Create. Details in
[deploy/azure](deploy/azure/).

## Self-hosting (one command)

The easiest way to run CompassDocs is with Docker — it starts the app **and** a
Postgres database together. On a machine with [Docker](https://docs.docker.com/get-docker/)
installed:

```bash
curl -fsSL https://raw.githubusercontent.com/mattny20/CompassDocs/main/install.sh | bash
```

This creates a `./compassdocs` folder, generates strong random passwords, starts
everything, and prints your admin login. Open **http://localhost:3000**.

**Update to the latest release** — from that folder:

```bash
docker compose pull && docker compose up -d
```

Your data lives in a Docker volume and is preserved across updates; the app
migrates its own schema on start, so there are no manual upgrade steps. (Re-running
the install command does the same thing.)

Prefer to do it by hand? Grab [`deploy/docker-compose.yml`](./deploy/docker-compose.yml)
and [`deploy/.env.example`](./deploy/.env.example), fill in the `.env`, and run
`docker compose up -d`.

**Build from source instead of pulling an image** — for local development or a
private fork, [`docker-compose.local.yml`](./docker-compose.local.yml) builds the
app from this repo and runs it with Postgres, so no registry or auth is needed:

```bash
docker compose -f docker-compose.local.yml up -d --build   # http://localhost:3000
```

### Custom domain & HTTPS

To serve CompassDocs on your own domain with automatic HTTPS, use the Caddy
reverse-proxy stack ([`deploy/docker-compose.tls.yml`](./deploy/docker-compose.tls.yml)
+ [`deploy/Caddyfile`](./deploy/Caddyfile)):

1. Point your domain's DNS (an `A`/`AAAA` record) at the server, and make sure
   ports **80** and **443** are reachable.
2. In `.env`, set `COMPASSDOCS_DOMAIN=docs.example.com` (plus `POSTGRES_PASSWORD`).
3. Start it:
   ```bash
   docker compose -f docker-compose.tls.yml up -d
   ```

Caddy obtains and renews a **Let's Encrypt** certificate automatically; the app
isn't exposed on the host directly — all traffic flows through Caddy on 80/443.
The `Caddyfile` also documents two alternatives you can switch to with one line:
**self-signed** (`tls internal`, for a LAN or testing) or **bring-your-own
certificate** (drop `cert.pem`/`key.pem` in `deploy/certs`).

> Images are published to `ghcr.io/mattny20/compassdocs` automatically on every
> merge to `main` (`:latest`) and on version tags (`:X.Y.Z`) by the
> [Docker publish workflow](./.github/workflows/docker-publish.yml).

## Deploying to a platform (Vercel / Railway / Render)

CompassDocs is a standard Next.js server plus a Postgres database — the app is
stateless, so it runs anywhere and scales horizontally. Set `DATABASE_URL` (and
optionally `ANTHROPIC_API_KEY`, `COMPASSDOCS_ADMIN_*`) as environment variables.

| Target | How |
| --- | --- |
| **Vercel + Neon** | Import the repo on Vercel; add a Neon (or Vercel Postgres) database and set `DATABASE_URL`. Cheapest to start; Vercel's free tier is non-commercial. |
| **Railway** | One project with the app **and** a Postgres plugin. Railway injects `DATABASE_URL`. Commercial-friendly, ~$5/mo. |
| **Render** | Web Service from the repo + a managed Postgres instance; wire its internal `DATABASE_URL` to the service. |
| **Docker (Fly.io, a VPS, anywhere)** | A `Dockerfile` is included (Next.js standalone output). `docker build -t compassdocs . && docker run -p 3000:3000 -e DATABASE_URL=... compassdocs`. |

Use a managed Postgres with connection pooling (Neon and Supabase provide a
pooled connection string) when deploying to serverless platforms, and keep
`DATABASE_POOL_MAX` modest.

## How it fits together

```
src/
├── app/
│   ├── (app)/                   Signed-in app: dashboard, spaces, docs, editor,
│   │                            history, search/Ask, directory, links, review,
│   │                            trash, and the admin console
│   ├── (public)/public/         Anonymous public site (opt-in, per space)
│   ├── account/                 Manage account (notifications, 2FA, tokens)
│   └── api/                     REST routes: documents, search, admin, MCP, …
├── components/                  Sidebar, editors, panels, cards, badges
├── ee-stub/                     Open-source stand-in for the enterprise add-ins
└── lib/
    ├── db.ts                    Postgres pool, schema/migration, queries, seeding
    ├── auth.ts / access.ts      Sessions, role guards, space visibility & edit rights
    ├── ai.ts                    RAG answer pipeline + keyword fallback
    ├── webhooks.ts / mailer.ts  Chat + email delivery
    └── license.ts               Offline Ed25519 license verification (fails open)
```

Search stays consistent automatically: the `documents.search` column is a
generated `tsvector` (title + summary + content + tags) with a GIN index, so
Postgres maintains the full-text index on every insert and update — newly
created documents are searchable immediately, ranked with `ts_rank`.

## License

CompassDocs is free and open-source software, licensed under the **GNU Affero
General Public License v3.0 (AGPL-3.0)** — see [`LICENSE`](./LICENSE).

Copyright © 2026 CompassDocs authors.

In plain terms: you can **self-host and use CompassDocs for free**, including in a
company, and modify it however you like. The AGPL's one condition is that if you
run a **modified** version as a **network service** for others, you must make
your modified source available to those users under the same license.

This is the same model as tools like Snipe-IT: the software is fully open and
free to self-host, and a managed **CompassDocs Cloud** hosting tier (run and
maintained for you) is offered separately. The AGPL keeps the self-hosted
edition open while ensuring improvements made in hosted derivatives flow back to
the community.
