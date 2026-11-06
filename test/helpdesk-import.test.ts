// Helpdesk 1.19.1 (agent V7): ticket import from a Zoho Desk export or a
// generic CSV (lib/helpdesk/import*). Pure parts (CSV, zip, dates, body
// sanitising, file recognition), then the whole flow against Postgres
// through the routes the wizard calls: upload → map → dry run → import,
// dry-run counts equal to the real import's, an idempotent re-run, no
// hooks fired (with a positive control proving they would have), HTML made
// safe, timestamps kept, and cancel / resume.
//
// Parallel-safe: the fixtures in test/fixtures/helpdesk-import/ are
// rewritten with this run's stamp before use (Zoho ids, the email domain,
// department and team names, CSV ids), so every ticket, person and team
// here is this file's own. Global state touched: the starter SLA rows are
// inserted if missing (insert-only); the upload limit setting is read,
// never changed.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-import.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { pool, getSetting, createSession } from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next (as in helpdesk-core.test.ts) ------------------

let currentRequest: Request | null = null;
function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-import.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-import.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
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
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) return EE_STUB;
    if (request === "../ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "..", "ee") === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

type AnyHandler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any; text: string }> {
  currentRequest = req;
  try {
    const res = await (handler as AnyHandler)(req, { params: Promise.resolve(params) });
    const text = await res.clone().text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, body, text };
  } finally {
    currentRequest = null;
  }
}
function jsonReq(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function fileReq(url: string, session: string, bytes: Buffer, filename: string): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { cookie: `compass_session=${session}`, "content-type": "application/octet-stream", "x-filename": encodeURIComponent(filename) },
    body: new Uint8Array(bytes),
  });
}

// --- Fixtures ----------------------------------------------------------------------------

const STAMP = `hdimp-${Date.now()}-${randomBytes(3).toString("hex")}`;
const DIGITS = String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999)).slice(0, 10);
const DOMAIN = `${STAMP}.test`;
const FIX = path.join(__dirname, "fixtures", "helpdesk-import");
const IT_TEAM = `IT Support ${STAMP}`;
const OFFICE_TEAM = `Office Services ${STAMP}`;
const DESKTOP_TEAM = `Desktop Support ${STAMP}`;

/** The fixture text with this run's ids, domain and names. */
function stampText(s: string): string {
  return s
    .replaceAll("4181000000", DIGITS)
    .replaceAll("acme-example.com", DOMAIN)
    .replaceAll("outside-example.org", `out-${DOMAIN}`)
    .replaceAll("IT Support", IT_TEAM)
    .replaceAll("Office Services", OFFICE_TEAM)
    .replaceAll("Desktop Support", DESKTOP_TEAM)
    .replaceAll("GEN-", `${STAMP}-`);
}

async function stampedZip(): Promise<Buffer> {
  const src = await JSZip.loadAsync(await readFile(path.join(FIX, "zoho-desk-export.zip")));
  const out = new JSZip();
  for (const [name, entry] of Object.entries(src.files)) {
    if (entry.dir) continue;
    const newName = stampText(name);
    if (name.endsWith(".csv")) out.file(newName, stampText(await entry.async("string")));
    else out.file(newName, await entry.async("nodebuffer"));
  }
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const P: Record<string, { id: number; session: string }> = {};
const PEOPLE = ["admin", "alex", "priya", "agentOnly"] as const;
const id = (k: (typeof PEOPLE)[number]) => P[k].id;
const s = (k: (typeof PEOPLE)[number]) => P[k].session;
let itTeam = 0;
let desktopTeam = 0;
let roleAdmin = 0;
let uploadDirectory = "";
const createdTeams: number[] = [];
const jobIds: number[] = [];

before(async () => {
  await getSetting("__schema_bootstrap__");
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "compass-hdimport-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDirectory;
  const creds = hashPassword("Helpdesk!Import123");
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  const emails: Record<string, string> = {
    admin: `${STAMP}-admin@example.test`,
    alex: `alex.agent@${DOMAIN}`,
    priya: `priya.shah@${DOMAIN}`,
    agentOnly: `${STAMP}-agent@example.test`,
  };
  const names: Record<string, string> = { admin: "Imp Admin", alex: "Alex Agent", priya: "Priya Shah", agentOnly: "Imp Agent" };
  for (const k of PEOPLE) {
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status, password_hash, password_salt)
       VALUES ($1, $2, $3, 'viewer', 'active', $4, $5) RETURNING id`,
      [`${STAMP}-${k}`, names[k], emails[k], creds.hash, creds.salt]
    );
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    P[k] = { id: r.rows[0].id, session };
  }
  const agentRole = (await pool().query("SELECT id FROM roles WHERE key = 'helpdesk-agent'")).rows[0].id;
  const adm = await fixtureQuery("INSERT INTO roles (key, name, description) VALUES ($1, $2, '') RETURNING id", [`${STAMP}-admin`, `${STAMP} configure`]);
  roleAdmin = adm.rows[0].id;
  await pool().query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.admin')", [roleAdmin]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [roleAdmin, id("admin")]);
  for (const k of ["alex", "agentOnly"] as const) await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [agentRole, id(k)]);
  itTeam = (await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [IT_TEAM])).rows[0].id;
  desktopTeam = (await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [DESKTOP_TEAM])).rows[0].id;
  createdTeams.push(itTeam, desktopTeam);
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent')", [itTeam, id("alex"), id("agentOnly")]);
  // Round-robin auto-assignment on the IT team: a normally created ticket gets an owner (the positive control).
  await pool().query(
    `INSERT INTO hd_team_assignment (team_id, mode, eligible, respect_shift) VALUES ($1, 'round_robin', 'any', 0)
     ON CONFLICT (team_id) DO UPDATE SET mode = 'round_robin', eligible = 'any', respect_shift = 0`,
    [itTeam]
  );
  const { ensureStarterPolicies } = await import("../src/lib/helpdesk/db-sla");
  await ensureStarterPolicies();
});

after(async () => {
  const userIds = PEOPLE.map((k) => P[k]?.id).filter(Boolean);
  const imported = await pool().query("SELECT id FROM hd_tickets WHERE import_ref LIKE $1 OR team_id = ANY($2) OR requester_id = ANY($3)", [
    `%${DIGITS}%`,
    createdTeams,
    userIds,
  ]);
  const ticketIds = imported.rows.map((r) => r.id);
  const more = await pool().query("SELECT id FROM hd_tickets WHERE import_ref LIKE $1", [`${STAMP}%`]);
  ticketIds.push(...more.rows.map((r) => r.id));
  await pool().query("DELETE FROM hd_attachments WHERE ticket_id = ANY($1)", [ticketIds]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ticketIds]);
  const teamsByName = await pool().query("SELECT id FROM hd_teams WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[...createdTeams, ...teamsByName.rows.map((r) => r.id)]]);
  await pool().query("DELETE FROM hd_import_jobs WHERE id = ANY($1) OR created_by = ANY($2)", [jobIds, userIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = $1", [roleAdmin]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_prefs WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  if (uploadDirectory) await rm(uploadDirectory, { recursive: true, force: true });
  await pool().end();
});

const routes = {
  root: () => import("../src/app/api/helpdesk/admin/import/route"),
  job: () => import("../src/app/api/helpdesk/admin/import/[id]/route"),
  messages: () => import("../src/app/api/helpdesk/admin/import/[id]/messages/route"),
  dryRun: () => import("../src/app/api/helpdesk/admin/import/[id]/dry-run/route"),
  start: () => import("../src/app/api/helpdesk/admin/import/[id]/start/route"),
  cancel: () => import("../src/app/api/helpdesk/admin/import/[id]/cancel/route"),
  skipped: () => import("../src/app/api/helpdesk/admin/import/[id]/skipped/route"),
};
const lib = () => import("../src/lib/helpdesk/import");

async function upload(source: "zoho" | "csv", bytes: Buffer, filename: string) {
  const r = await call((await routes.root()).POST, fileReq(`/api/helpdesk/admin/import?source=${source}`, s("admin"), bytes, filename));
  assert.equal(r.status, 201, r.text);
  jobIds.push(r.body.job.id);
  return r.body.job;
}

async function ticketsOfRun(prefix: string) {
  return (await pool().query("SELECT * FROM hd_tickets WHERE import_ref LIKE $1 ORDER BY import_ref", [`${prefix}%`])).rows;
}

/** A timestamp column as ISO (this pool returns them as strings). */
const iso = (v: unknown) => new Date(v as string).toISOString();
const ms = (v: unknown) => new Date(v as string).getTime();

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

// --- Pure parts ---------------------------------------------------------------------------------

describe("CSV, zip, dates, bodies", () => {
  test("CSV: quotes, line breaks inside fields, BOM, CRLF, semicolons and chunk splits", async () => {
    const { csvRows, csvRecords } = await import("../src/lib/helpdesk/import-csv");
    const text = '﻿Id,Body,Note\r\n1,"Hello, ""world""\r\nsecond line",x\r\n2,plain,"ends with quote"""\r\n\r\n3,,\r\n';
    // Every split point: the parser must not care where chunks break.
    for (let cut = 1; cut < text.length; cut += 3) {
      const chunks = [Buffer.from(text.slice(0, cut)), Buffer.from(text.slice(cut))];
      const rows = [];
      for await (const r of csvRows(Readable.from(chunks))) rows.push(r);
      assert.equal(rows.length, 3, `cut at ${cut}`);
      assert.equal(rows[0].values.Body, 'Hello, "world"\r\nsecond line');
      assert.equal(rows[1].values.Note, 'ends with quote"');
      assert.equal(rows[2].values.Id, "3");
    }
    const semi = [];
    for await (const r of csvRecords(Readable.from([Buffer.from("a;b;c\n1;2;3\n")]))) semi.push(r.fields);
    assert.deepEqual(semi, [["a", "b", "c"], ["1", "2", "3"]]);
    // A multi-byte character split across chunks stays whole.
    const euro = Buffer.from("A\n€uro\n");
    const recs = [];
    for await (const r of csvRecords(Readable.from([euro.subarray(0, 3), euro.subarray(3)]))) recs.push(r.fields[0]);
    assert.deepEqual(recs, ["A", "€uro"]);
  });

  test("CSV: an unclosed quote fails instead of swallowing the file", async () => {
    const { csvRecords, CsvError } = await import("../src/lib/helpdesk/import-csv");
    await assert.rejects(async () => {
      for await (const _ of csvRecords(Readable.from([Buffer.from('a,b\n1,"never closed\n2,3\n')]))) {
        /* drain */
      }
    }, CsvError);
  });

  test("zip: the central directory is read and an entry over its cap stops", async () => {
    const { readZipDirectory, openZipEntry, readZipEntry, ZipError } = await import("../src/lib/helpdesk/import-zip");
    const file = path.join(FIX, "zoho-desk-export.zip");
    const entries = await readZipDirectory(file);
    assert.ok(entries.some((e) => e.name.endsWith("Tickets_001.csv")));
    const png = entries.find((e) => e.name.endsWith("screenshot.png"))!;
    assert.deepEqual(await readZipEntry(file, png, 1024), PNG);
    const tickets = entries.find((e) => e.name.endsWith("Tickets_001.csv"))!;
    await assert.rejects(async () => {
      for await (const _ of await openZipEntry(file, tickets, 100)) {
        /* drain */
      }
    }, ZipError);
  });

  test("files are recognised by name, columns by header", async () => {
    const { classifyCsvName, guessTicketColumns, guessMessageColumns } = await import("../src/lib/helpdesk/import-shared");
    assert.equal(classifyCsvName("export/Tickets_001.csv"), "tickets");
    assert.equal(classifyCsvName("Cases.csv"), "tickets");
    assert.equal(classifyCsvName("x/Threads_002.csv"), "threads");
    assert.equal(classifyCsvName("Conversations.csv"), "threads");
    assert.equal(classifyCsvName("Comments.csv"), "comments");
    assert.equal(classifyCsvName("Contacts_001.csv"), "contacts");
    assert.equal(classifyCsvName("Agents.csv"), "agents");
    assert.equal(classifyCsvName("Departments.csv"), "departments");
    assert.equal(classifyCsvName("Attachments/a/b.png"), null);
    const cols = guessTicketColumns(["Ticket Id", "Ticket Reference Id", "Subject", "Description", "Status", "Ticket Owner", "Email", "Created Time", "Closed Time"]);
    assert.equal(cols.ref, "Ticket Id");
    assert.equal(cols.number, "Ticket Reference Id");
    assert.equal(cols.contact_email, "Email");
    assert.equal(cols.agent_name, "Ticket Owner");
    assert.equal(cols.closed_at, "Closed Time");
    const m = guessMessageColumns(["Thread Id", "Ticket Id", "Content", "From Email Address", "Direction", "Created Time"]);
    assert.equal(m.ref, "Thread Id");
    assert.equal(m.ticket_ref, "Ticket Id");
    assert.equal(m.author_email, "From Email Address");
  });

  test("dates: ISO, offsets, slashes in either order, month names, a zone for bare times", async () => {
    const { parseSourceDate, detectDateOrder } = await import("../src/lib/helpdesk/import-shared");
    assert.equal(parseSourceDate("2026-10-01 09:15:00"), Date.UTC(2026, 9, 1, 9, 15));
    assert.equal(parseSourceDate("2026-10-01T09:15:00+02:00"), Date.UTC(2026, 9, 1, 7, 15));
    assert.equal(parseSourceDate("2026-10-01 09:15:00", { zone: "Europe/London" }), Date.UTC(2026, 9, 1, 8, 15));
    assert.equal(parseSourceDate("04/11/2026 09:00", { order: "dmy" }), Date.UTC(2026, 10, 4, 9, 0));
    assert.equal(parseSourceDate("04/11/2026 09:00 PM", { order: "mdy" }), Date.UTC(2026, 3, 11, 21, 0));
    assert.equal(parseSourceDate("05 Nov 2026 03:15 PM"), Date.UTC(2026, 10, 5, 15, 15));
    assert.equal(parseSourceDate("Nov 05, 2026 03:15 PM"), Date.UTC(2026, 10, 5, 15, 15));
    assert.equal(parseSourceDate("not a date"), null);
    assert.equal(parseSourceDate("2026-13-01"), null);
    assert.equal(detectDateOrder(["25/10/2026", "01/11/2026"]), "dmy");
    assert.equal(detectDateOrder(["10/25/2026"]), "mdy");
  });

  test("HTML bodies become safe markdown: no scripts, images as links, no javascript: links", async () => {
    const { importBodyToMarkdown } = await import("../src/lib/helpdesk/import-body");
    const md = importBodyToMarkdown(
      '<p>Hi <b>team</b><script>alert("x")</script></p><img src="https://cdn.example.net/shot.png" alt="error dialog"><img src="data:image/png;base64,AAAA"><a href="javascript:alert(1)">click me</a> <a href="https://status.example.net/vpn">status</a><iframe src="https://evil.example.net"></iframe><style>p{}</style><form><input value="x"></form>'
    );
    // The only angle brackets left are the autolinks the desk itself writes.
    assert.doesNotMatch(md.replace(/<https:\/\/[^<>\s]+>/g, ""), /[<>]|alert|javascript|iframe|evil|data:/i);
    assert.match(md, /Image\\: error dialog \\\(<https:\/\/cdn\.example\.net\/shot\.png>\\\)/);
    assert.match(md, /status \\\(<https:\/\/status\.example\.net\/vpn>\\\)/);
    assert.match(md, /\\\[image\\\]/);
    // Plain text is escaped, not interpreted.
    assert.equal(importBodyToMarkdown("**not bold** if a < b"), "\\*\\*not bold\\*\\* if a \\< b");
  });

  test("statuses and priorities map to sensible defaults", async () => {
    const { defaultStatusFor, defaultPriorityFor } = await import("../src/lib/helpdesk/import-shared");
    assert.deepEqual(defaultStatusFor("On Hold"), { status: "on_hold", tag: "" });
    assert.deepEqual(defaultStatusFor("Escalated"), { status: "open", tag: "escalated" });
    assert.deepEqual(defaultStatusFor("Closed"), { status: "closed", tag: "" });
    assert.deepEqual(defaultStatusFor("Waiting on customer"), { status: "pending", tag: "" });
    assert.deepEqual(defaultStatusFor("Needs Vendor"), { status: "open", tag: "needs-vendor" });
    assert.equal(defaultPriorityFor("Medium"), "normal");
    assert.equal(defaultPriorityFor("-None-"), "normal");
    assert.equal(defaultPriorityFor("Critical"), "urgent");
  });
});

// --- Zoho Desk, end to end ----------------------------------------------------------------------

describe("Zoho Desk export", () => {
  let zip: Buffer;
  let job: any;
  let dryRun: any;

  before(async () => {
    zip = await stampedZip();
  });

  test("only settings.manage reaches the import; an oversized upload is refused", async () => {
    const r = await call((await routes.root()).GET, jsonReq("/api/helpdesk/admin/import", s("agentOnly")));
    assert.equal(r.status, 403);
    const { saveImportUpload, ImportError } = await lib();
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(600));
        c.enqueue(new Uint8Array(600));
        c.close();
      },
    });
    await assert.rejects(saveImportUpload(big, 1000, "zip"), (e: unknown) => e instanceof ImportError && e.status === 413);
    const csvAsZoho = await call((await routes.root()).POST, fileReq("/api/helpdesk/admin/import?source=zoho", s("admin"), Buffer.from("a,b\n1,2\n"), "x.csv"));
    assert.equal(csvAsZoho.status, 400);
    assert.match(csvAsZoho.body.error, /zip/);
  });

  test("upload scans the export and guesses the mapping", async () => {
    job = await upload("zoho", zip, "zoho-desk-export-2026-11.zip");
    assert.equal(job.status, "uploaded");
    assert.equal(job.scan.tickets, 8);
    assert.equal(job.scan.messages, 6);
    assert.equal(job.scan.comments, 1);
    assert.equal(job.scan.contacts, 2);
    assert.equal(job.scan.attachments_in_zip, 2);
    assert.deepEqual(job.scan.warnings, []);
    const m = job.mapping;
    assert.deepEqual(m.departments[IT_TEAM], { action: "team", team_id: itTeam }, "an existing team of that name is used");
    assert.deepEqual(m.departments[OFFICE_TEAM], { action: "create", name: OFFICE_TEAM });
    assert.deepEqual(m.statuses["Escalated"], { status: "open", tag: "escalated" });
    assert.deepEqual(m.statuses["On Hold"], { status: "on_hold", tag: "" });
    assert.equal(m.priorities["Medium"], "normal");
    assert.equal(m.agents[`alex.agent@${DOMAIN}`], id("alex"), "agents match accounts by email");
    assert.equal(m.agents[`morgan.gone@${DOMAIN}`], null, "an agent with no account stays a former agent");
    assert.equal(job.scan.contacts_matched, 1);
    // The scan counts every row's requester (skipped rows too); the dry run counts only imported tickets'.
    assert.equal(job.scan.contacts_kept, 4);
    // The times in the fixture are UTC.
    const saved = await call((await routes.job()).PUT, jsonReq(`/api/helpdesk/admin/import/${job.id}`, s("admin"), { timezone: "UTC" }, "PUT"), { id: String(job.id) });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.job.mapping.timezone, "UTC");
    const bad = await call((await routes.job()).PUT, jsonReq(`/api/helpdesk/admin/import/${job.id}`, s("admin"), { statuses: { Open: { status: "nope" } } }, "PUT"), { id: String(job.id) });
    assert.equal(bad.status, 400);
  });

  test("the dry run counts everything and writes no ticket", async () => {
    const r = await call((await routes.dryRun()).POST, jsonReq(`/api/helpdesk/admin/import/${job.id}/dry-run`, s("admin"), {}), { id: String(job.id) });
    assert.equal(r.status, 200, r.text);
    dryRun = r.body.job.dry_run;
    assert.equal(r.body.job.status, "ready");
    assert.equal(dryRun.tickets_create, 5);
    assert.equal(dryRun.tickets_update, 0);
    assert.equal(dryRun.contacts_matched, 1);
    assert.equal(dryRun.contacts_kept, 2);
    assert.equal(dryRun.messages, 4);
    assert.equal(dryRun.notes, 1);
    assert.equal(dryRun.attachments_import, 1);
    assert.equal(dryRun.attachments_refused, 1);
    assert.equal(dryRun.attachments_missing, 1);
    assert.equal(dryRun.teams_create, 1);
    assert.equal(dryRun.skipped, 5);
    assert.equal((await ticketsOfRun(DIGITS)).length, 0);
    assert.equal((await pool().query("SELECT 1 FROM hd_teams WHERE name = $1", [OFFICE_TEAM])).rowCount, 0, "no team is created by a dry run");
    const csv = await call((await routes.skipped()).GET, jsonReq(`/api/helpdesk/admin/import/${job.id}/skipped`, s("admin")), { id: String(job.id) });
    assert.equal(csv.status, 200);
    assert.match(csv.text, /No ticket id or number/);
    assert.match(csv.text, /The same ticket id is on line 2/);
    assert.match(csv.text, /can't be read/);
    assert.match(csv.text, /isn't in the import/);
    assert.match(csv.text, /Empty message/);
  });

  test("the import creates what the dry run counted, keeps times and fires no hooks", async () => {
    // Positive control: a ticket created the normal way in the same team IS auto-assigned.
    const { createTicket } = await import("../src/lib/helpdesk/tickets");
    const control = await createTicket({ subject: `${STAMP} control`, body: "x", requester: { id: id("priya"), name: "Priya Shah", email: `priya.shah@${DOMAIN}` }, team_id: itTeam });
    assert.ok(control.assignee_id, "the IT team auto-assigns normally created tickets");
    await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [PEOPLE.map((k) => id(k))]);

    const { startImport, runImportJob } = await lib();
    const before = Date.now();
    await startImport(job.id);
    const done = await runImportJob(job.id);
    assert.equal(done?.status, "completed", done?.error);
    const result = done!.counts.result!;
    for (const k of ["tickets_create", "tickets_update", "contacts_matched", "contacts_kept", "messages", "notes", "attachments_import", "attachments_refused", "attachments_missing", "skipped"] as const) {
      assert.equal(result[k], dryRun[k], `${k}: dry run ${dryRun[k]}, import ${result[k]}`);
    }
    const rows = await ticketsOfRun(DIGITS);
    assert.equal(rows.length, 5);
    const byRef = new Map(rows.map((t) => [t.import_ref, t]));
    const t1 = byRef.get(`${DIGITS}100001`);
    const t2 = byRef.get(`${DIGITS}100002`);
    const t3 = byRef.get(`${DIGITS}100003`);
    const t4 = byRef.get(`${DIGITS}100004`);
    const t5 = byRef.get(`${DIGITS}100005`);

    // Numbers continue from the sequence; the source number is kept as a label.
    assert.ok(t1.number > control.number, "new numbers come after existing ones");
    assert.equal(t1.source_ref.import_label, "Zoho #1201");
    assert.equal(t1.import_source, "zoho");
    // Timestamps and mapping.
    assert.equal(iso(t1.created_at), "2026-10-01T09:15:00.000Z");
    assert.equal(iso(t1.first_replied_at), "2026-10-01T10:00:00.000Z", "first reply is the agent's first public message");
    assert.equal(t1.team_id, itTeam);
    assert.equal(t1.assignee_id, id("alex"), "an owner who works the team keeps the ticket");
    assert.equal(t1.requester_id, id("priya"));
    assert.equal(t1.priority, "high");
    assert.equal(t1.source, "email");
    assert.deepEqual(t1.tags, ["vpn", "remote-work"]);
    assert.equal(t4.status, "closed");
    assert.equal(iso(t4.solved_at), "2026-09-21T17:30:00.000Z");
    assert.equal(iso(t4.closed_at), "2026-09-21T17:30:00.000Z");
    assert.equal(t4.first_reply_due, null, "a closed ticket gets no SLA clock");
    assert.equal(t4.resolve_due, null);
    assert.equal(t2.status, "on_hold");
    assert.ok(t2.sla_paused_at, "on hold starts paused");
    assert.equal(t2.requester_id, null, "an outside sender stays a name and an email");
    assert.equal(t2.requester_email, `sam@out-${DOMAIN}`);
    assert.equal(t2.assignee_id, null, "a former agent's ticket comes in unassigned");
    const office = (await pool().query("SELECT id FROM hd_teams WHERE name = $1", [OFFICE_TEAM])).rows[0];
    assert.ok(office, "the create-team mapping made the team");
    createdTeams.push(office.id);
    assert.equal(t3.team_id, office.id);
    assert.ok(t3.tags.includes("escalated"));
    assert.equal(t3.status, "open");
    assert.equal(t3.assignee_id, null, "an owner who isn't in the new team isn't assigned");
    // Open tickets: dues from the import time, never from their old created time.
    assert.ok(t1.resolve_due && ms(t1.resolve_due) >= before, "open tickets' clocks start at import");
    assert.equal(t5.priority, "normal");
    assert.equal(t5.requester_name, `noname@out-${DOMAIN}`);

    // No hooks: nothing assigned t5 (unassigned in an auto-assigning team), no notices, no runs, no timeline lines.
    assert.equal(t5.assignee_id, null, "auto-assignment did not run for an imported ticket");
    const ids = rows.map((t) => t.id);
    assert.equal((await pool().query("SELECT 1 FROM hd_messages WHERE ticket_id = ANY($1) AND kind = 'system'", [ids])).rowCount, 0);
    assert.equal((await pool().query("SELECT 1 FROM hd_messages WHERE ticket_id = ANY($1) AND via = 'system'", [ids])).rowCount, 0);
    assert.equal((await pool().query("SELECT 1 FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [ids])).rowCount, 0);
    assert.equal((await pool().query("SELECT 1 FROM notifications WHERE user_id = ANY($1)", [PEOPLE.map((k) => id(k))])).rowCount, 0, "nobody was notified");
    const assignmentLog = await pool().query("SELECT to_regclass('hd_assignment_log') AS t");
    if (assignmentLog.rows[0].t) assert.equal((await pool().query("SELECT 1 FROM hd_assignment_log WHERE ticket_id = ANY($1)", [ids])).rowCount, 0);

    // Messages: authors, times, kinds; the description Zoho repeats as the first thread is dropped.
    const msgs = (await pool().query("SELECT * FROM hd_messages WHERE ticket_id = $1 ORDER BY created_at, id", [t1.id])).rows;
    assert.deepEqual(msgs.map((m) => m.import_ref), [`t:${DIGITS}200001`, `c:${DIGITS}300001`, `t:${DIGITS}200002`]);
    assert.equal(msgs[0].author_id, id("priya"));
    assert.equal(iso(msgs[0].created_at), "2026-10-01T09:15:30.000Z");
    assert.equal(msgs[1].kind, "internal", "a Zoho comment is an internal note");
    assert.equal(msgs[1].author_id, id("alex"));
    assert.equal(msgs[2].author_id, id("alex"));
    assert.equal(msgs[2].kind, "public");
    for (const m of msgs) assert.doesNotMatch(m.body, /<[a-z]/i, "no HTML is stored");
    assert.match(msgs[2].body, /Attachment not imported\\: run\.exe, that kind of file can't be attached/);
    assert.match(msgs[2].body, /Attachment not imported\\: missing\.pdf, not in the export/);
    assert.equal(msgs[2].attachments.length, 1);
    assert.equal(msgs[2].attachments[0].name, "screenshot.png");
    const att = (await pool().query("SELECT * FROM hd_attachments WHERE message_id = $1", [msgs[2].id])).rows;
    assert.equal(att.length, 1);
    assert.equal(att[0].mime_type, "image/png");
    assert.equal(att[0].ticket_id, t1.id);
    await stat(path.join(uploadDirectory, att[0].stored_name));
    const m2 = (await pool().query("SELECT * FROM hd_messages WHERE ticket_id = $1 ORDER BY created_at", [t2.id])).rows;
    assert.equal(m2[0].import_ref, "description", "a description that isn't repeated stays as the opening message");
    assert.equal(m2[1].author_name, "Former agent Morgan Gone");
    assert.equal(m2[1].author_id, null);

    // Audit and file clean-up.
    const audit = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.import.completed' AND target_id = $1", [String(job.id)]);
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].details.counts.tickets_create, 5);
    const jr = (await pool().query("SELECT files FROM hd_import_jobs WHERE id = $1", [job.id])).rows[0];
    assert.equal(jr.files.main, undefined, "the upload is deleted once the job finishes");
  });

  test("a re-run updates instead of duplicating", async () => {
    const again = await upload("zoho", zip, "zoho-desk-export-2026-11.zip");
    await call((await routes.job()).PUT, jsonReq(`/api/helpdesk/admin/import/${again.id}`, s("admin"), { timezone: "UTC" }, "PUT"), { id: String(again.id) });
    const dr = await call((await routes.dryRun()).POST, jsonReq(`/api/helpdesk/admin/import/${again.id}/dry-run`, s("admin"), {}), { id: String(again.id) });
    assert.equal(dr.body.job.dry_run.tickets_create, 0);
    assert.equal(dr.body.job.dry_run.tickets_update, 5);
    assert.equal(dr.body.job.dry_run.teams_create, 0, "the team made last time is reused");
    const before = await ticketsOfRun(DIGITS);
    const msgBefore = (await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = ANY($1)", [before.map((t) => t.id)])).rows[0].n;
    const { startImport, runImportJob } = await lib();
    await startImport(again.id);
    const done = await runImportJob(again.id);
    assert.equal(done?.status, "completed", done?.error);
    assert.equal(done!.counts.result!.tickets_update, 5);
    const after = await ticketsOfRun(DIGITS);
    assert.equal(after.length, 5);
    assert.deepEqual(after.map((t) => t.number), before.map((t) => t.number), "numbers are kept");
    const msgAfter = (await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = ANY($1)", [after.map((t) => t.id)])).rows[0].n;
    assert.equal(msgAfter, msgBefore, "no message is doubled");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_attachments WHERE ticket_id = ANY($1)", [after.map((t) => t.id)])).rows[0].n, 1, "no file is doubled");
    // An open ticket's clock is not restarted by a re-run.
    const t1a = before.find((t) => t.import_ref === `${DIGITS}100001`);
    const t1b = after.find((t) => t.import_ref === `${DIGITS}100001`);
    assert.equal(ms(t1b.resolve_due), ms(t1a.resolve_due));
  });
});

// --- Generic CSV, cancel and resume ---------------------------------------------------------------

describe("Generic CSV", () => {
  test("upload with a messages file, fix a column in the map step, import", async () => {
    const tickets = Buffer.from(stampText(await readFile(path.join(FIX, "tickets.csv"), "utf8")));
    const messages = Buffer.from(stampText(await readFile(path.join(FIX, "messages.csv"), "utf8")));
    let job = await upload("csv", tickets, "tickets.csv");
    assert.ok(job.scan.warnings.some((w: string) => /created date/.test(w)), "an unrecognised date column is flagged");
    const withMessages = await call((await routes.messages()).POST, fileReq(`/api/helpdesk/admin/import/${job.id}/messages`, s("admin"), messages, "messages.csv"), { id: String(job.id) });
    assert.equal(withMessages.status, 200, withMessages.text);
    job = withMessages.body.job;
    assert.equal(job.scan.messages, 3);
    assert.equal(job.mapping.columns.messages.ticket_ref, "Ticket");
    assert.equal(job.mapping.columns.messages.visibility, "Kind");
    const mapped = await call(
      (await routes.job()).PUT,
      jsonReq(
        `/api/helpdesk/admin/import/${job.id}`,
        s("admin"),
        {
          columns: { ...job.mapping.columns, tickets: { ...job.mapping.columns.tickets, created_at: "Raised On" } },
          date_order: "dmy",
          timezone: "UTC",
          departments: { [DESKTOP_TEAM]: { action: "team", team_id: desktopTeam } },
        },
        "PUT"
      ),
      { id: String(job.id) }
    );
    assert.equal(mapped.status, 200, mapped.text);
    assert.deepEqual(mapped.body.job.scan.warnings, []);
    const dr = await call((await routes.dryRun()).POST, jsonReq(`/api/helpdesk/admin/import/${job.id}/dry-run`, s("admin"), {}), { id: String(job.id) });
    const d = dr.body.job.dry_run;
    assert.equal(d.tickets_create, 2);
    assert.equal(d.skipped, 1);
    assert.equal(d.messages, 2);
    assert.equal(d.notes, 1);
    const { startImport, runImportJob } = await lib();
    await startImport(job.id);
    const done = await runImportJob(job.id);
    assert.equal(done?.status, "completed", done?.error);
    assert.equal(done!.counts.result!.tickets_create, d.tickets_create);
    assert.equal(done!.counts.result!.messages, d.messages);
    const rows = await ticketsOfRun(`${STAMP}-`);
    assert.equal(rows.length, 2);
    const g1 = rows.find((t) => t.import_ref === `${STAMP}-1`);
    const g2 = rows.find((t) => t.import_ref === `${STAMP}-2`);
    assert.equal(g1.import_source, "csv:tickets", "a CSV source is keyed by its name (the file's, by default)");
    assert.equal(g1.source_ref.import_label, `Imported #${STAMP}-1`);
    assert.equal(g1.status, "pending");
    assert.equal(g1.priority, "urgent");
    assert.equal(g1.team_id, desktopTeam);
    assert.equal(iso(g1.created_at), "2026-11-04T09:00:00.000Z", "day-first dates read as asked");
    assert.equal(g2.status, "solved");
    assert.equal(iso(g2.solved_at), "2026-11-06T10:00:00.000Z");
    const desc = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND import_ref = 'description'", [g1.id])).rows[0];
    assert.match(desc.body, /Black screen/);
    assert.doesNotMatch(desc.body, /script|steal|</, "HTML in a CSV body is made safe");
    const msgs = (await pool().query("SELECT * FROM hd_messages WHERE ticket_id = $1 AND import_ref <> 'description' ORDER BY created_at", [g1.id])).rows;
    assert.deepEqual(msgs.map((m) => [m.kind, m.author_id]), [["public", id("alex")], ["internal", id("alex")]]);
    assert.equal(iso(g1.first_replied_at), "2026-11-04T09:30:00.000Z");
  });

  test("cancel stops between batches; resume carries on without duplicates", async () => {
    const n = 7;
    let csv = "Ticket Id,Subject,Description,Status,Created Time\r\n";
    for (let i = 1; i <= n; i++) csv += `${STAMP}-c${i},Cancel test ${i},Body ${i},Open,2026-10-0${i} 10:00:00\r\n`;
    const job = await upload("csv", Buffer.from(csv), "cancel.csv");
    await call((await routes.job()).PUT, jsonReq(`/api/helpdesk/admin/import/${job.id}`, s("admin"), { timezone: "UTC" }, "PUT"), { id: String(job.id) });
    const dr = await call((await routes.dryRun()).POST, jsonReq(`/api/helpdesk/admin/import/${job.id}/dry-run`, s("admin"), {}), { id: String(job.id) });
    assert.equal(dr.body.job.dry_run.tickets_create, n);
    const imp = await lib();
    const batch = imp.IMPORT_BATCH as { tickets: number };
    const saved = batch.tickets;
    batch.tickets = 2;
    try {
      await imp.startImport(job.id);
      let batches = 0;
      const stopped = await imp.runImportJob(job.id, {
        onBatch: async () => {
          batches++;
          if (batches === 1) {
            const r = await call((await routes.cancel()).POST, jsonReq(`/api/helpdesk/admin/import/${job.id}/cancel`, s("admin"), {}), { id: String(job.id) });
            assert.equal(r.status, 200, r.text);
            assert.equal(r.body.job.status, "cancelling");
          }
        },
      });
      assert.equal(stopped?.status, "cancelled");
      assert.equal(stopped?.progress.done, 2);
      assert.equal((await ticketsOfRun(`${STAMP}-c`)).length, 2, "the committed batch stays");
      const cancelAudit = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.import.cancelled' AND target_id = $1", [String(job.id)]);
      assert.equal(cancelAudit.rowCount, 1);
      assert.equal(cancelAudit.rows[0].details.counts.tickets_create, 2);
      // Resume through the route: it runs in the background; wait for it.
      const r = await call((await routes.start()).POST, jsonReq(`/api/helpdesk/admin/import/${job.id}/start`, s("admin"), {}), { id: String(job.id) });
      assert.equal(r.status, 202, r.text);
      let final: any;
      for (let i = 0; i < 100; i++) {
        final = await imp.getImportJob(job.id);
        if (final && !["queued", "running"].includes(final.status)) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      assert.equal(final.status, "completed", final.error);
      assert.equal(final.counts.result.tickets_create, n, "counts carry over the resume");
      const rows = await ticketsOfRun(`${STAMP}-c`);
      assert.equal(rows.length, n, "no ticket is created twice");
      const started = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.import.started' AND target_id = $1", [String(job.id)]);
      assert.equal(started.rowCount, 1);
      assert.equal(started.rows[0].details.resumed, true);
    } finally {
      batch.tickets = saved;
    }
  });

  test("the sweep removes upload files of old unfinished jobs", async () => {
    const job = await upload("csv", Buffer.from("Ticket Id,Subject,Created Time\r\nx1,One,2026-10-01\r\n"), "old.csv");
    const row = (await pool().query("SELECT files FROM hd_import_jobs WHERE id = $1", [job.id])).rows[0];
    const file = path.join(uploadDirectory, "hd-import", row.files.main);
    await stat(file);
    await pool().query("UPDATE hd_import_jobs SET created_at = now() - interval '8 days' WHERE id = $1", [job.id]);
    const { importSweep } = await lib();
    await importSweep();
    await assert.rejects(stat(file));
    const after = (await pool().query("SELECT files FROM hd_import_jobs WHERE id = $1", [job.id])).rows[0];
    assert.equal(after.files.main, undefined);
  });

  test("the import never calls the after-write hooks or the write paths that fire them", async () => {
    const src = await readFile(path.join(__dirname, "..", "src", "lib", "helpdesk", "import.ts"), "utf8");
    const specifiers = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g), ...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.ok(specifiers.includes("./tickets"), "the scan found the imports");
    for (const banned of ["./events", "./notify", "./messages", "./automations", "./engine", "./assignment/engine", "./push"]) {
      assert.ok(!specifiers.includes(banned), `import.ts must not import ${banned}`);
    }
    assert.doesNotMatch(src, /\b(afterTicketCreated|afterMessageAdded|afterTicketUpdated|afterTicketSolved|createTicket|addMessage|updateTicket|assignTicket|runAutomations)\(/);
  });
});

// --- 1.19.1 review fixes --------------------------------------------------------------------------

describe("review fixes", () => {
  /** Upload a CSV, name its source, dry-run it; answers the job and the dry run. */
  async function csvJob(csv: string, filename: string, sourceName?: string) {
    const job = await upload("csv", Buffer.from(csv), filename);
    const body: Record<string, unknown> = { timezone: "UTC" };
    if (sourceName !== undefined) body.source_name = sourceName;
    const saved = await call((await routes.job()).PUT, jsonReq(`/api/helpdesk/admin/import/${job.id}`, s("admin"), body, "PUT"), { id: String(job.id) });
    assert.equal(saved.status, 200, saved.text);
    const dr = await call((await routes.dryRun()).POST, jsonReq(`/api/helpdesk/admin/import/${job.id}/dry-run`, s("admin"), {}), { id: String(job.id) });
    assert.equal(dr.status, 200, dr.text);
    return { job: dr.body.job, dry: dr.body.job.dry_run };
  }
  async function runToEnd(jobId: number, opts: Parameters<Awaited<ReturnType<typeof lib>>["runImportJob"]>[1] = {}) {
    const imp = await lib();
    await imp.startImport(jobId);
    return imp.runImportJob(jobId, opts);
  }
  const header = "Ticket Id,Subject,Description,Status,Created Time\r\n";

  test("a message's file is only ever its own ticket's or its own message's, never another ticket's of the same name", async () => {
    const X = `${DIGITS}55`;
    const zip = new JSZip();
    zip.file(
      "export/Tickets.csv",
      `"Ticket Id","Subject","Description","Status","Created Time"\r\n"${X}","Scoped files","Body","Open","2026-10-01 09:00:00"\r\n`
    );
    zip.file(
      "export/Threads.csv",
      `"Thread Id","Ticket Id","Content","Author Name","From Email Address","Author Type","Visibility","Created Time","Attachments"\r\n` +
        `"${DIGITS}66","${X}","See attached","Pat","pat@out-${DOMAIN}","END_USER","public","2026-10-01 10:00:00","image001.png;report.png"\r\n`
    );
    zip.file(`export/Attachments/${X}3/image001.png`, PNG); // another ticket whose id starts with this one's
    zip.file(`export/Attachments/${DIGITS}77/image001.png`, PNG); // another ticket's
    zip.file(`export/Attachments/${X}/report.png`, PNG); // this ticket's own
    const job = await upload("zoho", await zip.generateAsync({ type: "nodebuffer" }), "scoped.zip");
    await call((await routes.job()).PUT, jsonReq(`/api/helpdesk/admin/import/${job.id}`, s("admin"), { timezone: "UTC" }, "PUT"), { id: String(job.id) });
    const dr = await call((await routes.dryRun()).POST, jsonReq(`/api/helpdesk/admin/import/${job.id}/dry-run`, s("admin"), {}), { id: String(job.id) });
    assert.equal(dr.body.job.dry_run.attachments_import, 1, dr.text);
    assert.equal(dr.body.job.dry_run.attachments_missing, 1, "image001.png is not this ticket's: missing, not borrowed");
    const done = await runToEnd(job.id);
    assert.equal(done?.status, "completed", done?.error);
    const t = (await ticketsOfRun(X)).find((r) => r.import_ref === X);
    const msg = (await pool().query("SELECT * FROM hd_messages WHERE ticket_id = $1 AND import_ref = $2", [t.id, `t:${DIGITS}66`])).rows[0];
    assert.deepEqual(msg.attachments.map((a: any) => a.name), ["report.png"]);
    assert.match(msg.body, /Attachment not imported\\: image001\.png, not in the export/);
  });

  test("two CSV sources with the same ids never overwrite each other; a re-run of one updates it", async () => {
    const csvA = `${header}${STAMP}-s1,From system A,A body,Open,2026-10-01 10:00:00\r\n`;
    const csvB = `${header}${STAMP}-s1,From system B,B body,Open,2026-10-02 10:00:00\r\n`;
    const a = await csvJob(csvA, "export.csv", `${STAMP} Alpha desk`);
    assert.equal(a.job.mapping.source_name, `${STAMP} Alpha desk`);
    assert.equal(a.dry.tickets_create, 1);
    assert.equal((await runToEnd(a.job.id))?.status, "completed");
    const b = await csvJob(csvB, "export.csv", `${STAMP} Beta desk`);
    assert.equal(b.dry.tickets_create, 1, "another source's #s1 is a new ticket");
    assert.equal(b.dry.tickets_update, 0);
    assert.equal((await runToEnd(b.job.id))?.status, "completed");
    const rows = (await pool().query("SELECT * FROM hd_tickets WHERE import_ref = $1 ORDER BY id", [`${STAMP}-s1`])).rows;
    assert.deepEqual(rows.map((r) => [r.import_source, r.subject]), [
      [`csv:${STAMP.toLowerCase()} alpha desk`, "From system A"],
      [`csv:${STAMP.toLowerCase()} beta desk`, "From system B"],
    ]);
    const again = await csvJob(`${header}${STAMP}-s1,From system A again,A body,Open,2026-10-01 10:00:00\r\n`, "export-later.csv", `${STAMP} Alpha desk`);
    assert.equal(again.dry.tickets_update, 1, "the same source name updates in place");
    assert.equal(again.dry.tickets_create, 0);
    const { importSourceKey, defaultSourceName } = await import("../src/lib/helpdesk/import-shared");
    assert.equal(importSourceKey("csv", {}), "csv", "a job from before source names keeps its key");
    assert.equal(importSourceKey("zoho", {}), "zoho");
    assert.equal(defaultSourceName("Freshdesk tickets.csv"), "Freshdesk tickets");
    const named = await upload("csv", Buffer.from(csvA), "Helpscout export.csv");
    assert.equal(named.mapping.source_name, "Helpscout export", "the file's name is the default");
    const blank = await call((await routes.job()).PUT, jsonReq(`/api/helpdesk/admin/import/${named.id}`, s("admin"), { source_name: "  " }, "PUT"), { id: String(named.id) });
    assert.equal(blank.status, 400);
  });

  test("a re-run never brings an anonymised ticket's data back", async () => {
    const csv = `${header}${STAMP}-anon,Secret subject,Personal details,Open,2026-10-01 10:00:00\r\n`;
    const msgs = `Ticket,Text,Author Email,Created\r\n${STAMP}-anon,More personal details,someone@out-${DOMAIN},2026-10-01 11:00:00\r\n`;
    const first = await csvJob(csv, "anon.csv", `${STAMP} anon`);
    assert.equal((await runToEnd(first.job.id))?.status, "completed");
    const t = (await pool().query("SELECT id FROM hd_tickets WHERE import_ref = $1", [`${STAMP}-anon`])).rows[0];
    await pool().query("UPDATE hd_tickets SET subject = 'Anonymised', requester_name = 'Anonymised', requester_email = '', anonymised_at = now() WHERE id = $1", [t.id]);
    await pool().query("UPDATE hd_messages SET body = '_(removed)_', author_name = 'Anonymised', author_email = '' WHERE ticket_id = $1", [t.id]);
    const job = await upload("csv", Buffer.from(csv), "anon.csv");
    const withMsgs = await call((await routes.messages()).POST, fileReq(`/api/helpdesk/admin/import/${job.id}/messages`, s("admin"), Buffer.from(msgs), "messages.csv"), { id: String(job.id) });
    assert.equal(withMsgs.status, 200, withMsgs.text);
    await call((await routes.job()).PUT, jsonReq(`/api/helpdesk/admin/import/${job.id}`, s("admin"), { timezone: "UTC", source_name: `${STAMP} anon` }, "PUT"), { id: String(job.id) });
    const dr = await call((await routes.dryRun()).POST, jsonReq(`/api/helpdesk/admin/import/${job.id}/dry-run`, s("admin"), {}), { id: String(job.id) });
    const d = dr.body.job.dry_run;
    assert.equal(d.tickets_update, 0);
    assert.equal(d.tickets_create, 0);
    assert.equal(d.skipped, 2, dr.text);
    const skippedCsv = await call((await routes.skipped()).GET, jsonReq(`/api/helpdesk/admin/import/${job.id}/skipped`, s("admin")), { id: String(job.id) });
    assert.match(skippedCsv.text, /anonymised/);
    // Started directly (the dry run says nothing to import, so the wizard would not offer it).
    const done = await runToEnd(job.id);
    assert.equal(done?.status, "completed", done?.error);
    assert.equal(done!.counts.result!.skipped, 2);
    const after = (await pool().query("SELECT subject, requester_email, anonymised_at FROM hd_tickets WHERE id = $1", [t.id])).rows[0];
    assert.equal(after.subject, "Anonymised");
    assert.equal(after.requester_email, "");
    assert.ok(after.anonymised_at);
    const bodies = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1", [t.id])).rows.map((r) => r.body).join("\n");
    assert.doesNotMatch(bodies, /Personal details/i);
  });

  test("a run whose job was taken over after a stall stops writing; the job completes once, never marked failed", async () => {
    const n = 5;
    let csv = header;
    for (let i = 1; i <= n; i++) csv += `${STAMP}-st${i},Stall ${i},Body ${i},Open,2026-10-0${i} 10:00:00\r\n`;
    const { job, dry } = await csvJob(csv, "stall.csv", `${STAMP} stall`);
    const imp = await lib();
    const batch = imp.IMPORT_BATCH as { tickets: number };
    const saved = batch.tickets;
    batch.tickets = 2;
    try {
      let batches = 0;
      let second: Awaited<ReturnType<typeof imp.runImportJob>>;
      const first = await runToEnd(job.id, {
        onBatch: async () => {
          batches++;
          if (batches !== 1) return;
          // The first runner looks stalled: another one claims the job and finishes it.
          await pool().query("UPDATE hd_import_jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [job.id]);
          second = await imp.runImportJob(job.id);
          assert.equal(second?.status, "completed", second?.error);
        },
      });
      assert.equal(batches, 1, "the first runner wrote no batch after it lost the job");
      assert.equal(first?.status, "completed", "and changed no status");
      assert.equal(first!.counts.result!.tickets_create, dry.tickets_create, "counts match the dry run");
      assert.equal((await ticketsOfRun(`${STAMP}-st`)).length, n);
      const audits = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.import.completed' AND target_id = $1", [String(job.id)]);
      assert.equal(audits.rowCount, 1, "completed is audited once");
    } finally {
      batch.tickets = saved;
    }
  });

  test("a running import keeps its heartbeat between batches", async () => {
    let csv = header;
    for (let i = 1; i <= 3; i++) csv += `${STAMP}-hb${i},Beat ${i},Body ${i},Open,2026-10-0${i} 10:00:00\r\n`;
    const { job } = await csvJob(csv, "beat.csv", `${STAMP} beat`);
    const imp = await lib();
    const batch = imp.IMPORT_BATCH as { tickets: number };
    const saved = batch.tickets;
    batch.tickets = 2;
    const beat = async () => ms((await pool().query("SELECT heartbeat_at FROM hd_import_jobs WHERE id = $1", [job.id])).rows[0].heartbeat_at);
    try {
      let moved = false;
      const done = await runToEnd(job.id, {
        heartbeatMs: 40,
        onBatch: async () => {
          const before = await beat();
          await new Promise((r) => setTimeout(r, 300));
          moved ||= (await beat()) > before;
        },
      });
      assert.ok(moved, "the heartbeat moved while no batch was written");
      assert.equal(done?.status, "completed", done?.error);
      assert.equal((await ticketsOfRun(`${STAMP}-hb`)).length, 3);
    } finally {
      batch.tickets = saved;
    }
  });
});
