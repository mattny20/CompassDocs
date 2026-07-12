# 🧭 CompassDocs

A modern documentation and knowledge platform for teams. Create, organize, and
search SOPs, technical documentation, policies, and internal knowledge with a
clean interface, AI-powered search, and collaborative editing with version
history.

![Next.js](https://img.shields.io/badge/Next.js-15-black) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue) ![License](https://img.shields.io/badge/license-AGPL--3.0-orange)

## Features

- **Accounts & roles** — the whole site is private (login required). Four role tiers — **Viewer**, **Editor**, **Approver**, **Admin** — govern who can read, write, publish, and administer.
- **Editorial approval workflow** — in **strict** mode, an Editor's changes to a published doc (or a request to publish) go to a **review queue**; Approvers/Admins approve (applies it live) or reject. Admins can switch to **open** mode, letting Editors publish directly.
- **Suggestions** — any signed-in user can leave a "suggest an edit" note on a doc; Approvers/Admins triage them from the review queue.
- **Admin console** — create users, assign/change roles, reset passwords, enable/disable accounts, and toggle the approval workflow — all with a last-admin lockout guard.
- **Appearance & workspace settings** — set your **company name and logo**, choose a **timezone**, **date** and **time format** for how timestamps render, and configure the **idle session timeout** — all from the Admin page.
- **Spaces** — group knowledge by team or domain (Engineering, People Ops, Security, …).
- **Four document types** — SOPs, Technical docs, Policies, and Knowledge/how-tos, each color-coded.
- **Markdown editing** — a distraction-free editor with a live preview tab and GitHub-flavored markdown (tables, checklists, code blocks).
- **Full-text search** — instant, ranked, keyword-highlighted results powered by **PostgreSQL full-text search** (`tsvector` + GIN index, `ts_rank`). A ⌘K quick-search is available everywhere. Drafts are hidden from Viewers in search, lists, and AI answers.
- **AI-powered answers** — "Ask CompassDocs" answers plain-English questions grounded in your knowledge base, with inline citations and clickable sources.
- **Version history** — every content change is snapshotted; browse and preview past revisions.
- **Drafts & publishing** — mark documents as draft or published.
- **Tags** — tag documents and browse by popular tags.
- **Self-seeding storage** — on first connection the app creates its own PostgreSQL schema and seeds realistic sample content; no manual migrations.

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

## First login

On first run CompassDocs creates a single **admin** account — by default `admin` / `admin`, which you're required to change on first sign-in. Override the bootstrap credentials with `COMPASSDOCS_ADMIN_USER` / `COMPASSDOCS_ADMIN_PASSWORD` (see `.env.example`). From **Admin → Users** you then create everyone else and assign roles.

> **Authentication** uses local accounts (username + password hashed with Node's `scrypt`) and secure HTTP-only cookie sessions — no external services required. The user model carries `auth_provider` / `external_id` columns so SSO (Azure/Google/Okta/Duo) and SCIM provisioning can be layered on later without a rewrite.

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
│   ├── page.tsx                 Dashboard (stats, spaces, recent, tags)
│   ├── spaces/[slug]/           Documents within a space
│   ├── doc/[id]/                Read view
│   ├── doc/[id]/edit/           Editor (edit mode)
│   ├── doc/[id]/history/        Version history timeline
│   ├── doc/new/                 Editor (create mode)
│   ├── search/                  "Ask CompassDocs" (AI + keyword)
│   └── api/                     REST routes: documents, search, ai-search
├── components/                  Sidebar, editor, search, cards, badges
└── lib/
    ├── db.ts                    Postgres pool, schema/migration, queries, seeding
    ├── auth.ts                  Sessions, cookies, role guards
    ├── ai.ts                    RAG answer pipeline + fallback
    ├── seed-data.ts             Sample spaces & documents
    └── types.ts                 Shared types
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
