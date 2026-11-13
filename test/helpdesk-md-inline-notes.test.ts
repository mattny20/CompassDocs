// Helpdesk 1.19.4 review (Markdown injection): the system-written notes that
// quote a name or a value from outside (an agent's or a requester's name, an
// old subject, a category, a form answer, a chat channel, an alert's
// severity, a mail provider's verdict) Markdown-escape it with
// lib/helpdesk/md-inline, and macros and canned responses fill their
// placeholders the same way, so the desk shows each value as text.
//
// The desk's Markdown is parsed as components/MarkdownView does
// (remark-parse + remark-gfm + remark-directive + remarkDocBlocks). A hostile
// set covers every class: emphasis and code (* _ ` ~), entities (&), literal
// autolinks (www., "_www.", addresses, URLs), line breaks (\n, U+2028), links,
// images, HTML, line-start block markers of each kind (# - + * = > 1. 1)
// rules, setext underlines, indented code, fences), tables, footnotes and
// definitions, and directive names of every kind (letters, digits, non-ASCII,
// emoji, "10:30"). Each value goes into every position of a line (middle,
// start, a line of its own, under a paragraph line, after a blank line, a list
// item, above a table delimiter) and must stay text there, with its visible
// text intact. A has-teeth check proves each class is Markdown when raw.
// Then the writers: newbie review, auto-assignment, the recycle bin, share,
// the ticket's language, a removed skill, ticket updates, incidents (declare,
// link, unlink, the rule), merge, alert intake, inbound mail's sender check,
// chat, the workflow engine's task note (a description template with
// {{answer}} at line starts) and macro and canned placeholder filling.
//
// Same harness as test/helpdesk-checklists: next/headers and lib/ee stubbed.
// Parallel-safe: teams, accounts, tickets and integrations are this file's
// own (STAMP); the role matrix is overridden in-process only.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-md-inline-notes.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-md-inline-notes.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-md-inline-notes.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(),
    cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const { mdInline } = require("../src/lib/helpdesk/md-inline") as typeof import("../src/lib/helpdesk/md-inline");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const rolesShared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const review = require("../src/lib/helpdesk/review") as typeof import("../src/lib/helpdesk/review");
const assignStore = require("../src/lib/helpdesk/assignment/store") as typeof import("../src/lib/helpdesk/assignment/store");
const assignShared = require("../src/lib/helpdesk/assignment/shared") as typeof import("../src/lib/helpdesk/assignment/shared");
const assignEngine = require("../src/lib/helpdesk/assignment/engine") as typeof import("../src/lib/helpdesk/assignment/engine");
const bin = require("../src/lib/helpdesk/recycle-bin") as typeof import("../src/lib/helpdesk/recycle-bin");
const share = require("../src/lib/helpdesk/share") as typeof import("../src/lib/helpdesk/share");
const skills = require("../src/lib/helpdesk/skills/store") as typeof import("../src/lib/helpdesk/skills/store");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const incidents = require("../src/lib/helpdesk/incidents") as typeof import("../src/lib/helpdesk/incidents");
const incShared = require("../src/lib/helpdesk/incidents-shared") as typeof import("../src/lib/helpdesk/incidents-shared");
const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const intake = require("../src/lib/helpdesk/intake/intake") as typeof import("../src/lib/helpdesk/intake/intake");
const integrations = require("../src/lib/helpdesk/intake/integrations") as typeof import("../src/lib/helpdesk/intake/integrations");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const chat = require("../src/lib/helpdesk/chat/core") as typeof import("../src/lib/helpdesk/chat/core");
const macros = require("../src/lib/helpdesk/macros") as typeof import("../src/lib/helpdesk/macros");
const canned = require("../src/lib/helpdesk/canned-shared") as typeof import("../src/lib/helpdesk/canned-shared");
const engine = require("../src/lib/helpdesk/engine") as typeof import("../src/lib/helpdesk/engine");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const push = require("../src/lib/helpdesk/push") as typeof import("../src/lib/helpdesk/push");
const withTx = (require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core")).withTx;
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdFormField, HdWorkflowStepB } from "../src/lib/helpdesk/types";
import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";

// --- The hostile set ---------------------------------------------------------------

/** One value per class (the key names the class). */
const CLASSES: Record<string, string> = {
  emphasis: "*em* **strong** _u_ __uu__",
  code: "run `rm -rf` now",
  strike: "~~gone~~ ~one~",
  entity: "Tom &amp; Jerry &#60;b&#62; &copy;",
  www: "see www.evil.example now",
  wwwAfterUnderscore: "a_www.evil.example",
  wwwLeadingUnderscore: "_www.evil.example/x",
  // micromark drops a leading byte-order mark, so a marker behind it counts.
  bomHeading: "﻿# heading",
  bomList: "﻿- item",
  bomOrdered: "﻿1. item",
  bomCode: "﻿    indented",
  email: "mail x@evil.example now",
  mailto: "mailto:y@evil.example",
  url: "go https://evil.example/p or HTTP://E.EXAMPLE",
  newline: "first\n# second",
  lineSeparator: "first\u2028- second",
  link: "[x](https://evil.example)",
  reference: "[y]\n\n[y]: https://evil.example",
  image: "![i](https://e.example/x.png)",
  angleLink: "<https://evil.example>",
  html: "<b>bold</b> <img src=x onerror=alert(1)>",
  heading: "# Urgent",
  heading6: "###### six",
  headingNoSpace: "#",
  bullet: "- item",
  plus: "+ item",
  star: "* item",
  ordered: "1. first",
  orderedParen: "1) first",
  orderedYear: "1984. Ops",
  rule: "---",
  ruleStars: "***",
  ruleUnderscores: "___",
  ruleSpaced: "- - -",
  setextEquals: "===",
  quote: "> quoted",
  indented: "    indented code",
  tab: "\tindented code",
  fence: "```js",
  tildeFence: "~~~",
  table: "| a | b |",
  footnote: "note[^1]\n\n[^1]: https://evil.example",
  definition: "[1]: https://evil.example",
  directiveText: "x :t[y]",
  directiveDigit: "x:9[lbl]",
  time: "Meeting at 10:30 today",
  directiveCjk: "件名:テスト",
  directiveLatin1: "Ops:Ünal",
  directiveEmoji: "x :😀y",
  directiveLeaf: "::video[x]{src=https://evil.example}",
  directiveContainer: ":::note",
  backslash: "a\\*b",
};

/** One line holding a bit of everything, for the writers that take one name. */
// Under 200 characters with any actor's prefix, so no writer's cap cuts it.
const MIX = "*e* _u_ `c` ~~d~~ &amp; www.e.example a_www.e.example x@e.example https://e.example [x](https://e.example) ![i](/x.png) <b>h</b> :t[y] x:9[l] 10:30 件名:テ x :😀y [^1] |a|\u2028+ n";

/** Where a value can land in a line of Markdown. */
const POSITIONS: Record<string, (v: string) => string> = {
  middle: (v) => `Note: ${v} end.`,
  start: (v) => `${v} end.`,
  alone: (v) => v,
  underParagraph: (v) => `Line one\n${v}`,
  afterBlank: (v) => `Intro\n\n${v}\n\nOutro`,
  listItem: (v) => `- ${v}`,
  aboveDelimiter: (v) => `${v}\n| --- | --- |`,
};

/** What a reader sees of a value: line breaks are spaces, outer spaces dropped. */
// mdInline drops control characters and the byte-order mark (U+FEFF) on purpose.
const visible = (v: string) => v.replace(/[\ufeff]/g, "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/^[ \t]+|[ \t]+$/g, "");

// --- The desk's Markdown (the syntax half of components/MarkdownView) ----------

type Node = { type: string; value?: string; children?: Node[] };
let parse: (md: string) => Node;
let plain: (n: Node) => string;
const BANNED = [
  "heading",
  "list",
  "listItem",
  "thematicBreak",
  "blockquote",
  "table",
  "code",
  "inlineCode",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "html",
  "textDirective",
  "leafDirective",
  "containerDirective",
  "footnoteReference",
  "footnoteDefinition",
  "definition",
];

function typesOf(n: Node, out = new Set<string>()): Set<string> {
  out.add(n.type);
  for (const c of n.children ?? []) typesOf(c, out);
  return out;
}

/**
 * Banned nodes in a tree. `lists` allows lists the template wrote, at the top level only;
 * `strong` the template's own bold labels, by their exact text.
 */
function bannedIn(tree: Node, lists = false, strong: string[] = []): string[] {
  const found = new Set<string>();
  const walk = (n: Node, depth: number, inItem: boolean) => {
    const listOk = lists && ((n.type === "list" && depth === 1) || (n.type === "listItem" && depth === 2));
    const strongOk = n.type === "strong" && strong.includes(plain(n).replace(/\u2060/g, ""));
    if (BANNED.includes(n.type) && !listOk && !strongOk) found.add(n.type);
    if (inItem && n.type === "list") found.add("nested list");
    for (const c of n.children ?? []) walk(c, depth + 1, inItem || n.type === "listItem");
  };
  walk(tree, 0, false);
  return [...found];
}

const text = (md: string) => plain(parse(md)).replace(/\u2060/g, "");

/** The body shows each value as text: nothing in it became Markdown, and its text is all there. */
function assertInert(body: string, values: string[], why: string, opts: { lists?: boolean; strong?: string[] } = {}) {
  const bad = bannedIn(parse(body), opts.lists, opts.strong);
  assert.deepEqual(bad, [], `${why}: ${bad.join(", ")} in ${JSON.stringify(body)}`);
  const shown = text(body);
  for (const v of values) assert.ok(shown.includes(visible(v)), `${why}: the visible text lost ${JSON.stringify(visible(v))}: ${JSON.stringify(shown)}`);
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdmdn-${Date.now()}-${process.pid}`;
const P: Record<string, { id: number; name: string; email: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const ticketIds: number[] = [];
const workflowIds: number[] = [];
const typeIds: number[] = [];
const integrationIds: number[] = [];
let calendarId = 0;

// The actors' names start with a different line-start marker each, then carry everything else.
const NAMES = {
  evil: `# ${MIX} agent`,
  evil2: `1. ${MIX} colleague`,
  newbie: `    - ${MIX} newbie`,
  mgr: `+ ${MIX} manager`,
};

async function person(key: string, name: string, deskRole: string | null) {
  const mail = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${key}`, name, mail]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[key] = { id, name, email: mail };
}

async function ticket(subject: string, team: string, status = "open"): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source) VALUES ($1, $2, 'Req', $3, $4, $5, 'portal') RETURNING id, number",
    [`${subject} ${STAMP}`, P.req.id, P.req.email, T[team], status]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

const internal = async (ticketId: number) =>
  (await pool().query<{ body: string }>("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'internal' ORDER BY id", [ticketId])).rows.map((r) => r.body);
const firstMessage = async (ticketId: number) =>
  (await pool().query<{ body: string }>("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' ORDER BY id LIMIT 1", [ticketId])).rows[0]?.body ?? "";
const actor = (k: keyof typeof NAMES | "req") => ({ id: P[k].id, role: "viewer" as const, name: P[k].name, username: P[k].name, email: P[k].email });

before(async () => {
  const { unified } = await import("unified");
  const remarkParse = (await import("remark-parse")).default;
  const remarkGfm = (await import("remark-gfm")).default;
  const remarkDirective = (await import("remark-directive")).default;
  const { remarkDocBlocks } = await import("../src/lib/doc-blocks");
  const { toString } = await import("mdast-util-to-string");
  const proc = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).use(remarkDocBlocks);
  parse = (md) => proc.runSync(proc.parse(md)) as unknown as Node;
  plain = (n) => toString(n as never);

  await getSetting("__schema_bootstrap__");
  await assignStore.assignmentReady();
  roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
  email.setHelpdeskTransportForTests(async () => {});
  push.setPushTransportForTests(async () => ({ status: 201, headers: {} }) as never);
  const cal = await pool().query("INSERT INTO hd_calendars (name, timezone, schedule) VALUES ($1, 'UTC', $2) RETURNING id", [
    `${STAMP} open`,
    JSON.stringify(Array.from({ length: 7 }, () => [{ start: "00:00", end: "24:00" }])),
  ]);
  calendarId = cal.rows[0].id;
  for (const k of ["A", "RR"]) {
    const r = await fixtureQuery("INSERT INTO hd_teams (name, position, calendar_id) VALUES ($1, 9450, $2) RETURNING id", [`${STAMP} ${k}`, calendarId]);
    T[k] = r.rows[0].id;
  }
  await person("evil", NAMES.evil, "agent");
  await person("evil2", NAMES.evil2, "agent");
  await person("newbie", NAMES.newbie, "newbie");
  await person("mgr", NAMES.mgr, "manager");
  await person("req", "Rae Requester", null);
  await pool().query(
    "INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($1, $4, 'agent'), ($1, $5, 'agent'), ($6, $2, 'agent')",
    [T.A, P.evil.id, P.evil2.id, P.newbie.id, P.mgr.id, T.RR]
  );
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  email.setHelpdeskTransportForTests(null);
  push.setPushTransportForTests(null);
  const extra = await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR integration_id = ANY($2) OR subject LIKE $3", [
    Object.values(T),
    integrationIds,
    `%${STAMP}%`,
  ]);
  const roots = [...new Set([...ticketIds, ...extra.rows.map((r) => r.id as number)])];
  const kids = await pool().query("SELECT id FROM hd_tickets WHERE parent_ticket_id = ANY($1)", [roots]);
  const all = [...new Set([...roots, ...kids.rows.map((r) => r.id as number)])];
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL, merged_into = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_incidents WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_alert_keys WHERE integration_id = ANY($1)", [integrationIds]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_integrations WHERE id = ANY($1)", [integrationIds]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1)", [workflowIds]);
  await pool().query("DELETE FROM hd_skills WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM hd_calendars WHERE id = $1", [calendarId]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = ANY($1)", [all.map(String)]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- mdInline itself -----------------------------------------------------------------

describe("mdInline: every class stays text, wherever in a line it lands", () => {
  test("a value ending in www, then the template's own '.', is no link", () => {
    const raw = "Cannot reach www";
    assert.ok(bannedIn(parse(`About ${raw}. Thanks.`), false).includes("link"), "raw: the check has teeth");
    const md = `About ${mdInline(raw)}. Thanks.`;
    assert.deepEqual(bannedIn(parse(md), false), [], md);
    assert.ok(text(md).replace(/\u2060/g, "").includes(raw), md);
  });
  test("the raw values are Markdown (the check has teeth, class by class)", () => {
    for (const [cls, raw] of Object.entries(CLASSES)) {
      const acts = Object.entries(POSITIONS).some(([where, at]) => {
        const md = at(raw);
        return bannedIn(parse(md), where === "listItem").length > 0 || !text(md).includes(visible(raw));
      });
      assert.ok(acts, `${cls}: ${JSON.stringify(raw)} raw is plain text everywhere, so the check proves nothing`);
    }
    // And each kind acts where the escape has to stop it.
    for (const cls of ["heading", "bullet", "plus", "star", "ordered", "orderedParen", "orderedYear", "rule", "ruleSpaced", "quote", "indented", "tab", "fence"]) {
      assert.ok(bannedIn(parse(POSITIONS.afterBlank(CLASSES[cls]))).length > 0, `${cls} at a line start`);
    }
    for (const cls of ["setextEquals", "rule"]) assert.ok(typesOf(parse(POSITIONS.underParagraph(CLASSES[cls]))).has("heading"), `${cls} under a paragraph`);
    for (const cls of ["time", "directiveDigit", "directiveCjk", "directiveLatin1", "directiveEmoji"]) {
      assert.ok(typesOf(parse(POSITIONS.middle(CLASSES[cls]))).has("textDirective"), `${cls} is a directive raw`);
    }
    // ("mailto:y@…" reads as the directive ":y" first, which the loop above counts.)
    for (const cls of ["www", "wwwAfterUnderscore", "wwwLeadingUnderscore", "email", "url"]) {
      assert.ok(typesOf(parse(POSITIONS.middle(CLASSES[cls]))).has("link"), `${cls} is a link raw`);
    }
  });

  test("escaped, no class becomes Markdown in any position, and its text is all there", () => {
    for (const [cls, raw] of Object.entries(CLASSES)) {
      const v = mdInline(raw);
      for (const [where, at] of Object.entries(POSITIONS)) {
        assertInert(at(v), [raw], `${cls} (${where})`, { lists: where === "listItem" });
        if (where === "listItem") {
          const lists = (parse(at(v)).children ?? []).filter((n) => n.type === "list");
          assert.equal(lists.length, 1, `${cls}: one list`);
          assert.equal(lists[0].children?.length, 1, `${cls}: one item`);
        }
      }
    }
    for (const [where, at] of Object.entries(POSITIONS)) assertInert(at(mdInline(MIX)), [MIX], `the mix (${where})`, { lists: where === "listItem" });
  });

  test("the visible text is the value's own (\"Meeting at 10:30 today\" reads exactly that)", () => {
    assert.equal(text(mdInline("Meeting at 10:30 today")), "Meeting at 10:30 today");
    assert.equal(text(`Renamed from ${mdInline("Meeting at 10:30 today")} to x`), "Renamed from Meeting at 10:30 today to x");
    for (const s of ["件名:テスト", "Ops:Ünal", "x :😀y", "1984. Ops", "# Urgent", "a_www.evil.example", "Tom &amp; Jerry", "MacBook Pro 14 (2024)", "Leaver: IT", "a\\*b"]) {
      assert.equal(text(mdInline(s)), s, s);
    }
    // Only outer spaces and line breaks change.
    assert.equal(text(mdInline("    indented code")), "indented code");
    assert.equal(text(mdInline("first\nsecond")), "first second");
    assert.equal(mdInline(null), "");
  });
});

// --- Macros and canned responses ----------------------------------------------------------

describe("macros and canned responses fill placeholders as text", () => {
  const ctx = (subject: string, name = "Matthew Felix") => ({
    requester: { name, email: "m@example.test" },
    ticket: { number: 1047, subject, status: "pending" as const, priority: "high" as const },
    team: { name: "IT" },
    agent: { name: "Priya Shah", email: "p@example.test" },
    org: { name: "Acme" },
    origin: "https://docs.example.test",
  });
  const MACRO = "Hi {{requester.first_name}},\n{{ticket.subject}}\n\nAbout {{ticket.subject}} ({{requester.name}}).\n\n{{ticket.subject}}\n\nThanks";

  test("a macro's {{ticket.subject}} and {{requester.name}} never become a link, a directive or a block", () => {
    for (const [cls, raw] of Object.entries(CLASSES)) {
      assertInert(macros.renderMacro(MACRO, ctx(raw, raw)), [raw], `macro ${cls}`);
    }
    // The verifier's two: an autolink and a directive.
    for (const raw of ["see www.evil.example", "x :t[y]"]) {
      const types = typesOf(parse(macros.renderMacro("Re: {{ticket.subject}}", ctx(raw))));
      assert.ok(!types.has("link") && !types.has("textDirective"), raw);
    }
    // The macro's own Markdown and link stay.
    const own = typesOf(parse(macros.renderMacro("**Hi** {{ticket.url}}", ctx("x"))));
    assert.ok(own.has("link") && own.has("strong"));
  });

  test("a canned response's names never become a link, a directive or a block", () => {
    const BODY = "{{requester.name}}\n\nHi {{requester.name}}, from {{team.name}}.\n\n- {{agent.name}}";
    for (const [cls, raw] of Object.entries(CLASSES)) {
      const out = canned.renderCanned(BODY, { requesterName: raw, ticketNumber: 7, teamName: raw, agentName: raw });
      assertInert(out, [raw], `canned ${cls}`, { lists: true });
    }
    for (const raw of ["see www.evil.example", "x :t[y]"]) {
      const types = typesOf(parse(canned.renderCanned("Hi {{requester.name}}", { requesterName: raw, ticketNumber: 7, teamName: "", agentName: "" })));
      assert.ok(!types.has("link") && !types.has("textDirective"), raw);
    }
  });
});

// --- Chat -----------------------------------------------------------------------------

describe("chat: a ticket opened from a channel", () => {
  test("the agent's internal note names the agent and the channel as text", () => {
    for (const [cls, raw] of Object.entries(CLASSES)) assertInert(chat.channelOpenedNote(raw, "teams", { name: raw }), [raw], `chat note ${cls}`);
  });

  test("the requester's first message names the channel with no backslash (Get help shows it as plain text) and nothing Markdown", () => {
    assert.equal(chat.channelTicketBody("help", "slack", { name: "it_help" }), "help\n\n(From #it_help in Slack)");
    assert.equal(chat.channelTicketBody("help", "slack", { name: "ops-team_2" }), "help\n\n(From #ops-team_2 in Slack)");
    for (const [cls, raw] of Object.entries(CLASSES)) {
      const body = chat.channelTicketBody("help", "teams", { name: raw });
      assert.ok(!body.includes("\\"), `${cls}: ${JSON.stringify(body)}`);
      const bad = bannedIn(parse(body));
      assert.deepEqual(bad, [], `${cls}: ${bad.join(", ")} in ${JSON.stringify(body)}`);
      assert.match(body, /\n\n\(From #.+ in Teams\)$/, cls);
    }
    // A permalink stays the link it was.
    assert.ok(typesOf(parse(chat.channelTicketBody("help", "slack", { name: "x" }, "https://acme.slack.com/archives/C1/p1"))).has("link"));
  });
});

// --- Writers with a database ------------------------------------------------------------

describe("system-written internal notes show names as text", () => {
  test("review: approving a newbie's held reply names the reviewer and the newbie as text", async () => {
    const t = await ticket("Review", "A");
    const m = await pool().query(
      "INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, review_state) VALUES ($1, $2, $3, 'public', 'Try restarting it.', 'desk', 'pending') RETURNING id",
      [t.id, P.newbie.id, P.newbie.name]
    );
    await review.decideReview(actor("mgr"), m.rows[0].id, { decision: "approve" });
    const note = (await internal(t.id)).find((b) => b.includes("approved"));
    assert.ok(note, "the approval line");
    assertInert(note!, [NAMES.mgr, `${NAMES.newbie}'s reply`], "review approve");
  });

  test("assignment: round robin names the person it picked as text", async () => {
    const cur = await assignStore.getTeamAssignment(T.RR);
    const v = assignShared.validateTeamAssignment({ mode: "round_robin", include_roles: ["agent"] }, cur);
    assert.ok(v.ok, v.ok ? "" : v.error);
    await assignStore.saveTeamAssignment(v.value, null);
    const t = await ticket("Assign", "RR", "new");
    const r = await assignEngine.assignTicket(t.id, { trigger: "created" });
    assert.equal(r.outcome, "assigned", r.reason);
    assert.equal(r.user_id, P.evil.id);
    // The caller and the log keep the raw sentence; only the stored note is escaped.
    assert.ok(r.reason.includes(NAMES.evil));
    const note = (await internal(t.id)).find((b) => b.startsWith("Assigned to"));
    assert.ok(note, "the assignment note");
    assertInert(note!, [NAMES.evil], "assignment");
  });

  test("recycle bin: moving to the bin and restoring name the actor as text", async () => {
    const t = await ticket("Bin", "A");
    const a = { id: P.evil.id, name: P.evil.name };
    await withTx((c) => bin.binTicketTx(c, t.id, a));
    await withTx((c) => bin.restoreTicketTx(c, t.id, a));
    const notes = await internal(t.id);
    const moved = notes.find((b) => b.includes("moved this ticket to the recycle bin"));
    const restored = notes.find((b) => b.includes("restored this ticket from the recycle bin"));
    assert.ok(moved && restored, JSON.stringify(notes));
    assertInert(moved!, [NAMES.evil], "bin");
    assertInert(restored!, [NAMES.evil], "restore");
  });

  test("share: the share line names the sharer and the recipient as text", async () => {
    const t = await ticket("Share", "A");
    const full = await tickets.getTicketByNumber(t.number);
    await share.shareTicket({ id: P.evil.id, role: "viewer", name: P.evil.name }, full!, { user_ids: [P.evil2.id], message: "", follow: false });
    const line = (await internal(t.id)).find((b) => b.includes("shared this with"));
    assert.ok(line, "the share line");
    assertInert(line!, [NAMES.evil, NAMES.evil2], "share");
  });

  test("skills: setting the ticket's language and removing a skill name the agent and the skill as text", async () => {
    const t = await ticket("Language", "A");
    await skills.setTicketLanguage(t.id, "fr", { id: P.evil.id, name: P.evil.name });
    const line = (await internal(t.id)).find((b) => b.includes("set the language to"));
    assert.ok(line, "the language line");
    assertInert(line!, [NAMES.evil], "language");

    const skillName = `- ${MIX} ${STAMP}`;
    const s = await skills.createSkill(skillName, null);
    const q = await ticket("Waiting", "A");
    await assignStore.queueTicket(q.id, "test", { kind: "skills", skills: { language: null, skill_ids: [s.id], fallback: "queue" } } as never, new Date());
    const out = await skills.deleteSkill(s.id);
    assert.equal(out?.tickets, 1);
    const note = (await internal(q.id)).find((b) => b.includes("was removed"));
    assert.ok(note, "the removal note");
    assertInert(note!, [skillName], "skill removed");
  });

  test("ticket updates: rename, team, assignee and category lines show the values as text", async () => {
    const t = await ticket(MIX, "RR");
    // 1.20.6: a category is one from the admin's list (lib/helpdesk/categories): this run's own entry, removed below.
    const category = `# x:9[l] *e* www.e.example 10:30 ${STAMP}`;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const categories = require("../src/lib/helpdesk/categories") as typeof import("../src/lib/helpdesk/categories");
    await categories.createCategory({ name: category }, { id: null });
    await tickets.updateTicket(t.id, { subject: `Plain ${STAMP}`, team_id: T.A, assignee_id: P.evil2.id, category }, { id: P.evil.id, name: P.evil.name }, { silent: true });
    const notes = await internal(t.id);
    const expect: Record<string, string[]> = {
      "renamed the ticket from": [NAMES.evil, `${MIX} ${STAMP}`],
      "moved the ticket to": [NAMES.evil],
      "assigned the ticket to": [NAMES.evil, NAMES.evil2],
      "set the category to": [NAMES.evil, category],
    };
    for (const [what, values] of Object.entries(expect)) {
      const line = notes.find((b) => b.includes(what));
      assert.ok(line, `${what}: ${JSON.stringify(notes)}`);
      assertInert(line!, values, what);
    }
    await pool().query("UPDATE hd_tickets SET category = '' WHERE id = $1", [t.id]);
    await pool().query("DELETE FROM hd_categories WHERE name = $1", [category]);
  });

  test("incidents: declare, link, unlink and the rule's line name people and the rule as text", async () => {
    const word = `zq${Date.now().toString(36)}`;
    const linked = await ticket("Linked", "A");
    const input = incShared.validateDeclare({ team_id: T.A, title: `${STAMP} VPN is down`, numbers: [], match_text: word });
    const d = await incidents.declareIncident(actor("mgr"), input);
    await d.notices;
    ticketIds.push(d.ticket_id);
    const parent = (await pool().query("SELECT number FROM hd_tickets WHERE id = $1", [d.ticket_id])).rows[0].number as number;
    const declared = (await internal(d.ticket_id)).find((b) => b.includes("declared a major incident"));
    assert.ok(declared, "the declared note");
    assertInert(declared!, [NAMES.mgr], "incident declared");

    const l = await incidents.linkTickets(actor("mgr"), parent, [linked.number]);
    await l.notices;
    assert.deepEqual(l.linked, [linked.number], JSON.stringify(l.results));
    const u = await incidents.unlinkTicket(actor("mgr"), linked.number);
    assert.equal(u.ticket_number, linked.number);
    for (const [id, what] of [
      [linked.id, "linked this ticket to major incident"],
      [d.ticket_id, `linked #${linked.number} to this incident`],
      [linked.id, "unlinked this ticket from major incident"],
      [d.ticket_id, `unlinked #${linked.number} from this incident`],
    ] as const) {
      const line = (await internal(id)).find((b) => b.includes(what));
      assert.ok(line, what);
      assertInert(line!, [NAMES.mgr], what);
    }

    // The rule's own words, as stored (a rule saved before today's checks may hold anything).
    const rule = `${word}, ${MIX}`;
    await pool().query("UPDATE hd_incidents SET match_text = $2 WHERE ticket_id = $1", [d.ticket_id, rule]);
    const hit = await tickets.createTicket(
      { subject: `${STAMP} my ${word} is broken`, body: "help", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, team_id: T.A, source: "portal" },
      {}
    );
    ticketIds.push(hit.id);
    const ruleLine = (await internal(hit.id)).find((b) => b.includes("by its rule"));
    assert.ok(ruleLine, "the rule's line");
    assertInert(ruleLine!, [rule], "incident rule");
    await pool().query("UPDATE hd_tickets SET status = 'solved' WHERE id = $1", [d.ticket_id]);
  });

  test("merge: the kept ticket's line names the merger as text", async () => {
    const keep = await ticket("Keep", "A");
    const gone = await ticket("Gone", "A");
    await merge.mergeTickets({ id: P.evil.id, role: "viewer", name: P.evil.name }, { keep: keep.number, merge: [gone.number], notify: false });
    const line = (await internal(keep.id)).find((b) => b.includes("into this ticket"));
    assert.ok(line, "the merge line");
    assertInert(line!, [NAMES.evil], "merge");
  });
});

describe("alert intake, inbound mail and the workflow engine", () => {
  const FACT_LABELS = ["Severity:", "Source:"];
  test("intake: the opening message's severity and source, and the 'Fired again' line, are text", async () => {
    for (const [cls, raw] of Object.entries(CLASSES)) {
      const p = intake.prepareAlert(
        { severity_map: {}, default_priority: "normal" },
        { title: "Disk full", description: "", severity: raw, status: "firing", dedup_key: "k", source: raw, links: [], fields: {} }
      );
      // plainLine (intake/sanitize) already folds whitespace and turns tags to text; what is left must stay text.
      const facts = intake.openingBody(p, null).split("\n\n").find((b) => b.startsWith("**Severity:**"));
      if (!p.severityLabel) continue;
      assert.ok(facts, `${cls}: ${intake.openingBody(p, null)}`);
      assertInert(facts!, [p.severityLabel, p.source], `intake ${cls}`, { strong: FACT_LABELS });
    }

    const input = integrations.validateIntegrationInput({ kind: "grafana", name: `${STAMP} Monitoring`, default_team_id: T.A }, { create: true });
    const created = await integrations.createIntegration(input, null);
    integrationIds.push(created.integration.id);
    const row = (await integrations.getIntegration(created.integration.id))!;
    const severity = "# x:9[l] www.e.example 10:30";
    const alert = { title: `${STAMP} Disk full`, description: "", severity, status: "firing" as const, dedup_key: `${STAMP}-k`, source: MIX, links: [], fields: {} };
    await intake.processAlerts(row, [alert]);
    await intake.processAlerts(row, [alert]);
    const t = (await pool().query("SELECT id FROM hd_tickets WHERE integration_id = $1", [row.id])).rows[0];
    assert.ok(t, "the alert's ticket");
    ticketIds.push(t.id);
    const opening = await firstMessage(t.id);
    const prepared = intake.prepareAlert(row, alert);
    assertInert(opening.split("\n\n").find((b) => b.startsWith("**Severity:**"))!, [prepared.severityLabel, prepared.source], "opening facts", { strong: FACT_LABELS });
    const fired = (await internal(t.id)).find((b) => b.startsWith("Fired again"));
    assert.ok(fired, "the Fired again line");
    assertInert(fired!, [severity], "fired again");
  });

  test("inbound: the sender-check line names the provider's verdict (a www. domain) as text", async () => {
    const r = await inbound.processInboundEmail(
      {
        provider: "generic",
        from: { email: P.req.email, name: "" },
        to: [{ email: `${STAMP}-it@example.test`, name: "" }],
        cc: [],
        recipients: [],
        subject: `${STAMP} Printer jammed`,
        text: "The third-floor printer is jammed.",
        html: "",
        stripped: "",
        messageId: `${newToken()}@mail.example.test`,
        inReplyTo: "",
        references: [],
        headers: {},
        auth: { dkim: "{@www.evil.example : pass}" },
        files: [],
      } as unknown as InboundEmail,
      { outsideSenders: true, trustUnverified: false }
    );
    assert.equal(r.body.outcome, "created", JSON.stringify(r.body));
    const t = (await pool().query("SELECT id FROM hd_tickets WHERE number = $1", [r.body.ticket])).rows[0];
    ticketIds.push(t.id);
    const verdict = "DKIM pass for www.evil.example (not aligned)";
    const line = (await internal(t.id)).find((b) => b.includes("failed the sender check"));
    assert.ok(line, "the sender-check line");
    assertInert(line!, [verdict], "inbound sender check");
    assert.ok(typesOf(parse(verdict)).has("link"), "raw, the verdict would be a link");
  });

  test("workflow engine: a task's opening note keeps {{answers}} at line starts, the answers list and the hand-back list as text", async () => {
    const entries = Object.entries(CLASSES);
    for (let at = 0; at < entries.length; at += 20) {
      const chunk = entries.slice(at, at + 20);
      const form: HdFormField[] = chunk.map(([cls], i) => ({ key: `a${i}`, label: `Answer ${cls}`, type: "textarea" }));
      // Each answer on a line of its own, under a paragraph line, and as a list item.
      const description = chunk.map((_, i) => `{{a${i}}}\n\nLine\n{{answer.a${i}}}\n\n- {{a${i}}}`).join("\n\n") + "\n\nFor {{requester}}:\n{{subject}}\n\n{{tasks}}";
      // The admin's words too: a task title and an output label that start like a list and a heading.
      const title = "1. Do it :t[y] www.e.example";
      const label = "# Out 10:30 www.e.example";
      const steps: HdWorkflowStepB[] = [
        { key: "t1", kind: "task", title, team_id: T.A, description, outputs: [{ key: "o1", label, type: "text" }] },
        { key: "t2", kind: "task", title: "Second", team_id: T.A, description: "Next." },
        { key: "done", kind: "finish", title: "Solve", csat: false },
      ];
      const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} Flow ${at}` });
      const def = workflows.parseWorkflowDefinition({ steps });
      assert.ok(meta.ok && def.ok, !def.ok ? def.error : "meta");
      if (!meta.ok || !def.ok) return;
      const wf = await workflows.createWorkflow(meta.value, def.value);
      workflowIds.push(wf.id);
      const rti = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Type ${at}`, team_id: T.A, form, workflow_id: wf.id });
      assert.ok(rti.ok, !rti.ok ? rti.error : "");
      if (!rti.ok) return;
      const rt = await requestTypes.createRequestType(rti.value);
      typeIds.push(rt.id);
      const pub = await workflows.publishWorkflow(wf.id);
      assert.ok(pub.ok, !pub.ok ? pub.error : "");
      const answers = Object.fromEntries(chunk.map(([, raw], i) => [`a${i}`, raw]));
      const subject = `# ${STAMP} 10:30 www.e.example`;
      const t = await tickets.createTicket(
        { subject, body: "Please.", requester: { id: P.req.id, name: NAMES.evil, email: P.req.email }, request_type_id: rt.id, answers: answers as never },
        { silent: true, actorId: P.req.id, actorName: P.req.name }
      );
      ticketIds.push(t.id);
      const kid = (await pool().query("SELECT id FROM hd_tickets WHERE parent_ticket_id = $1 ORDER BY id LIMIT 1", [t.id])).rows[0];
      assert.ok(kid, "the task's ticket");
      const note = (await internal(kid.id)).join("\n\n");
      assert.ok(note.includes("**Answers on the request**") && note.includes("Hand back when done"), note);
      // The answers as the form keeps them (trimmed), in every place the note puts them; the
      // note's own bold labels are the only strong text, and its lists are flat.
      const values = chunk.map(([, raw]) => raw.trim());
      const labels = ["Answers on the request", "Hand back when done", ...form.map((f) => f.label)];
      assertInert(note, [...values, NAMES.evil, subject, title, label], `workflow chunk ${at}`, { lists: true, strong: labels });
      const items = (parse(note).children ?? []).filter((n) => n.type === "list").reduce((k, l) => k + (l.children?.length ?? 0), 0);
      // Per answer: the template's item and the answers list's; then the hand-back item and the task line.
      assert.equal(items, chunk.length * 2 + 2, "one list item per line the note wrote");

      // The outcome, with a hand-off: its line on the task, and the next task's "Hand-offs so far".
      const handed = `- ${MIX}`;
      const r = await engine.recordTaskOutcome({ id: P.evil.id, name: NAMES.evil, username: NAMES.evil }, kid.id, { outcome: "done", note: handed, outputs: { o1: handed }, handoff_note: handed });
      assert.ok(r.ok, JSON.stringify(r));
      const recorded = (await internal(kid.id)).find((b) => b.includes("recorded the outcome"));
      assert.ok(recorded, "the outcome line");
      assertInert(recorded!, [NAMES.evil, handed, `${label}: ${handed}`, `Note: ${handed}`], `outcome ${at}`, { lists: true });
      const next = (await pool().query("SELECT id FROM hd_tickets WHERE parent_ticket_id = $1 ORDER BY id", [t.id])).rows[1];
      assert.ok(next, "the second task's ticket");
      const later = (await internal(next.id)).join("\n\n");
      assert.ok(later.includes("Hand-offs so far"), later);
      assertInert(later, [`${label}: ${handed}`, `Note: ${handed}`], `hand-offs ${at}`, { lists: true, strong: ["Hand-offs so far", `${STAMP} A: ${title}`, ...labels] });
    }
  });
});
