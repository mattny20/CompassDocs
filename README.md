# 🧭 CompassDocs

A modern documentation and knowledge platform for teams. Create, organize, and
search SOPs, technical documentation, policies, and internal knowledge with a
clean interface, AI-powered search, and collaborative editing with version
history.

![Next.js](https://img.shields.io/badge/Next.js-15-black) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue) ![SQLite](https://img.shields.io/badge/SQLite-FTS5-green)

## Features

- **Accounts & roles** — the whole site is private (login required). Four role tiers — **Viewer**, **Editor**, **Approver**, **Admin** — govern who can read, write, publish, and administer.
- **Editorial approval workflow** — in **strict** mode, an Editor's changes to a published doc (or a request to publish) go to a **review queue**; Approvers/Admins approve (applies it live) or reject. Admins can switch to **open** mode, letting Editors publish directly.
- **Suggestions** — any signed-in user can leave a "suggest an edit" note on a doc; Approvers/Admins triage them from the review queue.
- **Admin console** — create users, assign/change roles, reset passwords, enable/disable accounts, and toggle the approval workflow — all with a last-admin lockout guard.
- **Spaces** — group knowledge by team or domain (Engineering, People Ops, Security, …).
- **Four document types** — SOPs, Technical docs, Policies, and Knowledge/how-tos, each color-coded.
- **Markdown editing** — a distraction-free editor with a live preview tab and GitHub-flavored markdown (tables, checklists, code blocks).
- **Full-text search** — instant, ranked, keyword-highlighted results powered by SQLite **FTS5** (BM25 ranking). A ⌘K quick-search is available everywhere. Drafts are hidden from Viewers in search, lists, and AI answers.
- **AI-powered answers** — "Ask CompassDocs" answers plain-English questions grounded in your knowledge base, with inline citations and clickable sources.
- **Version history** — every content change is snapshotted; browse and preview past revisions.
- **Drafts & publishing** — mark documents as draft or published.
- **Tags** — tag documents and browse by popular tags.
- **Zero-config storage** — a local SQLite database that seeds realistic sample content on first run.

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

| Layer     | Choice                                                     |
| --------- | ---------------------------------------------------------- |
| Framework | Next.js 15 (App Router, React 19, TypeScript)              |
| Styling   | Tailwind CSS                                               |
| Storage   | SQLite via `better-sqlite3`, full-text search with FTS5    |
| Rendering | `react-markdown` + `remark-gfm`                            |
| AI        | Anthropic SDK (`claude-opus-4-8`) with keyword fallback    |

## Getting started

```bash
npm install
npm run dev
# open http://localhost:3000
```

On first run, the app creates `./data/compassdocs.db` and seeds it with four
spaces and nine example documents so you have something to explore immediately.

### Production build

```bash
npm run build
npm run start
```

## AI-powered search (optional)

Search and answers work out of the box **without any API key** — the "Ask
CompassDocs" page falls back to returning the best-matching document snippets.

To enable synthesized, cited AI answers, copy `.env.example` to `.env` and set:

```bash
ANTHROPIC_API_KEY=sk-ant-...
# optional overrides:
# COMPASSDOCS_AI_MODEL=claude-opus-4-8
# COMPASSDOCS_DB_PATH=./data/compassdocs.db
```

The AI answer flow is a lightweight RAG pipeline: the question is used to
retrieve the top documents via FTS5, those excerpts are passed to Claude as
grounded context, and the model is instructed to answer only from them and cite
sources. Any API error degrades gracefully to the keyword fallback.

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
    ├── db.ts                    Schema, FTS5 triggers, queries, seeding
    ├── ai.ts                    RAG answer pipeline + fallback
    ├── seed-data.ts             Sample spaces & documents
    └── types.ts                 Shared types
```

Search stays consistent automatically: FTS5 triggers keep the search index in
sync on every insert, update, and delete, so newly created documents are
searchable immediately.
