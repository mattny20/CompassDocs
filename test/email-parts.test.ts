// Composable email templates (1.19.0, lib/email-parts): the seed is
// idempotent and carries the old per-template override into the event's
// built-in body; with the shipped defaults (Standard header, no signature,
// Standard footer) every event's body is byte for byte what 1.18 rendered
// (against the 1.18 module itself from git HEAD, and against the unchanged
// single-template renderer) inside the standard frame, and with "No header"
// and "No footer" chosen the whole mail is 1.18's; the once-only move to
// the standard defaults is idempotent and never overrides an admin's
// choice; the frame is HTML-email safe; the plain text has no markup; the
// manage link is absent for outside recipients and never doubled; a team
// scope falls back to 'all' slot by slot
// and 'all' to the kind's default; every part escapes the text tags; a part
// in use, a built-in and the default refuse deletion; the preview renders
// any combination and unsaved drafts; the sender's directory title fills
// the signature; the logo token becomes the workspace logo.
//
// Parallel-safe: the real events' compositions are never changed. The
// file's own events (zz_ept_* and hd_zzept_*) are registered in this
// process only; the default header is switched only to an EMPTY part of
// this file's (so a concurrent render elsewhere is unchanged) and back,
// under an advisory lock.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/email-parts.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { pool, getSetting, setSetting } from "../src/lib/db";
import {
  EMAIL_TEMPLATES,
  SAMPLE_VARS,
  accentHex,
  frameEmailHtml,
  withoutManageLink,
  renderEmail,
  previewEmail,
  renderSingleTemplate,
  renderComposedEmail,
  templateDef,
  templateOverride,
  saveTemplateOverride,
  resetTemplate,
} from "../src/lib/email-templates";
import type { EmailTemplateDef } from "../src/lib/email-templates";
import { getAppSettings } from "../src/lib/settings-store";
import {
  BUILTIN_FRAMES,
  bodyBuiltinKey,
  builtinBody,
  createPart,
  deleteComposition,
  deletePart,
  DEFAULTS_V2_MARKER,
  ensureEmailParts,
  migrateDefaultsV2,
  getComposition,
  getPart,
  listCompositions,
  listParts,
  previewComposition,
  putComposition,
  resetPart,
  resolveComposition,
  seedEmailParts,
  senderDetails,
  setDefaultPart,
  updatePart,
} from "../src/lib/email-parts";
import type { EmailPart } from "../src/lib/email-parts";

const ORIGIN = "https://docs.example.test";
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const REAL = EMAIL_TEMPLATES.map((t) => t.key); // before this file adds its own
const EV_PLAIN = `zz_ept_${STAMP}_plain`;
const EV_CARRY = `zz_ept_${STAMP}_carry`;
const EV_HD = `hd_zzept_${STAMP}`;
const EVIL = '**b** [x](https://evil.example) <script>alert(1)</script> <img src=x onerror=alert(1)>';

function def(key: string, extra: Partial<EmailTemplateDef> = {}): EmailTemplateDef {
  return {
    key,
    label: `Test ${key}`,
    description: "test-only event",
    tags: [
      { tag: "subject", label: "Subject" },
      { tag: "link", label: "Link" },
      { tag: "org_name", label: "Workspace" },
    ],
    text: ["subject"],
    subject: "[{{org_name}}] About {{subject}}",
    body: "We got **{{subject}}**.\n\n[Open it]({{link}})",
    ...extra,
  };
}

const createdParts: number[] = [];
const userIds: number[] = [];
let personId = 0;
let teamId = 0;

async function made(p: EmailPart | { error: string }): Promise<EmailPart> {
  if ("error" in p) throw new Error(p.error);
  createdParts.push(p.id);
  return p;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  await ensureEmailParts();
  EMAIL_TEMPLATES.push(def(EV_PLAIN), def(EV_CARRY), def(EV_HD, { text: ["subject", "team_name"], tags: [...def(EV_HD).tags, { tag: "team_name", label: "Team" }] }));
  // The old system's override, stored before the composable seed ran for this event.
  await setSetting(`email_tpl_${EV_CARRY}`, JSON.stringify({ subject: "Carried {{subject}}", body: "Carried over: {{subject}}" }));
  teamId = (
    await pool().query<{ id: number }>("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`ept-team-${STAMP}`])
  ).rows[0].id;
});

after(async () => {
  const events = [EV_PLAIN, EV_CARRY, EV_HD];
  await pool().query("DELETE FROM email_template_compositions WHERE event_key = ANY($1)", [events]);
  await pool().query("DELETE FROM email_template_parts WHERE event_key = ANY($1) OR id = ANY($2)", [events, createdParts]);
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [events.map((k) => `email_tpl_${k}`)]);
  await pool().query("DELETE FROM hd_teams WHERE id = $1", [teamId]);
  if (userIds.length) await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  if (personId) await pool().query("DELETE FROM directory_people WHERE id = $1", [personId]);
});

describe("seeding", () => {
  test("is idempotent: one built-in body and one 'all' composition per event, every frame once, one default per kind", async () => {
    await seedEmailParts([EV_PLAIN, EV_CARRY, EV_HD]);
    await seedEmailParts([EV_PLAIN, EV_CARRY, EV_HD]);
    await seedEmailParts();
    const bodies = await pool().query<{ builtin_key: string; n: number }>(
      "SELECT builtin_key, COUNT(*)::int AS n FROM email_template_parts WHERE builtin_key = ANY($1) GROUP BY builtin_key",
      [[...REAL, EV_PLAIN, EV_CARRY, EV_HD].map(bodyBuiltinKey)]
    );
    assert.equal(bodies.rows.length, REAL.length + 3, "every event has its built-in body");
    assert.ok(bodies.rows.every((r) => r.n === 1));
    const comps = await pool().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM email_template_compositions WHERE scope = 'all' AND event_key = ANY($1)",
      [[...REAL, EV_PLAIN, EV_CARRY, EV_HD]]
    );
    assert.equal(comps.rows[0].n, REAL.length + 3);
    const frames = await pool().query<{ n: number }>("SELECT COUNT(*)::int AS n FROM email_template_parts WHERE builtin_key = ANY($1)", [
      BUILTIN_FRAMES.map((f) => f.key),
    ]);
    assert.equal(frames.rows[0].n, BUILTIN_FRAMES.length);
    const defaults = await pool().query<{ kind: string; n: number }>(
      "SELECT kind, COUNT(*)::int AS n FROM email_template_parts WHERE is_default = 1 GROUP BY kind ORDER BY kind"
    );
    assert.deepEqual(defaults.rows, [
      { kind: "footer", n: 1 },
      { kind: "header", n: 1 },
      { kind: "signature", n: 1 },
    ]);
    // The seeded composition names the event's own built-in body.
    const c = await getComposition(EV_PLAIN);
    assert.equal(c?.stored, true);
    assert.equal(c?.body.source, "chosen");
    assert.equal(c?.body.effective_id, (await builtinBody(EV_PLAIN))!.id);
  });

  test("the old override carries over into the built-in body, and the old API maps onto it", async () => {
    const body = await builtinBody(EV_CARRY);
    assert.equal(body?.subject, "Carried {{subject}}");
    assert.equal(body?.content, "Carried over: {{subject}}");
    assert.equal(body?.customized, true);
    assert.deepEqual(await templateOverride(EV_CARRY), { subject: "Carried {{subject}}", body: "Carried over: {{subject}}" });
    const sent = await renderEmail(EV_CARRY, { subject: "VPN", link: "/x" }, ORIGIN);
    assert.equal(sent.subject, "Carried VPN");
    assert.ok(sent.text.includes("\n\nCarried over: VPN\n\n"), sent.text);
    // A later seed never overwrites an edited body.
    await seedEmailParts([EV_CARRY]);
    assert.equal((await builtinBody(EV_CARRY))?.content, "Carried over: {{subject}}");
    await resetTemplate(EV_CARRY);
    assert.equal(await templateOverride(EV_CARRY), null);
    assert.equal((await builtinBody(EV_CARRY))?.customized, false);
    await saveTemplateOverride(EV_CARRY, "Saved {{subject}}", "Saved body");
    assert.equal((await renderEmail(EV_CARRY, { subject: "S", link: "/x" }, ORIGIN)).subject, "Saved S");
    const reset = await resetPart((await builtinBody(EV_CARRY))!.id);
    assert.ok(!("error" in reset));
    assert.equal((reset as EmailPart).content, def(EV_CARRY).body);
  });
});

/** Holds the lock G's set-default test takes while it moves the header default, so the defaults stand still. */
async function withDefaultsLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = new Client({ connectionString: process.env.DATABASE_URL });
  await lock.connect();
  await lock.query("SELECT pg_advisory_lock(hashtext('email-parts-test:defaults'))");
  try {
    return await fn();
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('email-parts-test:defaults'))").catch(() => {});
    await lock.end();
  }
}

const STD = (k: string) => BUILTIN_FRAMES.find((f) => f.key === k)!.content;
/** The body's cell inside the standard frame (header above, footer below). */
const BODY_CELL = /<tr><td style="padding:20px 0 0">([\s\S]*)<\/td><\/tr><tr><td style="padding:24px 0 0">/;

/** What the Standard header and footer add to the text part of `key`'s mail. */
function frameText(key: string, org: string, bodyTpl: string): { head: string; foot: string } {
  const d = templateDef(key)!;
  const own = /\{\{\s*manage_(notifications_)?url\s*\}\}/.test(bodyTpl) || d.manageLink === false;
  return { head: org, foot: own ? `Sent by ${org}` : `Sent by ${org} · Manage your notifications: ` };
}

describe("the default compositions: 1.18 bodies inside the standard header and footer", () => {
  /**
   * Render through the stored state, retrying while another file's
   * temporary override (team-digest's) moves under the comparison.
   */
  async function compare(key: string, old: () => Promise<{ subject: string; text: string; html: string; bodyTpl: string }>) {
    const settings = await getAppSettings();
    const org = settings.company_name || "CompassDocs";
    let last = "";
    for (let i = 0; i < 5; i++) {
      const a = await old();
      const b = await renderEmail(key, SAMPLE_VARS[key] ?? {}, ORIGIN);
      const cell = BODY_CELL.exec(b.html)?.[1];
      const { head, foot } = frameText(key, org, a.bodyTpl);
      const textOk = b.text.startsWith(`${head}\n\n${a.text}\n\n${foot}`) && (foot.endsWith(": ") ? /account\/notifications(#notify-[a-z-]+)?$/.test(b.text) : b.text.endsWith(foot));
      if (a.subject === b.subject && cell === a.html && textOk) {
        // The whole mail is the frame around those exact bytes.
        const expected = await renderComposedEmail(
          key,
          { header: STD("header:standard"), subject: a.subject, body: a.bodyTpl, signature: "", footer: STD("footer:standard") },
          { org_name: org, ...(SAMPLE_VARS[key] ?? {}) },
          ORIGIN,
          settings
        );
        assert.equal(b.html, expected.html, `${key}: standard header + body + standard footer`);
        assert.ok(b.html.startsWith('<table role="presentation"'), key);
        return;
      }
      last = JSON.stringify({ old: a, now: b }).slice(0, 2500);
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail(`${key}: the default composition no longer renders the 1.18 body inside the standard frame\n${last}`);
  }

  test("the shipped defaults are the Standard header and footer, and no signature", async () => {
    await withDefaultsLock(async () => {
      const c = await resolveComposition(REAL[0]);
      assert.equal(c.header?.content, STD("header:standard"));
      assert.equal(c.signature?.content ?? "", "");
      assert.equal(c.footer?.content, STD("footer:standard"));
      assert.ok(BUILTIN_FRAMES.find((f) => f.key === "header:standard")!.seedDefault);
      assert.ok(BUILTIN_FRAMES.find((f) => f.key === "footer:standard")!.seedDefault);
      assert.ok(BUILTIN_FRAMES.find((f) => f.key === "signature:none")!.seedDefault);
      assert.ok(await getSetting(DEFAULTS_V2_MARKER), "the move to the standard defaults is recorded");
    });
  });

  test("every event: the body is byte for byte the single-template renderer's, in the standard frame", async () => {
    const settings = await getAppSettings();
    await withDefaultsLock(async () => {
      for (const key of REAL) {
        const d = templateDef(key)!;
        assert.ok(SAMPLE_VARS[key], `${key} has sample values`);
        await compare(key, async () => {
          const o = await templateOverride(key);
          const vars = { org_name: settings.company_name || "CompassDocs", ...SAMPLE_VARS[key] };
          const bodyTpl = o?.body || d.body;
          return { ...(await renderSingleTemplate(d, o?.subject || d.subject, bodyTpl, vars, settings.accent_color, ORIGIN)), bodyTpl };
        });
      }
    });
  });

  test("every event of the 1.18 module (git HEAD): the same body bytes", async (t) => {
    let source = "";
    try {
      source = execFileSync("git", ["show", "HEAD:src/lib/email-templates.ts"], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    } catch {
      t.skip("git HEAD is not available");
      return;
    }
    if (source.includes("email-parts")) {
      t.skip("HEAD already has the composable templates");
      return;
    }
    const lib = path.join(__dirname, "..", "src", "lib");
    const dir = mkdtempSync(path.join(tmpdir(), "ept-"));
    const file = path.join(dir, "email-templates-118.ts");
    writeFileSync(file, source.replace(/from "\.\/([\w-]+)"/g, (_m, mod) => `from ${JSON.stringify(path.join(lib, mod))}`).replace('import "server-only";', ""));
    try {
      const old = (await import(file)) as typeof import("../src/lib/email-templates");
      let compared = 0;
      await withDefaultsLock(async () => {
        for (const od of old.EMAIL_TEMPLATES) {
          const now = templateDef(od.key);
          // Only an event whose shipped copy is unchanged since HEAD, with no customisation in this database.
          if (!now || now.subject !== od.subject || now.body !== od.body) continue;
          if ((await templateOverride(od.key)) || (await getSetting(`email_tpl_${od.key}`))) continue;
          await compare(od.key, async () => ({ ...(await old.renderEmail(od.key, SAMPLE_VARS[od.key] ?? {}, ORIGIN)), bodyTpl: od.body }));
          compared++;
        }
      });
      assert.ok(compared >= 10, `compared ${compared} events against 1.18`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with "No header" and "No footer" chosen, every event is exactly 1.18 (the opt-out, and own-layout mail)', async () => {
    const settings = await getAppSettings();
    const parts = await listParts();
    const noHeader = parts.find((p) => p.builtin_key === "header:none")!;
    const noFooter = parts.find((p) => p.builtin_key === "footer:none")!;
    for (const key of REAL) {
      const d = templateDef(key)!;
      const o = await templateOverride(key);
      const vars = { org_name: settings.company_name || "CompassDocs", ...SAMPLE_VARS[key] };
      const old = await renderSingleTemplate(d, o?.subject || d.subject, o?.body || d.body, vars, settings.accent_color, ORIGIN);
      const p = await previewComposition({ event: key, header_id: noHeader.id, footer_id: noFooter.id, vars: SAMPLE_VARS[key] }, ORIGIN);
      assert.ok(!("error" in p), JSON.stringify(p));
      const out = p as { subject: string; html: string; text: string };
      // The preview adds the sample frame tags (recipient and sender names), which no 1.18 body uses.
      assert.equal(out.html, old.html, key);
      assert.equal(out.text, old.text, key);
      assert.equal(out.subject, old.subject, key);
    }
    assert.equal(frameEmailHtml({ body: "<p>x</p>" }, "#123456"), "<p>x</p>", "no frame: the body as it is");
  });

  test("mail with its own layout never goes through the parts (newsletters, the weekly digest)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = (f: string) => readFileSync(path.join(__dirname, "..", "src", "lib", f), "utf8");
    assert.doesNotMatch(src("digest.ts"), /renderEmail|renderComposedEmail/, "the weekly digest builds its own mail");
    const nl = src("newsletter.ts");
    assert.doesNotMatch(nl, /\brenderEmail\(|renderComposedEmail/, "newsletters keep their own header and footer");
  });

  test("previewEmail keeps its shape and still renders the unsaved body", async () => {
    const p = await previewEmail("doc_update", "Hi {{doc_title}}", "Body **{{doc_title}}**", ORIGIN);
    assert.deepEqual(Object.keys(p).sort(), ["html", "subject"]);
    assert.equal(p.subject, `Hi ${SAMPLE_VARS.doc_update.doc_title}`);
    assert.ok(p.html.includes(`<p style="margin:0 0 12px;line-height:1.6">Body <strong>`), p.html);
  });
});

describe("the once-only move to the standard defaults", () => {
  /** Run `fn` on a client inside a transaction that is always rolled back: the shared database never sees it. */
  async function sandbox<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query("BEGIN");
    try {
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.end();
    }
  }
  /** The state G's first seed left: the empty parts are the defaults and no marker. */
  async function asV1(c: Client) {
    await c.query("DELETE FROM settings WHERE key = $1", [DEFAULTS_V2_MARKER]);
    for (const kind of ["header", "footer"]) {
      await c.query("UPDATE email_template_parts SET is_default = 0 WHERE kind = $1 AND is_default = 1", [kind]);
      await c.query("UPDATE email_template_parts SET is_default = 1 WHERE builtin_key = $1", [`${kind}:none`]);
    }
  }
  const defaults = async (c: Client) =>
    Object.fromEntries(
      (
        await c.query<{ kind: string; builtin_key: string | null; id: number }>(
          "SELECT kind, builtin_key, id FROM email_template_parts WHERE is_default = 1 ORDER BY kind"
        )
      ).rows.map((r) => [r.kind, r.builtin_key ?? `id:${r.id}`])
    );

  test("an untouched upgraded workspace moves once, and never again", async () => {
    await sandbox(async (c) => {
      await c.query("DELETE FROM audit_log WHERE action = 'email_template.default_changed'");
      await asV1(c);
      assert.deepEqual(await migrateDefaultsV2(c), ["header", "footer"]);
      assert.deepEqual(await defaults(c), { footer: "footer:standard", header: "header:standard", signature: "signature:none" });
      assert.ok((await c.query("SELECT 1 FROM settings WHERE key = $1", [DEFAULTS_V2_MARKER])).rows.length === 1);
      // Idempotent: the marker stops it, even after an admin goes back to "No header".
      await c.query("UPDATE email_template_parts SET is_default = 0 WHERE kind = 'header' AND is_default = 1");
      await c.query("UPDATE email_template_parts SET is_default = 1 WHERE builtin_key = 'header:none'");
      assert.deepEqual(await migrateDefaultsV2(c), []);
      assert.equal((await defaults(c)).header, "header:none");
    });
  });

  test("a default an admin chose is never overridden", async () => {
    await sandbox(async (c) => {
      await c.query("DELETE FROM audit_log WHERE action = 'email_template.default_changed'");
      await asV1(c);
      // The admin chose "No header" on purpose (the audit says so); the footer is untouched.
      await c.query(
        `INSERT INTO audit_log (actor_name, action, target_type, details) VALUES ('ept admin', 'email_template.default_changed', 'email_template_part', '{"kind":"header"}')`
      );
      assert.deepEqual(await migrateDefaultsV2(c), ["footer"]);
      assert.deepEqual(await defaults(c), { footer: "footer:standard", header: "header:none", signature: "signature:none" });
    });
    await sandbox(async (c) => {
      await c.query("DELETE FROM audit_log WHERE action = 'email_template.default_changed'");
      await asV1(c);
      // A custom default (not the built-in empty one) stays, audited or not.
      const own = (
        await c.query<{ id: number }>("INSERT INTO email_template_parts (kind, name, content) VALUES ('footer', $1, 'Our footer') RETURNING id", [
          `ept own footer ${STAMP}`,
        ])
      ).rows[0].id;
      await c.query("UPDATE email_template_parts SET is_default = 0 WHERE kind = 'footer' AND is_default = 1");
      await c.query("UPDATE email_template_parts SET is_default = 1 WHERE id = $1", [own]);
      assert.deepEqual(await migrateDefaultsV2(c), ["header"]);
      assert.equal((await defaults(c)).footer, `id:${own}`);
    });
  });
});

describe("the frame is HTML-email safe and its text is plain", () => {
  test("tables, inline styles, 600px, the accent as hex, alt text on the logo, nothing dark mode would trip on", async () => {
    const settings = { ...(await getAppSettings()), company_name: "Acme", logo_url: "/uploads/logo.png", accent_color: "#4F46E5" };
    const out = await renderComposedEmail(
      EV_PLAIN,
      { header: STD("header:standard"), subject: "S", body: "We got **x**.", signature: STD("signature:team"), footer: STD("footer:standard") },
      { team_name: "IT", subject: "x" },
      ORIGIN,
      settings
    );
    const html = out.html;
    assert.match(html, /^<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"/);
    assert.match(html, /<table role="presentation"[^>]* width="600" style="width:100%;max-width:600px;/);
    assert.doesNotMatch(html, /<style|<div|<link|\bclass=|var\(--|rgb\(/i, "inline styles only, no CSS variables");
    for (const tag of html.match(/<(table|td)\b[^>]*>/g) ?? []) assert.match(tag, /style="/, `${tag} is styled inline`);
    assert.ok(html.includes("border-bottom:3px solid #4f46e5"), "the accent rule, as hex");
    assert.doesNotMatch(html, /background|bgcolor/i, "no painted background: a client's dark mode recolours the mail");
    assert.doesNotMatch(html, /color:#(?:000|fff)/i, "no black or white text that flips badly");
    assert.ok(html.includes(`<img src="${ORIGIN}/uploads/logo.png" alt="Acme" width="28" height="28"`), html);
    assert.equal(out.text, "Acme\n\nWe got x.\n\nIT · Acme\n\nSent by Acme · Manage your notifications: " + `${ORIGIN}/account/notifications`);

    // A header with an image and HTML: the text keeps the words only.
    const fancy = await renderComposedEmail(
      EV_PLAIN,
      { header: '{{logo}} ![Acme banner](https://cdn.example/b.png) <span>**Acme**</span> news', subject: "S", body: "B", signature: "", footer: "" },
      {},
      ORIGIN,
      settings
    );
    const head = fancy.text.split("\n\n")[0];
    assert.equal(head, "Acme banner Acme news");
    assert.doesNotMatch(fancy.text, /\*\*|!\[|\]\(|<|CDLOGOTAGX|\{\{/);
  });

  test("accentHex resolves every stored shape to #rrggbb", () => {
    assert.equal(accentHex("#2E75BD"), "#2e75bd");
    assert.equal(accentHex("#abc"), "#aabbcc");
    assert.equal(accentHex("46 117 189"), "#2e75bd");
    assert.equal(accentHex("rgb(46, 117, 189)"), "#2e75bd");
    assert.equal(accentHex("red;background:url(x)"), "#2e75bd");
    assert.equal(accentHex(""), "#2e75bd");
  });
});

describe("the manage link and the recipient", () => {
  test("withoutManageLink drops the link and its separator, nothing else", () => {
    assert.equal(withoutManageLink(STD("footer:standard")), "Sent by {{org_name}}");
    assert.equal(withoutManageLink("[Manage]({{manage_notifications_url}}) · Acme"), "Acme");
    assert.equal(withoutManageLink("A · [M]({{manage_notifications_url}}) · B\nkept"), "A · B\nkept");
    assert.equal(withoutManageLink("Only [M]({{manage_notifications_url}})\nnext"), "Only\nnext");
    assert.equal(withoutManageLink("[M]({{manage_notifications_url}})\nnext"), "next");
  });

  test("an outside address gets no manage link; a workspace user gets it and their name", async () => {
    const h = await made(await createPart({ kind: "header", name: `ept rcpt ${STAMP}`, content: "Hi {{recipient_name}}" }, null));
    const f = await made(await createPart({ kind: "footer", name: `ept rcptf ${STAMP}`, content: STD("footer:standard") }, null));
    await putComposition(EV_PLAIN, "all", { header_id: h.id, footer_id: f.id }, null);
    try {
      const outside = await renderEmail(EV_PLAIN, { subject: "x", link: "/x" }, ORIGIN, { recipientEmail: `nobody-${STAMP}@outside.example` });
      assert.doesNotMatch(outside.html + outside.text, /Manage your notifications|account\/notifications/, outside.html);
      assert.match(outside.text, /\n\nSent by [^\n·]+$/, "the footer keeps its first half");
      assert.match(outside.text, /^Hi\n\n/, "no account, no name: the tag is blank");

      const uid = (
        await pool().query<{ id: number }>(
          "INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id",
          [`ept-rcpt-${STAMP}`, "Rana <Recipient>", `Ept-Rcpt-${STAMP}@Example.test`]
        )
      ).rows[0].id;
      userIds.push(uid);
      for (const opts of [{ recipientUserId: uid }, { recipientEmail: `ept-rcpt-${STAMP}@example.test` }]) {
        const known = await renderEmail(EV_PLAIN, { subject: "x", link: "/x" }, ORIGIN, opts);
        assert.ok(known.html.includes("Hi Rana &lt;Recipient&gt;"), known.html);
        assert.ok(known.text.startsWith("Hi Rana <Recipient>\n\n"), known.text);
        assert.ok(known.html.includes(`href="${ORIGIN}/account/notifications"`), "the link stays for a user");
      }
      // A value the sender passes wins.
      const named = await renderEmail(EV_PLAIN, { subject: "x", link: "/x", recipient_name: "Team" }, ORIGIN, { recipientUserId: uid });
      assert.ok(named.text.startsWith("Hi Team\n\n"), named.text);
    } finally {
      await putComposition(EV_PLAIN, "all", { header_id: null, footer_id: null }, null);
    }
  });

  test("never twice: a body with its own manage link, and an email channel, get a footer without it", async () => {
    const settings = { ...(await getAppSettings()), company_name: "Acme" };
    for (const key of ["doc_update", "mention", "workflow_event"]) {
      const out = await renderComposedEmail(
        key,
        { header: "", subject: "S", body: templateDef(key)!.body, signature: "", footer: STD("footer:standard") },
        SAMPLE_VARS[key],
        ORIGIN,
        settings
      );
      assert.doesNotMatch(out.html, /Manage your notifications/, key);
      assert.ok(out.text.endsWith("\n\nSent by Acme"), `${key}: ${out.text.slice(-60)}`);
    }
  });

  test("the link opens the section that governs the email", async () => {
    const settings = { ...(await getAppSettings()), company_name: "Acme" };
    const at = async (key: string) =>
      /href="([^"]*account\/notifications[^"]*)"/.exec(
        (
          await renderComposedEmail(key, { header: "", subject: "S", body: "B", signature: "", footer: STD("footer:standard") }, {}, ORIGIN, settings)
        ).html
      )?.[1];
    assert.equal(await at("hd_reply"), `${ORIGIN}/account/notifications#notify-helpdesk`);
    assert.equal(await at("ack_due"), `${ORIGIN}/account/notifications#notify-read-confirmations`);
    assert.equal(await at("ack_program_report"), `${ORIGIN}/account/notifications`);
  });
});

describe("composition and rendering", () => {
  let header: EmailPart;
  let teamSig: EmailPart;
  let teamBody: EmailPart;

  before(async () => {
    header = await made(await createPart({ kind: "header", name: `ept header ${STAMP}`, content: "HEADER {{org_name}}" }, null));
    teamSig = await made(await createPart({ kind: "signature", name: `ept sig ${STAMP}`, content: "SIG {{team_name}}" }, null));
    teamBody = await made(
      await createPart({ kind: "body", name: `ept team body ${STAMP}`, event_key: EV_HD, subject: "Team: {{subject}}", content: "TEAMBODY {{subject}}" }, null)
    );
  });

  test("a team scope falls back to 'all' slot by slot, and 'all' to the defaults", async () => {
    const scope = `hd_team:${teamId}`;
    const a = await putComposition(EV_HD, "all", { header_id: header.id }, null);
    assert.ok(!("error" in a), JSON.stringify(a));
    const t1 = await putComposition(EV_HD, scope, { signature_id: teamSig.id, body_id: teamBody.id }, null);
    assert.ok(!("error" in t1), JSON.stringify(t1));

    const team = await resolveComposition(EV_HD, scope);
    assert.equal(team.header?.id, header.id, "the team inherits the 'all' header");
    assert.equal(team.signature?.id, teamSig.id);
    assert.equal(team.body?.id, teamBody.id);
    const all = await resolveComposition(EV_HD, "all");
    assert.equal(all.header?.id, header.id);
    assert.equal(all.body?.id, (await builtinBody(EV_HD))!.id);
    assert.equal(all.signature?.content ?? "", "", "the default signature (empty)");
    const other = await resolveComposition(EV_HD, "hd_team:999999999");
    assert.deepEqual(other, all, "a team without a variant is 'all'");
    assert.deepEqual(await resolveComposition(EV_HD, "not a scope"), all);

    const view = (await getComposition(EV_HD, scope))!;
    assert.equal(view.stored, true);
    assert.equal(view.header.source, "all");
    assert.equal(view.header.id, null);
    assert.equal(view.signature.source, "chosen");
    assert.equal(view.footer.source, "default");

    const sent = await renderEmail(EV_HD, { subject: "VPN", link: "/x", team_name: "IT" }, ORIGIN, { scope });
    assert.equal(sent.subject, "Team: VPN");
    assert.ok(sent.html.includes("HEADER"), sent.html);
    assert.ok(sent.html.includes("TEAMBODY VPN"));
    assert.ok(sent.html.includes("SIG IT"));
    assert.equal(sent.text.split("\n\n")[0].startsWith("HEADER"), true, sent.text);
    // A team scope never applies to an event that is not a helpdesk one, and the team must exist.
    assert.equal(("error" in (await putComposition(EV_PLAIN, scope, {}, null))) as boolean, true);
    assert.equal(((await putComposition(EV_HD, "hd_team:999999999", {}, null)) as { status: number }).status, 404);
    // A body of another event, or a part of the wrong kind, is refused.
    assert.equal(((await putComposition(EV_PLAIN, "all", { body_id: teamBody.id }, null)) as { status: number }).status, 400);
    assert.equal(((await putComposition(EV_HD, "all", { header_id: teamSig.id }, null)) as { status: number }).status, 400);

    // Removing the variant: the team is 'all' again.
    assert.deepEqual(await deleteComposition(EV_HD, scope), { ok: true });
    assert.deepEqual(await resolveComposition(EV_HD, scope), await resolveComposition(EV_HD, "all"));
    assert.equal(((await deleteComposition(EV_HD, "all")) as { status: number }).status, 400);
  });

  test("every part renders the text tags as written and escaped: header, body, signature and footer", async () => {
    const h = await made(await createPart({ kind: "header", name: `ept h2 ${STAMP}`, content: "H {{org_name}} {{recipient_name}} {{subject}}" }, null));
    const s = await made(await createPart({ kind: "signature", name: `ept s2 ${STAMP}`, content: "S {{sender_name}} {{sender_title}} {{team_name}}" }, null));
    const f = await made(await createPart({ kind: "footer", name: `ept f2 ${STAMP}`, content: "F {{recipient_name}} [Manage]({{manage_notifications_url}}) {{link}}" }, null));
    const r = await putComposition(EV_PLAIN, "all", { header_id: h.id, signature_id: s.id, footer_id: f.id }, null);
    assert.ok(!("error" in r));
    const vars = {
      org_name: EVIL,
      subject: EVIL,
      recipient_name: EVIL,
      sender_name: EVIL,
      sender_title: EVIL,
      team_name: EVIL,
      link: "<b>bold</b>",
    };
    let out: { subject: string; text: string; html: string };
    try {
      out = await renderEmail(EV_PLAIN, vars, ORIGIN);
    } finally {
      await putComposition(EV_PLAIN, "all", { header_id: null, signature_id: null, footer_id: null }, null);
    }
    // No live tag, attribute or link from a value: only escaped text.
    assert.doesNotMatch(out.html, /<script|<img|href="https:\/\/evil\.example"/i, out.html);
    assert.doesNotMatch(out.html, /<strong>b<\/strong>/, "no text tag is read as markdown");
    const escaped = "**b** [x](https://evil.example) &lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;";
    // Header (org_name, recipient_name, subject), body (subject), signature (three), footer (recipient_name).
    assert.equal(out.html.split(escaped).length - 1, 8, out.html);
    assert.ok(out.html.includes(`href="${ORIGIN}/account/notifications"`), "the manage link is absolute");
    // A non-text tag is substituted before the markdown pass, as always, and sanitized.
    assert.ok(out.html.includes("<b>bold</b>"));
    // The text part carries each value as written, the subject too.
    assert.ok(out.text.includes(`H ${EVIL} ${EVIL} ${EVIL}`), out.text);
    assert.ok(out.subject.includes(EVIL));
    // The frame: an accent rule under the header, a hairline over the footer.
    assert.match(out.html, /^<table role="presentation"[\s\S]*<td style="padding:0 0 12px;border-bottom:3px solid #[0-9a-f]{6};/);
    assert.match(out.html, /<td style="padding:12px 0 0;border-top:1px solid #e2e8f0;[^"]*">.*F /s);
  });

  test("a signature whose tags are all blank leaves no frame; the sender's directory title fills it", async () => {
    const s = await made(await createPart({ kind: "signature", name: `ept s3 ${STAMP}`, content: "{{sender_name}}\n\n{{sender_title}}" }, null));
    await putComposition(EV_PLAIN, "all", { signature_id: s.id }, null);
    const bare = await renderEmail(EV_PLAIN, { subject: "x", link: "/x" }, ORIGIN);
    assert.doesNotMatch(bare.html, /padding:16px 0 0/, bare.html);
    assert.ok(bare.text.includes("\n\nWe got x.\n\nOpen it: /x\n\nSent by "), "the text part keeps the link as written, as before");

    personId = (
      await pool().query<{ id: number }>("INSERT INTO directory_people (name, title, email) VALUES ($1, $2, $3) RETURNING id", [
        `Ept Sender ${STAMP}`,
        "Head of <IT>",
        `ept-${STAMP}@example.test`,
      ])
    ).rows[0].id;
    const uid = (
      await pool().query<{ id: number }>(
        "INSERT INTO users (username, name, email, role, status, directory_person_id) VALUES ($1, $2, $3, 'viewer', 'active', $4) RETURNING id",
        [`ept-${STAMP}`, "Priya Sender", `ept-${STAMP}@example.test`, personId]
      )
    ).rows[0].id;
    userIds.push(uid);
    assert.deepEqual(await senderDetails(uid), { name: "Priya Sender", title: "Head of <IT>" });
    const signed = await renderEmail(EV_PLAIN, { subject: "x", link: "/x" }, ORIGIN, { senderUserId: uid });
    assert.ok(signed.html.includes("Head of &lt;IT&gt;"), signed.html);
    assert.ok(signed.text.includes("\n\nPriya Sender\n\nHead of <IT>\n\nSent by "), signed.text);
    // A value the sender passes wins over the directory.
    const named = await renderEmail(EV_PLAIN, { subject: "x", link: "/x", sender_name: "Desk", sender_title: "" }, ORIGIN, { senderUserId: uid });
    assert.ok(named.text.includes("\n\nDesk\n\nSent by "), named.text);
    await putComposition(EV_PLAIN, "all", { signature_id: null }, null);
  });

  test("{{logo}} is the workspace logo (absolute) in html and nothing in text", async () => {
    const settings = { ...(await getAppSettings()), logo_url: "/uploads/logo.png", company_name: "Acme" };
    const out = await renderComposedEmail(
      EV_PLAIN,
      { header: "{{logo}} **{{org_name}}**", subject: "S", body: "B", signature: "", footer: "" },
      {},
      ORIGIN,
      settings
    );
    assert.ok(out.html.includes(`<img src="${ORIGIN}/uploads/logo.png" alt="Acme" width="28" height="28"`), out.html);
    assert.ok(out.html.includes("<strong>Acme</strong>"));
    assert.equal(out.text, "Acme\n\nB");
    const none = await renderComposedEmail(EV_PLAIN, { header: "{{logo}}", subject: "S", body: "B", signature: "", footer: "" }, {}, ORIGIN, {
      ...settings,
      logo_url: "",
    });
    assert.equal(none.html, "<p style=\"margin:0 0 12px;line-height:1.6\">B</p>", "a header of only a missing logo is no header");
  });

  test("the built-in Standard header and footer render the brand", async () => {
    const settings = { ...(await getAppSettings()), company_name: "Acme <Co>", logo_url: "" };
    const std = (k: string) => BUILTIN_FRAMES.find((f) => f.key === k)!.content;
    const out = await renderComposedEmail(
      "doc_update",
      { header: std("header:standard"), subject: "S", body: "B", signature: std("signature:team"), footer: std("footer:standard") },
      { team_name: "IT" },
      ORIGIN,
      settings
    );
    assert.ok(out.html.includes("<strong>Acme &lt;Co&gt;</strong>"), out.html);
    assert.ok(out.html.includes("IT · Acme &lt;Co&gt;"));
    assert.ok(out.html.includes(`Sent by Acme &lt;Co&gt; · <a href="${ORIGIN}/account/notifications#notify-documents"`), out.html);
    assert.equal(
      out.text,
      `Acme <Co>\n\nB\n\nIT · Acme <Co>\n\nSent by Acme <Co> · Manage your notifications: ${ORIGIN}/account/notifications#notify-documents`
    );
  });
});

describe("the part library", () => {
  test("delete is refused while a composition names the part (with the emails), for a built-in and for the default", async () => {
    const h = await made(await createPart({ kind: "header", name: `ept del ${STAMP}`, content: "x" }, null));
    await putComposition(EV_PLAIN, "all", { header_id: h.id }, null);
    const refused = await deletePart(h.id);
    assert.ok("error" in refused);
    assert.equal((refused as { status: number }).status, 409);
    assert.deepEqual(
      (refused as { used_by: unknown[] }).used_by,
      [{ event_key: EV_PLAIN, event_label: `Test ${EV_PLAIN}`, scope: "all", slot: "header" }]
    );
    assert.equal((await getPart(h.id))?.used_by.length, 1);
    await putComposition(EV_PLAIN, "all", { header_id: null }, null);
    assert.ok(!("error" in (await deletePart(h.id))));
    assert.equal(await getPart(h.id), null);

    const builtin = (await listParts({ kind: "header" })).find((p) => p.builtin_key === "header:standard")!;
    assert.equal(((await deletePart(builtin.id)) as { status: number }).status, 409);
    const dflt = (await listParts({ kind: "footer" })).find((p) => p.is_default)!;
    assert.equal(((await deletePart(dflt.id)) as { status: number }).status, 409);
    assert.equal(((await deletePart(99999999)) as { status: number }).status, 404);
  });

  test("validation: kinds, names, a body's event and subject, the limits", async () => {
    assert.equal(((await createPart({ kind: "banner", name: "x" }, null)) as { status: number }).status, 400);
    assert.equal(((await createPart({ kind: "header", name: "  " }, null)) as { status: number }).status, 400);
    assert.equal(((await createPart({ kind: "body", name: "b", event_key: "no_such_event", subject: "s", content: "c" }, null)) as { status: number }).status, 400);
    assert.equal(((await createPart({ kind: "body", name: "b", event_key: EV_PLAIN, subject: "", content: "c" }, null)) as { status: number }).status, 400);
    assert.equal(((await createPart({ kind: "footer", name: "f", content: "x".repeat(5001) }, null)) as { status: number }).status, 400);
    const p = await made(await createPart({ kind: "footer", name: `ept v ${STAMP}`, content: "one" }, null));
    const u = await updatePart(p.id, { content: "two", subject: "ignored for a footer" });
    assert.equal((u as EmailPart).content, "two");
    assert.equal((u as EmailPart).subject, "");
    assert.equal(((await resetPart(p.id)) as { status: number }).status, 400, "only a built-in resets");
  });

  test("set default: the kind's default moves (to an empty test part, then back)", async () => {
    const lock = new Client({ connectionString: process.env.DATABASE_URL });
    await lock.connect();
    await lock.query("SELECT pg_advisory_lock(hashtext('email-parts-test:defaults'))");
    const prev = (await listParts({ kind: "header" })).find((p) => p.is_default)!;
    const empty = await made(await createPart({ kind: "header", name: `ept empty ${STAMP}`, content: "" }, null));
    try {
      const r = await setDefaultPart(empty.id);
      assert.ok(!("error" in r));
      assert.equal((r as { changed: boolean }).changed, true);
      assert.equal((r as { previous: EmailPart }).previous.id, prev.id);
      const view = (await getComposition(EV_PLAIN))!;
      assert.equal(view.header.source, "default");
      assert.equal(view.header.effective_id, empty.id);
      const again = await setDefaultPart(empty.id);
      assert.equal((again as { changed: boolean }).changed, false);
      const body = (await builtinBody(EV_PLAIN))!;
      assert.equal(((await setDefaultPart(body.id)) as { status: number }).status, 400);
    } finally {
      await setDefaultPart(prev.id);
      await lock.query("SELECT pg_advisory_unlock(hashtext('email-parts-test:defaults'))");
      await lock.end();
    }
    assert.equal((await getPart(prev.id))?.is_default, true);
  });

  test("listCompositions covers every event, in order", async () => {
    const all = await listCompositions();
    assert.deepEqual(all.map((c) => c.event_key), EMAIL_TEMPLATES.map((t) => t.key));
    assert.ok(all.every((c) => c.body.effective_id != null));
  });
});

describe("preview", () => {
  test("any combination, with drafts, sample values and no save", async () => {
    const p = await previewComposition(
      { event: EV_PLAIN, header_id: null, draft: { kind: "footer", content: "Draft footer {{org_name}}" }, vars: { subject: "Sampled" } },
      ORIGIN
    );
    assert.ok(!("error" in p), JSON.stringify(p));
    const out = p as { subject: string; html: string; text: string; parts: Record<string, { id: number | null }> };
    assert.ok(out.subject.endsWith("About Sampled"));
    assert.ok(out.html.includes("Draft footer"));
    assert.ok(out.text.includes("Draft footer"));
    assert.equal(out.parts.body.id, (await builtinBody(EV_PLAIN))!.id);
    // Nothing was saved: the footer is still the default one.
    const dflt = (await listParts({ kind: "footer" })).find((p) => p.is_default);
    assert.equal((await resolveComposition(EV_PLAIN)).footer?.id, dflt?.id);
    const body = await previewComposition({ event_key: EV_PLAIN, drafts: { body: { subject: "D {{subject}}", content: "Draft body" } } }, ORIGIN);
    assert.ok((body as { html: string }).html.includes('<p style="margin:0 0 12px;line-height:1.6">Draft body</p>'));
    assert.equal(((await previewComposition({ event: "nope" }, ORIGIN)) as { status: number }).status, 404);
    assert.equal(((await previewComposition({ event: EV_PLAIN, scope: "everyone" }, ORIGIN)) as { status: number }).status, 400);
    assert.equal(((await previewComposition({ event: EV_PLAIN, draft: { kind: "x" } }, ORIGIN)) as { status: number }).status, 400);
    const other = await made(await createPart({ kind: "body", name: `ept ob ${STAMP}`, event_key: EV_HD, subject: "s", content: "c" }, null));
    assert.equal(((await previewComposition({ event: EV_PLAIN, body_id: other.id }, ORIGIN)) as { status: number }).status, 400);
  });
});
