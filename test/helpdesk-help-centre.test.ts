// Helpdesk 1.19.4 (C3): the customer portal help centre
// (lib/helpdesk/help-centre). The rule for what is public lives in ONE
// function, publicHelpArticles; this file proves every arm of it:
//   - drafts, draft branches and documents in the trash are never public
//   - private spaces are never public, even when chosen (or tagged public)
//   - handbook-only policies, policies people must confirm, retired
//     policies and live training decks ("restricted") are never public
//   - a page under a restricted page is never public
//   - only the chosen spaces, and/or documents tagged public, count
//   - a category switched off takes its articles with it
//   - the help centre off, the portal off or the licence missing: nothing
//   - what an article carries is an allowlist: no author (or their email),
//     no comments, no version history, no tags; HTML comments go, links to
//     documents that are not public lose their address, files go through
//     the help centre's own route
// and the routes and stats around it: search (public, rate-limited,
// counted only same-origin, never personal data), journeys ("answered
// without a request"), files, and the settings route (settings.manage,
// private spaces refused, audited).
//
// Most tests pass their own settings to the rule (no workspace state). The
// route tests write the portal and help centre keys under the portal's
// advisory lock (728661, shared with test/helpdesk-portal.test.ts and
// e2e/helpdesk-portal.spec.ts) and restore them. Every other fixture is
// this file's own (stamped spaces, documents, accounts).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-help-centre.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, getSetting, setSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import { MarkdownView } from "../src/components/MarkdownView";

// --- Request scope and licence stubs (as test/helpdesk-portal.test.ts) ------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-help-centre.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-help-centre.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
const edition = { present: true, features: ["helpdesk"] as string[] };
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const hc = require("../src/lib/helpdesk/help-centre") as typeof import("../src/lib/helpdesk/help-centre");
const portal = require("../src/lib/helpdesk/portal") as typeof import("../src/lib/helpdesk/portal");
const searchRoute = require("../src/app/(portal)/support/api/help/search/route") as typeof import("../src/app/(portal)/support/api/help/search/route");
const journeyRoute = require("../src/app/(portal)/support/api/help/journey/route") as typeof import("../src/app/(portal)/support/api/help/journey/route");
const filesRoute = require("../src/app/(portal)/support/api/help/files/[id]/route") as typeof import("../src/app/(portal)/support/api/help/files/[id]/route");
const adminRoute = require("../src/app/api/helpdesk/admin/portal/help-centre/route") as typeof import("../src/app/api/helpdesk/admin/portal/help-centre/route");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const linkRoute = require("../src/app/(portal)/support/api/link/route") as typeof import("../src/app/(portal)/support/api/link/route");
const sessionRoute = require("../src/app/(portal)/support/api/session/route") as typeof import("../src/app/(portal)/support/api/session/route");
const requestsRoute = require("../src/app/(portal)/support/api/requests/route") as typeof import("../src/app/(portal)/support/api/requests/route");
const resultsPage = require("../src/app/(portal)/support/search/page") as typeof import("../src/app/(portal)/support/search/page");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HelpCentreSettings } from "../src/lib/helpdesk/help-centre-shared";
import type { PortalSettings } from "../src/lib/helpdesk/portal-shared";

// --- Fixtures ---------------------------------------------------------------------------

const STAMP = `hdhc${Date.now()}${Math.floor(Math.random() * 1e6)}`;
// A word only this file's documents hold (letters only: stored queries blank long numbers).
const WORD = `zq${STAMP.replace(/\d/g, (d) => "abcdefghij"[Number(d)])}`;
const HOST = "portal.example.test";
const ORIGIN = `http://${HOST}`;
const LOCK = 728661;
const AUTHOR_EMAIL = `jane.author@${STAMP}.corp.test`;
const COMMENTER_EMAIL = `cora.commenter@${STAMP}.corp.test`;

let lockClient: PoolClient;
let savedPortal: string | undefined;
let savedHc: string | undefined;
let uploadDirectory = "";
const userIds: number[] = [];
const spaceIds: number[] = [];
let admin = { id: 0, session: "" };
let agent = { id: 0, session: "" };

const sp = { guides: 0, release: 0, priv: 0, other: 0, priv2: 0, bulk: 0 };
const cat = { start: 0, billing: 0, privCat: 0, bulk: 0 };
const fx = { team: 0, type: 0 };
const doc = {} as Record<
  | "ok1"
  | "ok2"
  | "release"
  | "draft"
  | "branch"
  | "trashed"
  | "handbookOnly"
  | "handbookOnlyPublished"
  | "ack"
  | "retired"
  | "training"
  | "childOfDraft"
  | "childOfOk"
  | "inPrivate"
  | "taggedOther"
  | "taggedPrivate"
  | "untaggedOther"
  | "taggedDraft",
  number
>;
const att = { ok: 0, draft: 0, priv: 0 };
let handbookId = 0;

const portalOn = (): PortalSettings => portal.cleanPortalSettings({ enabled: true, types: [] });
const settings = (over: Partial<HelpCentreSettings> = {}): HelpCentreSettings =>
  hc.cleanHelpCentreSettings({ enabled: true, from_spaces: true, spaces: [sp.guides, sp.release, sp.priv], tagged: false, ...over });
const ctx = (over: Partial<HelpCentreSettings> = {}, p: PortalSettings = portalOn()) => ({ hc: settings(over), portal: p });

/** An article body as the article page renders it (MarkdownView with the help centre's address rule). */
const OWN_HOSTS = new Set(["portal.example.test"]);
function render(body: string, links: [number, string][]): string {
  return renderToStaticMarkup(createElement(MarkdownView, { content: body, rewriteUrl: (u: string) => hc.helpCentreUrl(u, { publicHrefs: new Map(links), ownHosts: OWN_HOSTS }) }));
}

/** Only this file's documents (tagged mode reaches the whole workspace). */
const mine = (ids: number[]) => ids.filter((id) => Object.values(doc).includes(id));
const idsOf = async (q: Parameters<typeof hc.publicHelpArticles>[0] = {}, over: Partial<HelpCentreSettings> = {}) =>
  mine((await hc.publicHelpArticles({ limit: 5000, ...q }, ctx(over))).map((a) => a.id)).sort((a, b) => a - b);

async function space(name: string, visibility: string): Promise<number> {
  const id = (await fixtureQuery("INSERT INTO spaces (slug, name, visibility) VALUES ($1, $2, $3) RETURNING id", [`${STAMP}-${name.toLowerCase().replace(/\W+/g, "-")}`, `${name} ${STAMP}`, visibility])).rows[0].id as number;
  spaceIds.push(id);
  return id;
}

async function category(spaceId: number, name: string, position: number): Promise<number> {
  return (await pool().query("INSERT INTO space_categories (space_id, name, position) VALUES ($1, $2, $3) RETURNING id", [spaceId, name, position])).rows[0].id as number;
}

async function document(fields: Record<string, unknown>): Promise<number> {
  const f = { status: "published", content: "", tags: "", author: AUTHOR_EMAIL, ...fields } as Record<string, unknown>;
  f.slug ??= `${STAMP}-${Math.random().toString(36).slice(2, 8)}`;
  const cols = Object.keys(f);
  const r = await pool().query(`INSERT INTO documents (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, cols.map((c) => f[c]));
  return r.rows[0].id as number;
}

async function attachment(documentId: number, name: string, data: Buffer, mime = "image/png"): Promise<number> {
  const stored = `${randomBytes(16).toString("hex")}.png`;
  writeFileSync(path.join(uploadDirectory, stored), data);
  return (await pool().query("INSERT INTO attachments (document_id, filename, stored_name, mime_type, size) VALUES ($1, $2, $3, $4, $5) RETURNING id", [documentId, name, stored, mime, data.length])).rows[0].id as number;
}

async function newUser(tag: string, name: string): Promise<{ id: number; session: string }> {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${tag}`, name, `${tag}@${STAMP}.corp.test`]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  return { id, session };
}

let ipSeq = 0;
type Opts = { method?: string; cookie?: string; origin?: string | null; json?: unknown; secFetch?: string; ip?: string };
function makeRequest(url: string, o: Opts = {}): Request {
  ipSeq = (ipSeq % 250) + 1;
  const headers: Record<string, string> = { host: HOST, "x-forwarded-for": o.ip ?? `198.51.100.${ipSeq}` };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin !== null && o.origin !== undefined) headers.origin = o.origin;
  if (o.secFetch) headers["sec-fetch-site"] = o.secFetch;
  let body: string | undefined;
  if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
  }
  return new Request(`${ORIGIN}${url}`, { method: o.method ?? (body ? "POST" : "GET"), headers, body });
}

async function call(handler: (req: Request, c: any) => Promise<Response>, url: string, o: Opts = {}, params?: Record<string, string>) {
  const req = makeRequest(url, o);
  currentRequest = req;
  try {
    const res = await handler(req, params ? { params: Promise.resolve(params) } : undefined);
    const type = res.headers.get("content-type") ?? "";
    const body = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: body as any, headers: res.headers };
  } finally {
    currentRequest = null;
  }
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "compass-hdhc-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDirectory;

  sp.guides = await space("Customer guides", "internal");
  sp.release = await space("Release notes", "public");
  sp.priv = await space("Finance private", "private");
  sp.other = await space("Engineering", "internal");
  sp.priv2 = await space("Board secret", "private");
  sp.bulk = await space("Bulk", "internal");
  cat.bulk = await category(sp.bulk, `Bulk ${WORD}`, 0);
  await pool().query(
    `INSERT INTO documents (space_id, category_id, title, slug, status) SELECT $1, $2, 'Bulk article ' || g, $3 || g, 'published' FROM generate_series(1, 301) g`,
    [sp.bulk, cat.bulk, `${STAMP}-bulk-`]
  );
  cat.start = await category(sp.guides, `Getting started ${STAMP}`, 0);
  cat.billing = await category(sp.guides, `Billing and invoices ${STAMP}`, 1);
  cat.privCat = await category(sp.priv, `Payroll ${STAMP}`, 0);

  doc.ok2 = await document({ space_id: sp.guides, category_id: cat.billing, title: `Paying an invoice ${WORD}`, summary: "Pay by card or transfer." });
  doc.draft = await document({ space_id: sp.guides, category_id: cat.start, title: `Exporting secrets draft ${WORD}`, status: "draft" });
  doc.ok1 = await document({
    space_id: sp.guides,
    category_id: cat.start,
    title: `Exporting reports to CSV ${WORD}`,
    summary: "Download any report as a spreadsheet.",
    tags: `reports,internal-only,${WORD}tagonly`,
    content: [
      `# Exporting reports to CSV ${WORD}`,
      "Open the report and choose Export.",
      `<!-- internal note: the export endpoint is /admin/export, ask Sam ${WORD}closednote -->`,
      `See [paying an invoice](/doc/${doc.ok2}) and [the draft](/doc/${doc.draft} "draft").`,
      "Ask an admin under [Users](/admin/users).",
      `<a href="/doc/${doc.draft}">raw draft link</a> and <a href="https://example.org/x">outside</a>`,
      "![screenshot](/api/attachments/ATT_OK)",
      "![private chart](/api/attachments/ATT_PRIV)",
      `<!-- unclosed: ${WORD}unclosed and the rest`,
    ].join("\n\n"),
  });
  doc.release = await document({ space_id: sp.release, title: `Release 4.2 ${WORD}` });
  doc.branch = await document({ space_id: sp.guides, category_id: cat.start, title: `Exporting branch ${WORD}`, branch_of: doc.ok1 });
  doc.trashed = await document({ space_id: sp.guides, title: `Trashed ${WORD}`, deleted_at: new Date() });
  doc.handbookOnly = await document({ space_id: sp.guides, title: `Handbook only orphan ${WORD}`, find_mode: "handbook_only" });
  doc.handbookOnlyPublished = await document({ space_id: sp.guides, title: `Handbook only ${WORD}`, find_mode: "handbook_only" });
  handbookId = (await pool().query("INSERT INTO handbooks (title, status, space_id) VALUES ($1, 'published', $2) RETURNING id", [`Handbook ${STAMP}`, sp.guides])).rows[0].id;
  const section = await pool()
    .query("INSERT INTO handbook_sections (handbook_id, title) VALUES ($1, 'Policies') RETURNING id", [handbookId])
    .then((r) => r.rows[0].id as number)
    .catch(() => null);
  if (section) await pool().query("INSERT INTO handbook_items (handbook_id, section_id, document_id) VALUES ($1, $2, $3)", [handbookId, section, doc.handbookOnlyPublished]);
  doc.ack = await document({ space_id: sp.guides, title: `Confirm this policy ${WORD}`, type: "policy", ack_required: 1 });
  doc.retired = await document({ space_id: sp.guides, title: `Retired policy ${WORD}`, type: "policy", ack_retired_at: new Date() });
  doc.training = await document({ space_id: sp.guides, title: `Training deck ${WORD}` });
  await pool().query("INSERT INTO training_decks (document_id) VALUES ($1)", [doc.training]);
  doc.childOfDraft = await document({ space_id: sp.guides, title: `Child of a draft ${WORD}`, parent_id: doc.draft });
  doc.childOfOk = await document({ space_id: sp.guides, category_id: cat.start, title: `Child of a public page ${WORD}`, parent_id: doc.ok1 });
  doc.inPrivate = await document({ space_id: sp.priv, category_id: cat.privCat, title: `Salaries ${WORD}` });
  doc.taggedOther = await document({ space_id: sp.other, title: `Tagged public ${WORD}`, tags: "faq, Public " });
  doc.taggedPrivate = await document({ space_id: sp.priv, title: `Tagged in private ${WORD}`, tags: "public" });
  doc.untaggedOther = await document({ space_id: sp.other, title: `Not tagged ${WORD}`, tags: "publication,publicity" });
  doc.taggedDraft = await document({ space_id: sp.other, title: `Tagged draft ${WORD}`, tags: "public", status: "draft" });

  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  att.ok = await attachment(doc.ok1, "screenshot.png", png);
  att.draft = await attachment(doc.draft, "draft.png", png);
  att.priv = await attachment(doc.inPrivate, "salaries.png", png);
  await pool().query("UPDATE documents SET content = replace(replace(content, 'ATT_OK', $2), 'ATT_PRIV', $3) WHERE id = $1", [doc.ok1, String(att.ok), String(att.priv)]);

  // Things that must never travel: a comment, a version, an author's email.
  await pool().query("INSERT INTO doc_comments (document_id, author_name, body) VALUES ($1, $2, $3)", [doc.ok1, COMMENTER_EMAIL, `comment-secret ${STAMP}`]);
  await pool().query("INSERT INTO doc_versions (document_id, title, content, author) VALUES ($1, $2, $3, $4)", [doc.ok1, "Old title", `version-secret ${STAMP}`, AUTHOR_EMAIL]);

  admin = await newUser("admin", "Ada Admin");
  agent = await newUser("agent", "Priya Shah");
  const assign = (user: number, role: string) =>
    fixtureQuery(`INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = $2`, [user, role]);
  await assign(admin.id, "helpdesk-agent");
  await assign(agent.id, "helpdesk-agent");
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT (user_id) DO UPDATE SET role = 'admin'", [admin.id]);
});

after(async () => {
  await pool().query("DELETE FROM hd_hc_searches WHERE journey LIKE $1 OR q LIKE $2", [`${STAMP}%`, `%${WORD}%`]);
  await pool().query("DELETE FROM hd_hc_journeys WHERE id LIKE $1", [`${STAMP}%`]);
  if (handbookId) await pool().query("DELETE FROM handbooks WHERE id = $1", [handbookId]);
  await pool().query("DELETE FROM training_decks WHERE document_id = ANY($1)", [Object.values(doc)]);
  // Children before parents (parent_id is SET NULL, branch_of CASCADE).
  await pool().query("DELETE FROM documents WHERE space_id = ANY($1)", [spaceIds]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [spaceIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await rm(uploadDirectory, { recursive: true, force: true });
  await pool().end();
});

// --- The rule ---------------------------------------------------------------------------

describe("what is public (publicHelpArticles, the one rule)", () => {
  test("chosen spaces: exactly the published, unrestricted documents, private spaces excluded even when chosen", async () => {
    assert.deepEqual(await idsOf(), [doc.ok2, doc.ok1, doc.release, doc.childOfOk].sort((a, b) => a - b));
  });

  const never: [string, () => number][] = [
    ["a draft", () => doc.draft],
    ["a draft branch (whatever its status says)", () => doc.branch],
    ["a document in the trash", () => doc.trashed],
    ["a handbook-only policy that is in no published handbook", () => doc.handbookOnly],
    ["a handbook-only policy in a published handbook", () => doc.handbookOnlyPublished],
    ["a policy people must confirm they have read", () => doc.ack],
    ["a retired policy", () => doc.retired],
    ["a live training deck", () => doc.training],
    ["a page under a draft", () => doc.childOfDraft],
    ["a document in a private space (chosen)", () => doc.inPrivate],
    ["a document tagged public in a private space", () => doc.taggedPrivate],
  ];
  for (const [what, id] of never) {
    test(`never public: ${what}, in either mode, by id, by search and by category`, async () => {
      for (const over of [{}, { tagged: true }, { from_spaces: false, tagged: true }] as Partial<HelpCentreSettings>[]) {
        assert.deepEqual(await idsOf({ ids: [id()] }, over), [], `${what} by id (${JSON.stringify(over)})`);
        assert.ok(!(await idsOf({ q: WORD }, over)).includes(id()), `${what} by search`);
        assert.ok(!(await idsOf({}, over)).includes(id()), `${what} in the listing`);
      }
    });
  }

  test("a draft's own page stays restricted when its parent is published, and becomes public with it", async () => {
    await pool().query("UPDATE documents SET status = 'published' WHERE id = $1", [doc.draft]);
    try {
      assert.ok((await idsOf()).includes(doc.childOfDraft), "the child follows its parent once published");
    } finally {
      await pool().query("UPDATE documents SET status = 'draft' WHERE id = $1", [doc.draft]);
    }
    assert.ok(!(await idsOf()).includes(doc.childOfDraft));
  });

  test("tagged mode: documents tagged public from any space that is not private; not drafts, not near-miss tags", async () => {
    const tagged = await idsOf({}, { from_spaces: false, tagged: true });
    assert.deepEqual(tagged, [doc.taggedOther]);
    const both = await idsOf({}, { tagged: true });
    assert.deepEqual(both, [doc.ok2, doc.ok1, doc.release, doc.childOfOk, doc.taggedOther].sort((a, b) => a - b));
  });

  test("nothing chosen, help centre off, portal off or no licence: nothing at all", async () => {
    assert.deepEqual(await idsOf({}, { from_spaces: false, tagged: false }), []);
    assert.deepEqual(await idsOf({}, { spaces: [] }), []);
    assert.deepEqual(await idsOf({}, { enabled: false }), []);
    assert.deepEqual(mine((await hc.publicHelpArticles({}, { hc: settings(), portal: portal.cleanPortalSettings({ enabled: false }) })).map((a) => a.id)), []);
    edition.features = [];
    try {
      assert.deepEqual(await idsOf(), []);
    } finally {
      edition.features = ["helpdesk"];
    }
  });

  test("a category switched off takes its articles out everywhere (listing, search, by id, files)", async () => {
    const off = { hidden: [`c${cat.start}`] };
    assert.deepEqual(await idsOf({}, off), [doc.ok2, doc.release].sort((a, b) => a - b));
    assert.deepEqual(await idsOf({ ids: [doc.ok1] }, off), []);
    assert.equal(await hc.helpCentreFile(att.ok, ctx(off)), null);
    const offSpace = { hidden: [`s${sp.release}`] };
    assert.ok(!(await idsOf({}, offSpace)).includes(doc.release), "a space's unfiled documents switch off by its s-key");
  });

  test("categories: folders by id, a space's unfiled documents under its name, counts, the admin's order", async () => {
    const cats = (await hc.helpCentreCategories(ctx())).filter((c) => c.name.includes(STAMP));
    assert.deepEqual(
      cats.map((c) => [c.key, c.count]),
      [
        [`c${cat.billing}`, 1],
        [`c${cat.start}`, 2],
        [`s${sp.release}`, 1],
      ]
    );
    const ordered = (await hc.helpCentreCategories(ctx({ order: [`s${sp.release}`, `c${cat.start}`] }))).filter((c) => c.name.includes(STAMP));
    assert.deepEqual(ordered.map((c) => c.key), [`s${sp.release}`, `c${cat.start}`, `c${cat.billing}`]);
    const one = await hc.helpCentreCategory(`c${cat.start}`, ctx());
    assert.deepEqual(one?.articles.map((a) => a.id).sort((a, b) => a - b), [doc.ok1, doc.childOfOk].sort((a, b) => a - b));
    assert.equal(await hc.helpCentreCategory(`c${cat.privCat}`, ctx()), null, "a private space's folder shows nothing");
    assert.equal(await hc.helpCentreCategory("x1", ctx()), null);
  });

  test("counts are true past the page's 300: the home says 301, the category shows 300 and says so", async () => {
    const c = ctx({ spaces: [sp.bulk] });
    const home = (await hc.helpCentreCategories(c)).find((x) => x.key === `c${cat.bulk}`);
    assert.equal(home?.count, 301);
    const one = await hc.helpCentreCategory(`c${cat.bulk}`, c);
    assert.equal(one?.total, 301);
    assert.equal(one?.articles.length, 300);
    const admin = (await hc.helpCentreAdminCategories(settings({ spaces: [sp.bulk] }), portalOn())).find((x) => x.key === `c${cat.bulk}`);
    assert.equal(admin?.count, 301);
  });

  test("an article carries an allowlist: no author or email, no tags, no comments, no history", async () => {
    const [a] = await hc.publicHelpArticles({ ids: [doc.ok1], body: true }, ctx());
    assert.deepEqual(Object.keys(a).sort(), ["body", "category", "href", "id", "summary", "title", "updated_at"]);
    const page = await hc.helpCentreArticle(doc.ok1, ctx());
    const json = JSON.stringify([a, page, await hc.publicHelpArticles({ q: WORD }, ctx()), await hc.helpCentreCategories(ctx())]);
    for (const secret of [AUTHOR_EMAIL, COMMENTER_EMAIL, `comment-secret ${STAMP}`, `version-secret ${STAMP}`, "internal-only", "Old title"]) {
      assert.ok(!json.includes(secret), `never out: ${secret}`);
    }
    assert.equal(a.href, `/support/articles/${doc.ok1}-${(await pool().query("SELECT slug FROM documents WHERE id = $1", [doc.ok1])).rows[0].slug}`);
  });

  test("the article page as rendered: notes gone, files through the help centre, links only to public articles", async () => {
    const page = await hc.helpCentreArticle(doc.ok1, ctx());
    assert.ok(page);
    assert.ok(!page!.body.includes("internal note") && !page!.body.includes("<!--"), "HTML comments are removed from the body");
    const ok2Href = (await hc.publicHelpArticles({ ids: [doc.ok2] }, ctx()))[0].href;
    assert.deepEqual(page!.links, [[doc.ok2, ok2Href]], "only the public link targets are known");
    const html = render(page!.body, page!.links);
    assert.ok(html.includes(`href="${ok2Href}"`), "a link to a public document points at its article");
    assert.match(html, /<a( title="draft")?>the draft<\/a>/, "a link to a draft keeps only its text");
    assert.ok(!html.includes(`/doc/${doc.draft}`) && !html.includes("/doc/"), "no address of a document survives");
    assert.ok(!html.includes("/admin/users") && html.includes("<a>Users</a>"), "an app link keeps only its text");
    assert.ok(html.includes('href="https://example.org/x"'), "outside links stay");
    assert.ok(html.includes(`src="/support/api/help/files/${att.ok}"`), "images go through the help centre's files");
    assert.ok(!html.includes("/api/attachments/"), "never the app's attachment route");
    assert.deepEqual(page!.files.map((f) => f.href), [`/support/api/help/files/${att.ok}`]);
    assert.equal(await hc.helpCentreArticle(doc.draft, ctx()), null);
  });

  test("every link form is decided on the parsed page (reference, angle brackets, titles, nested brackets, dot segments, raw HTML)", () => {
    const links: [number, string][] = [[7, "/support/articles/7-public"]];
    const forms = [
      "[nested [b] c](/doc/12)",
      "[angle](</doc/12>)",
      "[ref][r]\n\n[r]: /doc/12",
      "[single](/doc/12 'note')",
      "[paren](/doc/12 (note))",
      "[dots](/support/../doc/12)",
      "[encoded](/support/%2e%2e/admin/export)",
      "[api](/support/api/requests)",
      "[proto](//portal.example.test/doc/12)",
      "[own](http://portal.example.test/doc/12)",
      '<div><a href=/doc/12>unquoted</a> <a href="/admin">quoted</a> <img src=/api/me></div>',
      "[js](javascript:alert(1))",
    ].join("\n\n");
    const html = render(forms, links);
    for (const bad of ["/doc/12", "/admin", "/api/me", "/support/api/requests", "javascript:", "%2e"]) assert.ok(!html.includes(bad), `no ${bad} in ${html}`);
    for (const text of ["nested [b] c", "angle", "ref", "single", "paren", "dots", "encoded", "api", "proto", "own", "unquoted", "quoted"]) assert.ok(html.includes(text), `the text "${text}" stays`);
    const auto = render("<https://portal.example.test/admin/users> and <https://elsewhere.test/x>", links);
    assert.ok(!auto.includes('href="https://portal.example.test'), "an autolink into this workspace loses its address");
    assert.ok(auto.includes('href="https://elsewhere.test/x"'));
    const good = render("[pub](/doc/7#steps) [also](https://portal.example.test/doc/7) [home](/support/../support/categories/c1) [mail](mailto:help@acme.test)", links);
    assert.ok(good.includes('href="/support/articles/7-public#steps"'), good);
    assert.ok(good.includes('href="/support/articles/7-public"'), "this workspace's own absolute link to a public document");
    assert.ok(good.includes('href="/support/categories/c1"'), "dot segments normalised, then judged");
    assert.ok(good.includes('href="mailto:help@acme.test"'));
  });

  test("other sites' addresses are never taken for this workspace's", () => {
    const html = render(
      "[vendor](https://vendor.example.com/doc/5) see https://intranet.example.com/api/attachments/9 here ![chart](https://cdn.example.com/api/attachments/3)",
      [[5, "/support/articles/5-local"]]
    );
    assert.ok(html.includes('href="https://vendor.example.com/doc/5"'), html);
    assert.ok(html.includes("https://intranet.example.com/api/attachments/9"), "plain text stays as written");
    assert.ok(html.includes('src="https://cdn.example.com/api/attachments/3"'));
    assert.ok(!html.includes("/support/articles/5-local") && !html.includes("/support/api/help/files/"));
  });

  test("a video and its poster play from the help centre's files", () => {
    const html = render(`::video[Setup]{src="/api/attachments/${att.ok}" poster="/api/attachments/${att.ok}"}\n\n::video[Gone]{src="/admin/video.mp4"}`, []);
    assert.ok(html.includes(`<video src="/support/api/help/files/${att.ok}"`), html);
    assert.ok(html.includes(`poster="/support/api/help/files/${att.ok}"`), "the poster survives the sanitiser and the player");
    assert.ok(!html.includes("/admin/video.mp4") && !html.includes("Gone"), "a video whose source is dropped goes");
  });

  test("files: only those of public articles", async () => {
    assert.equal((await hc.helpCentreFile(att.ok, ctx()))?.filename, "screenshot.png");
    assert.equal(await hc.helpCentreFile(att.draft, ctx()), null);
    assert.equal(await hc.helpCentreFile(att.priv, ctx()), null, "an image of a private document linked from a public one is still refused");
    assert.equal(await hc.helpCentreFile(0, ctx()), null);
  });

  test("search: prefix words over title and body, drafts never, operators ignored", async () => {
    assert.deepEqual(await idsOf({ q: `expor ${WORD}` }), [doc.ok1]);
    assert.deepEqual(await idsOf({ q: `spreadsheet ${WORD}` }), [doc.ok1], "the summary is searched");
    assert.deepEqual(await idsOf({ q: `space:${STAMP} ${WORD} card` }), [doc.ok2]);
    assert.deepEqual(await idsOf({ q: "" }), []);
    assert.deepEqual(await idsOf({ q: "!!" }), []);
    for (const hidden of [`${WORD}tagonly`, `${WORD}closednote`, `${WORD}unclosed`, `${WORD}tag`, `${WORD}unc`]) {
      assert.deepEqual(await idsOf({ q: hidden }), [], `a word only in a tag or a comment finds nothing: ${hidden}`);
      assert.deepEqual(await idsOf({ q: hidden, any: true }), []);
      assert.deepEqual(mine((await hc.searchHelpCentre(hidden, { record: false }, ctx({ tagged: true }))).map((a) => a.id)), []);
    }
    assert.deepEqual(await idsOf({ q: "internal" }), [], "the tag internal-only is not searchable");
    const s = await hc.searchHelpCentre(`expor ${WORD}`, { record: false }, ctx());
    assert.deepEqual(Object.keys(s[0]).sort(), ["category", "href", "id", "summary", "title"]);
    assert.equal(s[0].id, doc.ok1, "articles holding every word come first");
    assert.ok(s.length > 1, "then articles holding some of the words");
    assert.deepEqual(mine((await hc.publicHelpArticles({ q: `expor ${WORD}`, any: true, limit: 50 }, ctx())).map((a) => a.id)).sort((a, b) => a - b), [doc.ok2, doc.ok1, doc.release, doc.childOfOk].sort((a, b) => a - b), "any word never reaches a restricted document");
  });
});

describe("pure helpers", () => {
  test("settings are cleaned to the shape", () => {
    const s = hc.cleanHelpCentreSettings({ enabled: "yes", spaces: [1, "2", -3, 1, "x"], order: ["c1", "bad", "s2", "c1"], hidden: ["s9", 4], indexing: true, extra: 1 });
    assert.deepEqual(s, { enabled: false, from_spaces: true, spaces: [1, 2], tagged: false, order: ["c1", "s2"], hidden: ["s9"], indexing: true });
  });

  test("stored queries keep no email address or long number", () => {
    assert.equal(hc.redactQuery("Reset for Bob.Smith+x@ClientCo.com order 4412 3345 678"), "reset for [email] order [number]");
    assert.equal(hc.redactQuery("  Export   CSV "), "export csv");
  });

  test("journey ids and article addresses", () => {
    assert.equal(hc.cleanJourneyId("abc"), "");
    assert.equal(hc.cleanJourneyId("a".repeat(32)), "a".repeat(32));
    assert.equal(hc.cleanJourneyId("<script>aaaaaaaaaaaaaaaaaaa"), "");
    assert.equal(hc.articleIdFrom("12-exporting-reports"), 12);
    assert.equal(hc.articleIdFrom("12"), 12);
    assert.equal(hc.articleIdFrom("12abc"), null);
    assert.equal(hc.articleIdFrom("0"), null);
  });

  test("publicBody removes comments exactly as the public search vector does (closed or not)", async () => {
    assert.equal(hc.publicBody("a <!-- x --> b <!-- y\n--> c <!-- open to the end"), "a  b  c ");
    const sql = (await pool().query("SELECT regexp_replace($1, '<!--.*?(-->|$)', '', 'g') AS out", ["a <!-- x --> b <!-- y\n--> c <!-- open to the end"])).rows[0].out;
    assert.equal(sql, "a  b  c ");
  });

  test("IPv6 addresses share one search allowance per /64", () => {
    assert.equal(hc.searchClientKey("2001:db8:1:2:aaaa::1"), hc.searchClientKey("2001:db8:1:2:bbbb:cccc:dddd:9"));
    assert.notEqual(hc.searchClientKey("2001:db8:1:2::1"), hc.searchClientKey("2001:db8:1:3::1"));
    assert.equal(hc.searchClientKey("203.0.113.9"), "203.0.113.9");
  });

  test("'Ask for a new link' always opens the sign-in form", () => {
    for (const f of ["src/components/helpdesk/portal/PortalContinue.tsx", "src/app/(portal)/support/signin/page.tsx"]) {
      const src = readFileSync(path.join(process.cwd(), f), "utf8");
      assert.ok(!/href="\/support"/.test(src), `${f} has no bare /support link`);
      assert.match(src, /href="\/support\?signin=1"/);
    }
  });
});

// --- Routes and stats (the workspace's portal keys, under the lock) ---------------------------

describe("routes and stats", () => {
  before(async () => {
    lockClient = await pool().connect();
    await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK]);
    savedPortal = await getSetting(portal.HD_PORTAL_SETTINGS_KEY);
    savedHc = await getSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY);
    await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portalOn()));
    await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings()));
  });

  after(async () => {
    for (const [key, saved] of [
      [portal.HD_PORTAL_SETTINGS_KEY, savedPortal],
      [hc.HD_HELP_CENTRE_SETTINGS_KEY, savedHc],
    ] as const) {
      if (saved === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [key]);
      else await setSetting(key, saved);
    }
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    lockClient.release();
  });

  test("search route: public articles only, no sign-in, 404 while off", async () => {
    const r = await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(`export ${WORD}`)}`);
    assert.equal(r.status, 200);
    const got = r.body.articles.map((a: { id: number }) => a.id);
    assert.equal(got[0], doc.ok1, "every word first");
    assert.deepEqual([...got].sort((a: number, b: number) => a - b), [doc.ok2, doc.ok1, doc.release, doc.childOfOk].sort((a, b) => a - b), "then any word; still only public ones");
    assert.equal(r.headers.get("cache-control"), "no-store");
    await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings({ enabled: false })));
    try {
      assert.equal((await call(searchRoute.GET, `/support/api/help/search?q=${WORD}`)).status, 404);
      assert.equal((await call(filesRoute.GET, `/support/api/help/files/${att.ok}`, {}, { id: String(att.ok) })).status, 404);
    } finally {
      await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings()));
    }
    await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portal.cleanPortalSettings({ enabled: false })));
    try {
      assert.equal((await call(searchRoute.GET, `/support/api/help/search?q=${WORD}`)).status, 404, "the portal off closes the help centre");
    } finally {
      await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portalOn()));
    }
  });

  test("search route: 40 a minute from one address", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 20}`;
    let last = 0;
    let body: any = null;
    for (let i = 0; i < 41; i++) {
      const r = await call(searchRoute.GET, `/support/api/help/search?q=x${i}`, { ip });
      last = r.status;
      body = r.body;
    }
    assert.equal(last, 429);
    assert.equal(body.limited, true, "a refusal says so, so the page never shows it as 'No articles match'");
    assert.match(body.error, /Too many searches/);
  });

  test("search route: no shared bucket, so busy addresses never switch search off for everyone", async () => {
    // 20 addresses at 35 a minute each: 700, past the old 600 a minute shared cap.
    for (let a = 0; a < 20; a++) {
      const ip = `198.18.${a}.${Math.floor(Math.random() * 200) + 20}`;
      for (let i = 0; i < 35; i++) assert.equal((await call(searchRoute.GET, "/support/api/help/search?q=x", { ip })).status, 200);
    }
    const fresh = await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(`export ${WORD}`)}`, { ip: "198.19.7.7" });
    assert.equal(fresh.status, 200);
    assert.ok(fresh.body.articles.length > 0);
    // An IPv6 /64 is one address: rotating within it buys nothing.
    let v6 = 0;
    for (let i = 0; i < 41; i++) v6 = (await call(searchRoute.GET, "/support/api/help/search?q=x", { ip: `2001:db8:77:${STAMP.slice(-4)}::${(i + 1).toString(16)}` })).status;
    assert.equal(v6, 429);
  });

  test("searches are counted once per typed word, only when the page asked, with no personal data", async () => {
    const j = `${STAMP}${"a".repeat(8)}`;
    for (const q of ["ex", "expo", `export ${WORD}`]) {
      await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(q)}&j=${j}`, { secFetch: "same-origin" });
    }
    let rows = (await pool().query("SELECT q, results, source FROM hd_hc_searches WHERE journey = $1", [j])).rows;
    assert.deepEqual(rows, [{ q: `export ${WORD}`, results: 4, source: "home" }], "typing extends one row");
    // From another site (no Origin / Sec-Fetch-Site of this host): answered, not counted.
    await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(`invoice ${WORD}`)}&j=${j}`, { origin: "http://evil.example" });
    await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(`invoice ${WORD}`)}&j=${j}`);
    rows = (await pool().query("SELECT q FROM hd_hc_searches WHERE journey = $1", [j])).rows;
    assert.equal(rows.length, 1);
    // An email typed into the box is never stored.
    await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(`bob@${STAMP}.clientco.test ${WORD}`)}`, { secFetch: "same-origin" });
    const stored = (await pool().query("SELECT q, journey, source FROM hd_hc_searches WHERE q LIKE $1", [`%${WORD}%`])).rows;
    assert.ok(stored.every((r) => !String(r.q).includes("@")), JSON.stringify(stored));
    assert.ok(stored.some((r) => r.q === `[email] ${WORD}` && r.journey === "" && r.source === "home"));
    const cols = (await pool().query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('hd_hc_searches','hd_hc_journeys')")).rows.map((r) => r.column_name);
    for (const c of ["ip", "contact_id", "user_id", "email", "user_agent"]) assert.ok(!cols.includes(c), `no ${c} column`);
  });

  test("the request form's subject: POST only, same-origin, answered but never stored or counted", async () => {
    const before = Number((await pool().query("SELECT count(*) AS n FROM hd_hc_searches")).rows[0].n);
    const subject = `Payroll error for Priya Shah export ${WORD}`;
    const ok = await call(searchRoute.POST, "/support/api/help/search", { origin: ORIGIN, json: { q: subject } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.articles.some((a: { id: number }) => a.id === doc.ok1));
    assert.equal((await call(searchRoute.POST, "/support/api/help/search", { origin: "http://evil.example", json: { q: subject } })).status, 403);
    // The old address form with src=form is answered but not counted either.
    await call(searchRoute.GET, `/support/api/help/search?src=form&q=${encodeURIComponent(subject)}&j=${STAMP}formjourney00`, { secFetch: "same-origin" });
    const after = Number((await pool().query("SELECT count(*) AS n FROM hd_hc_searches")).rows[0].n);
    assert.equal(after, before, "nothing stored");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_hc_searches WHERE q LIKE '%priya%'")).rows[0].n, 0);
    const src = readFileSync(path.join(process.cwd(), "src/components/helpdesk/portal/help/RequestSuggestions.tsx"), "utf8");
    assert.ok(!/\?q=|&q=/.test(src) && /method: "POST"/.test(src), "the form sends its subject in the body");
  });

  test("the results page counts only searches the help centre's own form opened", async () => {
    const q = `resultspage ${WORD}`;
    const count = async () => (await pool().query("SELECT count(*)::int AS n FROM hd_hc_searches WHERE q = $1", [q])).rows[0].n as number;
    const visit = async (headers: Record<string, string>) => {
      currentRequest = new Request(`${ORIGIN}/support/search?q=${encodeURIComponent(q)}`, { headers: { host: HOST, "x-forwarded-for": `198.51.100.${++ipSeq % 250}`, ...headers } });
      try {
        await resultsPage.default({ searchParams: Promise.resolve({ q }) });
      } finally {
        currentRequest = null;
      }
    };
    await visit({});
    await visit({ "sec-fetch-site": "cross-site" });
    await visit({ "sec-fetch-site": "none" });
    assert.equal(await count(), 0, "a link from elsewhere, a typed address or an unfurl bot counts nothing");
    await visit({ "sec-fetch-site": "same-origin" });
    assert.equal(await count(), 1);
  });

  test("journeys: same-origin only; opened and raised nothing = answered without a request", async () => {
    const before = await hc.helpCentreStats();
    const cross = await call(journeyRoute.POST, "/support/api/help/journey", { origin: "http://evil.example", json: { id: `${STAMP}cross0000000`, event: "open" } });
    assert.equal(cross.status, 403);
    const bad = await call(journeyRoute.POST, "/support/api/help/journey", { origin: ORIGIN, json: { id: `${STAMP}x00000000000`, event: "delete" } });
    assert.equal(bad.status, 400);
    const answered = `${STAMP}answered000`;
    const raised = `${STAMP}raised00000`;
    const fresh = `${STAMP}fresh000000`;
    for (const id of [answered, raised, fresh]) {
      const r = await call(journeyRoute.POST, "/support/api/help/journey", { origin: ORIGIN, json: { id, event: "open" } });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    }
    assert.equal((await call(journeyRoute.POST, "/support/api/help/journey", { origin: ORIGIN, json: { id: raised, event: "submit" } })).body.ok, true);
    assert.equal((await call(journeyRoute.POST, "/support/api/help/journey", { origin: ORIGIN, json: { id: `${STAMP}nojourney00`, event: "submit" } })).body.ok, false, "a submit starts nothing");
    // Settle two of them (older than 30 minutes); the fresh one is still open.
    await pool().query("UPDATE hd_hc_journeys SET started_at = now() - interval '2 hours', last_at = now() - interval '1 hour' WHERE id = ANY($1)", [[answered, raised]]);
    const afterStats = await hc.helpCentreStats();
    assert.equal(afterStats.journeys - before.journeys, 2);
    assert.ok(afterStats.answered_pct !== null);
    const row = (await pool().query("SELECT opened, submitted FROM hd_hc_journeys WHERE id = $1", [answered])).rows[0];
    assert.deepEqual(row, { opened: 1, submitted: false });
  });

  test("a journey survives the emailed sign-in link and ends in the request raised in the new tab", async () => {
    const custEmail = `riley@${STAMP}.clientco.test`;
    fx.team = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 999) RETURNING id", [`${STAMP} HC team`])).rows[0].id;
    fx.type = (await fixtureQuery("INSERT INTO hd_request_types (slug, title, team_id, form, position) VALUES ($1, 'Question', $2, '[]', 999) RETURNING id", [`${STAMP}-hc`, fx.team])).rows[0].id;
    await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portal.cleanPortalSettings({ enabled: true, types: [{ id: fx.type, team_id: null }] })));
    const links = new Map<string, string>();
    portal.setPortalLinkSpyForTests((addr, url) => links.set(addr, url));
    email.setHelpdeskTransportForTests(async () => {});
    const j = `${STAMP}viasignin00`;
    try {
      // Tab A: searched and opened an article, then asked for a sign-in link.
      await call(journeyRoute.POST, "/support/api/help/journey", { origin: ORIGIN, json: { id: j, event: "open" } });
      assert.equal((await call(linkRoute.POST, "/support/api/link", { origin: ORIGIN, json: { email: custEmail, next: "/support/new", j } })).status, 200);
      for (let i = 0; i < 40 && !links.has(custEmail); i++) await new Promise((r) => setTimeout(r, 50));
      const token = new URL(links.get(custEmail)!).searchParams.get("token")!;
      // Tab B (the mail client opened it): spending the link hands the journey over.
      const sess = await call(sessionRoute.POST, "/support/api/session", { origin: ORIGIN, json: { token } });
      assert.equal(sess.status, 200);
      assert.equal(sess.body.journey, j);
      const cookie = /compass_portal=([^;]+)/.exec(sess.headers.get("set-cookie") ?? "")![1];
      // Tab B raises the request with the journey it was handed.
      const f = new FormData();
      for (const [k, v] of Object.entries({ request_type_id: String(fx.type), subject: "Still broken", body: "It broke.", answers: "{}", j })) f.append(k, v);
      const r = new Response(f);
      const buf = Buffer.from(await r.arrayBuffer());
      currentRequest = new Request(`${ORIGIN}/support/api/requests`, {
        method: "POST",
        headers: { host: HOST, origin: ORIGIN, cookie: `compass_portal=${cookie}`, "content-type": r.headers.get("content-type")!, "content-length": String(buf.length), "x-forwarded-for": "198.51.100.200" },
        body: buf,
      });
      let created: Response;
      try {
        created = await requestsRoute.POST(currentRequest);
      } finally {
        currentRequest = null;
      }
      assert.equal(created.status, 201, await created.clone().text());
      const row = (await pool().query("SELECT opened, submitted FROM hd_hc_journeys WHERE id = $1", [j])).rows[0];
      assert.deepEqual(row, { opened: 1, submitted: true }, "not counted as answered without a request");
      // Settled, it is not "answered".
      await pool().query("UPDATE hd_hc_journeys SET started_at = now() - interval '2 hours', last_at = now() - interval '1 hour' WHERE id = $1", [j]);
      const answered = (await pool().query("SELECT count(*)::int AS n FROM hd_hc_journeys WHERE id = $1 AND opened > 0 AND NOT submitted", [j])).rows[0].n;
      assert.equal(answered, 0);
    } finally {
      portal.setPortalLinkSpyForTests(null);
      email.setHelpdeskTransportForTests(null);
      await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portalOn()));
      const tickets = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = $1", [fx.team])).rows.map((x) => x.id);
      await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [tickets]);
      await pool().query("DELETE FROM hd_portal_contacts WHERE email = $1", [custEmail]);
      await pool().query("DELETE FROM audit_log WHERE target_label = $1", [custEmail]);
      await pool().query("DELETE FROM hd_request_types WHERE id = $1", [fx.type]);
      await pool().query("DELETE FROM hd_teams WHERE id = $1", [fx.team]);
    }
  });

  test("files route: a public article's file inline with nosniff; anything else 404", async () => {
    const ok = await call(filesRoute.GET, `/support/api/help/files/${att.ok}`, {}, { id: String(att.ok) });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.match(ok.headers.get("content-security-policy") ?? "", /sandbox/);
    for (const id of [att.draft, att.priv, 999999999]) {
      assert.equal((await call(filesRoute.GET, `/support/api/help/files/${id}`, {}, { id: String(id) })).status, 404);
    }
    assert.equal((await call(filesRoute.GET, "/support/api/help/files/x", {}, { id: "../x" })).status, 404);
    assert.equal(ok.headers.get("accept-ranges"), "bytes");
    // Byte ranges, so Safari and iOS play videos.
    const ranged = async (range: string) => {
      const req = new Request(`${ORIGIN}/support/api/help/files/${att.ok}`, { headers: { host: HOST, range } });
      const res = await filesRoute.GET(req, { params: Promise.resolve({ id: String(att.ok) }) });
      return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
    };
    const part = await ranged("bytes=2-5");
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 2-5/16");
    assert.deepEqual([...part.body], [0x4e, 0x47, 0x0d, 0x0a]);
    const tail = await ranged("bytes=-4");
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get("content-range"), "bytes 12-15/16");
    assert.equal((await ranged("bytes=99-")).status, 416);
  });

  test("settings route: settings.manage only; private spaces refused; nothing chosen refused; saved and audited", async () => {
    const as = (u: { session: string }) => `compass_session=${u.session}`;
    assert.equal((await call(adminRoute.GET, "/api/helpdesk/admin/portal/help-centre")).status, 401);
    assert.equal((await call(adminRoute.GET, "/api/helpdesk/admin/portal/help-centre", { cookie: as(agent) })).status, 403);
    const got = await call(adminRoute.GET, "/api/helpdesk/admin/portal/help-centre", { cookie: as(admin) });
    assert.equal(got.status, 200);
    assert.ok(got.body.spaces.some((s: { id: number; private: boolean }) => s.id === sp.priv && s.private), "a chosen private space is named, to remove it");
    assert.ok(!got.body.spaces.some((s: { id: number }) => s.id === sp.priv2), "a private space nobody chose and this person can't open is never named");
    assert.ok(!JSON.stringify(got.body).includes("Board secret"));
    const sneaky = await call(adminRoute.PUT, "/api/helpdesk/admin/portal/help-centre", { method: "PUT", origin: ORIGIN, cookie: as(admin), json: settings({ spaces: [sp.guides, sp.priv2] }) });
    assert.equal(sneaky.status, 400);
    assert.ok(!JSON.stringify(sneaky.body).includes("Board secret"), "refused without its name");
    assert.deepEqual(Object.keys(got.body.stats).sort(), ["answered_pct", "journeys", "searches", "top_search"]);

    const priv = await call(adminRoute.PUT, "/api/helpdesk/admin/portal/help-centre", { method: "PUT", origin: ORIGIN, cookie: as(admin), json: settings() });
    assert.equal(priv.status, 400);
    assert.match(priv.body.error, /private space/);
    const empty = await call(adminRoute.PUT, "/api/helpdesk/admin/portal/help-centre", { method: "PUT", origin: ORIGIN, cookie: as(admin), json: settings({ spaces: [], tagged: false }) });
    assert.equal(empty.status, 400);
    const agentTry = await call(adminRoute.PUT, "/api/helpdesk/admin/portal/help-centre", { method: "PUT", origin: ORIGIN, cookie: as(agent), json: settings({ spaces: [sp.guides] }) });
    assert.equal(agentTry.status, 403);

    const next = settings({ spaces: [sp.guides, sp.release], hidden: [`c${cat.billing}`], indexing: true });
    const ok = await call(adminRoute.PUT, "/api/helpdesk/admin/portal/help-centre", { method: "PUT", origin: ORIGIN, cookie: as(admin), json: next });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.settings, next);
    const billing = ok.body.categories.find((c: { key: string }) => c.key === `c${cat.billing}`);
    assert.deepEqual(billing, { key: `c${cat.billing}`, name: `Billing and invoices ${STAMP}`, count: 1, hidden: true }, "the admin list keeps hidden categories, marked");
    const audit = (await pool().query("SELECT action, details FROM audit_log WHERE actor_id = $1 AND action = 'helpdesk.portal.help_centre_updated' ORDER BY id DESC LIMIT 1", [admin.id])).rows[0];
    assert.ok(audit, "audited");
    assert.deepEqual(audit.details.spaces, [sp.guides, sp.release]);
    assert.equal(audit.details.indexing, true);
    // The stored settings drive the portal: the hidden category is gone from search.
    const r = await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(`card ${WORD}`)}`);
    assert.ok(!r.body.articles.some((a: { id: number }) => a.id === doc.ok2), "the hidden category's article is out");
    assert.ok(r.body.articles.length > 0, "the others still answer");

    const preview = await call(adminRoute.POST, "/api/helpdesk/admin/portal/help-centre", { origin: ORIGIN, cookie: as(admin), json: { preview: settings({ from_spaces: false, tagged: true }) } });
    assert.equal(preview.status, 200);
    assert.ok(preview.body.categories.some((c: { key: string }) => c.key === `s${sp.other}`), "a preview runs the rule on the unsaved selection");
    assert.ok(!preview.body.categories.some((c: { key: string }) => c.key === `s${sp.priv}`));
  });

  test("the stats: searches and the top search over 30 days", async () => {
    const before = await hc.helpCentreStats();
    for (let i = 0; i < 3; i++) await hc.recordSearch("", `zz top ${WORD}`, 0, "home");
    const s = await hc.helpCentreStats();
    assert.equal(s.searches - before.searches, 3);
    assert.equal(s.top_search, `zz top ${WORD}`.toLowerCase());
  });
});
