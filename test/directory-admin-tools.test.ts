// Directory health and the CSV reader — pure rules.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { directoryHealth } from "../src/lib/directory-health";
import { parseCsv, detectDelimiter } from "../src/lib/csv";
import type { FieldLike } from "../src/lib/directory-display";

const field = (key: string, extra: Partial<FieldLike> = {}): FieldLike =>
  ({ key, label: key[0].toUpperCase() + key.slice(1), kind: "text", multi: 0, builtin: 0, group_by: 0, options: [], value_format: "raw", display: "field", show_with: "", highlight: 0, inverse_label: "", show_in_card: 1, ...extra }) as FieldLike;
const person = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name.length + Math.floor(Math.random() * 1000), name, title: "T", department: "D", email: `${name.replace(/\s/g, ".").toLowerCase()}@x.test`, phone: "1", mobile: "", office: "PHX1",
  custom: {}, links: {}, linked_by: {}, pin_order: null, source: "manual", hidden: 0, updated_at: "2026-09-27T10:00:00Z", photo: "x", ...extra,
});

describe("directoryHealth", () => {
  test("finds blanks, strays, duplicate names, unresolved tokens, stale rows, missing photos and hidden rows", () => {
    const fields = [field("office", { builtin: 1, options: [{ value: "PHX1" }, { value: "TUC" }] }), field("title", { builtin: 1 }), field("practice", { options: [{ value: "Litigation" }], multi: 1 })];
    const people = [
      person("Amy Ortiz", { custom: { practice: "Litigation, Corporate" } }),
      person("Bob No Office", { office: "", phone: "", mobile: "555" }),
      person("Cal Stray", { office: "Flagstaff", photo: "" }),
      person("Dana Ruiz"),
      person("Dana Ruiz", { title: "" }),
      person("Eve Hidden", { hidden: 1 }),
      person("Fay Stale", { source: "graph", updated_at: "2026-09-01T00:00:00Z" }),
      person("Gus Fresh", { source: "graph", updated_at: "2026-09-27T09:00:00Z" }),
    ];
    const findings = directoryHealth({
      people: people as any,
      fields,
      reports: { graph: { at: "x", adopted: 0, records: 2, unresolved: [{ field: "assistant", count: 3, samples: ["Kim Twin"] }] }, google: null },
      lastSync: { graph: "2026-09-27T09:00:00Z" },
    });
    const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
    assert.equal(byId["missing-office"].count, 1);
    assert.deepEqual(byId["missing-office"].samples, ["Bob No Office"]);
    assert.equal(byId["missing-title"].count, 1);
    assert.equal(byId["missing-phone"], undefined, "a mobile counts as a phone");
    assert.equal(byId["strays-office"].count, 1);
    assert.deepEqual(byId["strays-office"].samples, ["Flagstaff (1)"]);
    assert.deepEqual(byId["strays-practice"].samples, ["Corporate (1)"], "multi values are checked one at a time");
    assert.equal(byId["duplicate-names"].count, 1);
    assert.equal(byId["unresolved-graph"].count, 3);
    assert.equal(byId["stale-graph"].count, 1);
    assert.deepEqual(byId["stale-graph"].samples, ["Fay Stale"]);
    assert.equal(byId["no-photo"].count, 1);
    assert.equal(byId["hidden"].count, 1);
    assert.equal(findings[0].severity, "warn", "warnings first");
    assert.ok(findings.every((f) => f.title && f.detail));
  });

  test("a clean directory has no findings", () => {
    const findings = directoryHealth({ people: [person("Amy Ortiz"), person("Bob Lee")] as any, fields: [field("office", { builtin: 1 })], reports: { graph: null, google: null }, lastSync: {} });
    assert.deepEqual(findings, []);
  });
});

describe("parseCsv", () => {
  test("delimiters, quotes, doubled quotes, embedded newlines, BOM, blank lines", () => {
    assert.equal(detectDelimiter("a;b;c"), ";");
    assert.equal(detectDelimiter("a\tb"), "\t");
    assert.equal(detectDelimiter("plain"), ",");
    const parsed = parseCsv('﻿Name,Email,"Notes"\r\n"Smith, Jane",jane@x.test,"Says ""hi""\nsecond line"\r\n\r\nBob,bob@x.test,\r\n');
    assert.deepEqual(parsed.header, ["Name", "Email", "Notes"]);
    assert.deepEqual(parsed.rows, [
      ["Smith, Jane", "jane@x.test", 'Says "hi"\nsecond line'],
      ["Bob", "bob@x.test", ""],
    ]);
    assert.equal(parsed.delimiter, ",");
    const semi = parseCsv("a;b\n1;2\n");
    assert.deepEqual(semi.rows, [["1", "2"]]);
    assert.deepEqual(parseCsv("").rows, []);
  });
});

describe("directoryHealth: org chart", () => {
  test("a reporting loop is a finding that names the loop; a clean tree is not", () => {
    const fields = [field("manager", { kind: "people", label: "Reports to", inverse_label: "Direct reports" })];
    const a = person("Ann Loop", { id: 1, links: { manager: [{ id: 2, name: "Bo Loop" }] } });
    const b = person("Bo Loop", { id: 2, links: { manager: [{ id: 1, name: "Ann Loop" }] } });
    const c = person("Cy Clean", { id: 3, links: { manager: [{ id: 1, name: "Ann Loop" }] } });
    const loop = directoryHealth({ people: [a, b, c] as any, fields, reports: { graph: null, google: null }, lastSync: {} }).find((f) => f.id === "org-cycles");
    assert.ok(loop);
    assert.equal(loop!.count, 1);
    assert.deepEqual(loop!.samples, ["Ann Loop → Bo Loop → Ann Loop"]);
    const clean = directoryHealth({ people: [a, c] as any, fields, reports: { graph: null, google: null }, lastSync: {} }).find((f) => f.id === "org-cycles");
    assert.equal(clean, undefined);
  });
});

// --- Scheduled syncs: when a provider is due, and the report ---------------

import { isSyncDue, parseRecipients, syncReportEmail } from "../src/lib/directory-schedule-rules";

describe("scheduled sync rules", () => {
  test("hourly runs once an hour, daily once a day at or after the hour, off never", () => {
    const at = (s: string) => new Date(s);
    assert.equal(isSyncDue("off", 3, undefined, at("2026-09-27T03:00:00Z")), false);
    assert.equal(isSyncDue("hourly", 3, undefined, at("2026-09-27T03:00:00Z")), true, "never run → due");
    assert.equal(isSyncDue("hourly", 3, "2026-09-27T02:10:00Z", at("2026-09-27T03:00:00Z")), false, "50 minutes ago is the same tick");
    assert.equal(isSyncDue("hourly", 3, "2026-09-27T02:00:00Z", at("2026-09-27T03:00:00Z")), true);
    assert.equal(isSyncDue("daily", 3, undefined, at("2026-09-27T02:59:00Z")), false, "before the hour");
    assert.equal(isSyncDue("daily", 3, undefined, at("2026-09-27T03:00:00Z")), true);
    assert.equal(isSyncDue("daily", 3, "2026-09-27T03:05:00Z", at("2026-09-27T09:00:00Z")), false, "already ran today");
    assert.equal(isSyncDue("daily", 3, "2026-09-26T03:05:00Z", at("2026-09-27T03:00:00Z")), true, "ran yesterday");
    assert.equal(isSyncDue("daily", 3, "2026-09-26T23:30:00Z", at("2026-09-27T04:00:00Z")), true, "a late catch-up yesterday is still yesterday");
  });

  test("recipients are split on commas, semicolons and whitespace, lowercased, deduplicated, validated", () => {
    assert.deepEqual(parseRecipients("IT@firm.com, it@firm.com; ops@firm.com nope not-an-email"), ["it@firm.com", "ops@firm.com"]);
    assert.deepEqual(parseRecipients(""), []);
  });

  test("the report says what changed, holds the brake up front, and links the Sync page", () => {
    const mail = syncReportEmail({
      provider: "microsoft",
      ok: true,
      origin: "https://docs.firm.com",
      at: new Date("2026-09-27T03:00:00Z"),
      summary: {
        count: 115,
        deleted: 0,
        blocked: { doomed: 70, total: 110 },
        preview: { adds: [{ name: "Ana New", email: "ana@f.com" }], changes: [{ name: "Bo Moved", email: "bo@f.com", changed: ["office", "title"] }], removals: [{ name: "Cy Gone", email: "cy@f.com" }], adoptions: [], unchanged: 113 },
      },
      unresolved: [{ field: "assistant", count: 2, samples: ["Kim Twin"] }],
    });
    assert.equal(mail.subject, "Directory sync (Microsoft 365): 115 people, +1 / ~1 / −0 — removals held");
    assert.match(mail.text, /Added: 1 — Ana New/);
    assert.match(mail.text, /Changed: 1 — Bo Moved \(office, title\)/);
    assert.match(mail.text, /Removed: 0 \(1 no longer returned but kept\) — Cy Gone/);
    assert.match(mail.text, /Removal brake: 70 of 110/);
    assert.match(mail.text, /assistant: 2 — e\.g\. Kim Twin/);
    assert.match(mail.text, /Sync page: https:\/\/docs\.firm\.com\/admin\/directory\/sync/);
    assert.match(mail.html, /<a href="https:\/\/docs\.firm\.com\/admin\/directory\/sync"/);

    const failed = syncReportEmail({ provider: "google", ok: false, error: "invalid_grant", origin: "", at: new Date("2026-09-27T03:00:00Z") });
    assert.equal(failed.subject, "Directory sync (Google Workspace) failed");
    assert.match(failed.text, /Error: invalid_grant/);
    assert.doesNotMatch(failed.text, /Sync page/);
  });
});
