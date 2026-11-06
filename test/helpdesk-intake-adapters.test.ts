// Helpdesk 1.19.0, machine intake (agent P), the pure half: each tool's
// webhook fixture (test/fixtures/helpdesk-intake) becomes the right
// normalised alerts; severities map to priorities; descriptions never keep
// HTML, scripts or javascript: links; automated-mail rules (SPF/DKIM
// verdicts, subject dedup keys, resolution tags); key hashing.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-intake-adapters.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  adaptAzureMonitor,
  adaptDatadog,
  adaptGeneric,
  adaptGrafana,
  adaptPagerDutyLike,
  adaptPayload,
  adaptPrometheus,
  IntakePayloadError,
} from "../src/lib/helpdesk/intake/adapters";
import { cleanFields, cleanLinks, plainLine, safeUrl, sanitizeDescription } from "../src/lib/helpdesk/intake/sanitize";
import { aligned, authVerdict, boundedMatch, cleanSenderAddresses, defaultEmailDedupKey, emailDedupKey, emailStatus, orgDomain, superLinearPattern, validDedupPattern } from "../src/lib/helpdesk/intake/email-rules";
import { automatedChipLabel, normalizeSeverity, serviceIdentityName, HD_DEFAULT_SEVERITY_MAP } from "../src/lib/helpdesk/intake/shared";
import { prepareAlert, priorityFor, requestKeys, openingBody } from "../src/lib/helpdesk/intake/intake";
import { hashKey, keyMatches, newIntegrationKey } from "../src/lib/helpdesk/intake/integrations";

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "fixtures", "helpdesk-intake", name), "utf8"));
const INTEGRATION = { severity_map: HD_DEFAULT_SEVERITY_MAP, default_priority: "normal" as const };

describe("adapters", () => {
  test("Prometheus Alertmanager: one alert per entry, keyed by fingerprint, firing and resolved", () => {
    const alerts = adaptPrometheus(fixture("prometheus.json"));
    assert.equal(alerts.length, 2);
    const [a, b] = alerts;
    assert.equal(a.title, "API error rate above 5% on api-01");
    assert.equal(a.status, "firing");
    assert.equal(a.severity, "critical");
    assert.equal(a.dedup_key, "a1b2c3d4e5f60718");
    assert.equal(a.source, "api-01:9090");
    assert.equal(a.fields.instance, "api-01:9090");
    assert.ok(a.links.some((l) => l.label === "Runbook" && l.url === "https://runbooks.example.test/high-error-rate"));
    assert.ok(a.links.some((l) => l.label === "Source"));
    assert.equal(b.status, "resolved");
    assert.equal(b.title, "HighErrorRate on api-02:9090", "no summary: the alert name and instance");
    assert.equal(b.fields.Ended, "2026-11-06T09:10:00.000Z");
    // The javascript: generator URL is dropped when links are cleaned.
    assert.equal(cleanLinks(b.links).some((l) => l.url.startsWith("javascript")), false);
    assert.equal(priorityFor(INTEGRATION, a.severity), "urgent");
    assert.equal(priorityFor(INTEGRATION, b.severity), "normal");
  });

  test("Grafana unified alerting: per-alert dashboard, panel and silence links and the values", () => {
    const [a] = adaptGrafana(fixture("grafana.json"));
    assert.equal(a.title, "Disk on fs-02 is 91% full");
    assert.equal(a.dedup_key, "9f8e7d6c5b4a3210");
    assert.equal(a.severity, "warning");
    assert.equal(a.source, "fs-02");
    assert.deepEqual(a.links.map((l) => l.label), ["Source", "Dashboard", "Panel", "Silence"]);
    assert.match(a.description, /Values: `\[ var='B'/);
  });

  test("Grafana legacy dashboard alerts: rule id as key, ok = resolved", () => {
    const body = fixture("grafana-legacy.json");
    const [a] = adaptGrafana(body);
    assert.equal(a.title, "Panel Title alert");
    assert.equal(a.dedup_key, "rule-7");
    assert.equal(a.status, "firing");
    assert.equal(a.severity, "critical");
    assert.equal(a.fields["High value"], "100");
    const [ok] = adaptGrafana({ ...body, state: "ok" });
    assert.equal(ok.status, "resolved");
  });

  test("Datadog: transition, aggregation key, priority and tags", () => {
    const [a] = adaptDatadog(fixture("datadog.json"));
    assert.equal(a.title, "CPU high on web-03", "the [Triggered] prefix is dropped");
    assert.equal(a.status, "firing");
    assert.equal(a.dedup_key, "dd-aggreg-77a1");
    assert.equal(a.severity, "high");
    assert.equal(a.fields.tags, "env:prod, service:web, team:platform");
    const [r] = adaptDatadog(fixture("datadog-recovered.json"));
    assert.equal(r.status, "resolved");
    assert.equal(r.dedup_key, a.dedup_key, "recovery carries the same key");
  });

  test("Azure Monitor common alert schema: Sev1, Fired/Resolved, portal link", () => {
    const body = fixture("azure-monitor.json");
    const [a] = adaptAzureMonitor(body);
    assert.equal(a.title, "Storage latency high on stprod01");
    assert.equal(a.status, "firing");
    assert.equal(normalizeSeverity(a.severity), "high");
    assert.match(a.dedup_key, /^3f2d4487/);
    assert.equal(a.description_format, "plain");
    assert.match(a.links[0].url, /^https:\/\/portal\.azure\.com\//);
    body.data.essentials.monitorCondition = "Resolved";
    assert.equal(adaptAzureMonitor(body)[0].status, "resolved");
    assert.throws(() => adaptAzureMonitor({ schemaId: "x" }), IntakePayloadError);
  });

  test("PagerDuty-style events: trigger/resolve, dedup_key, custom details as fields", () => {
    const body = fixture("pagerduty.json");
    const [a] = adaptPagerDutyLike(body);
    assert.equal(a.title, "Nightly backup failed on fs-01");
    assert.equal(a.dedup_key, "backup-nightly-fs-01");
    assert.equal(a.fields.exit_code, "2");
    assert.deepEqual(cleanLinks(a.links), [{ label: "Job log", url: "https://backup.example.test/jobs/991" }]);
    assert.equal(adaptPagerDutyLike({ ...body, event_action: "resolve" })[0].status, "resolved");
    assert.throws(() => adaptPagerDutyLike({ ...body, event_action: "explode" }), IntakePayloadError);
  });

  test("generic shape: title required, status firing|resolved, the rest optional", () => {
    const [a] = adaptGeneric({ title: "Queue backlog", severity: "warning", dedup_key: "q1", links: [{ label: "Queue", url: "https://q.example.test" }], fields: { depth: 1200 } });
    assert.equal(a.status, "firing");
    assert.equal(a.dedup_key, "q1");
    assert.throws(() => adaptGeneric({ description: "no title" }), /title is required/);
    assert.throws(() => adaptGeneric({ title: "x", status: "maybe" }), /status must be/);
    assert.throws(() => adaptGeneric([1, 2]), IntakePayloadError);
    assert.throws(() => adaptPayload("email", {}), IntakePayloadError);
    assert.equal(adaptPayload("api", { title: "x", status: "resolved" })[0].status, "resolved");
  });

  test("too many alerts in one request are refused", () => {
    const alerts = Array.from({ length: 51 }, (_, i) => ({ status: "firing", labels: { alertname: `A${i}` }, annotations: {}, fingerprint: `f${i}` }));
    assert.throws(() => adaptPrometheus({ alerts }), /At most 50/);
  });
});

describe("severities and preparation", () => {
  test("tools' words map to our four severities and on to priorities", () => {
    assert.equal(normalizeSeverity("CRITICAL"), "critical");
    assert.equal(normalizeSeverity("Sev0"), "critical");
    assert.equal(normalizeSeverity("P2"), "high");
    assert.equal(normalizeSeverity("warn"), "warning");
    assert.equal(normalizeSeverity("informational"), "info");
    assert.equal(normalizeSeverity(3), "info");
    assert.equal(normalizeSeverity("banana"), null);
    assert.equal(priorityFor({ severity_map: { warning: "high" }, default_priority: "low" }, "warning"), "high");
    assert.equal(priorityFor({ severity_map: {}, default_priority: "low" }, "warning"), "low", "unmapped: the default priority");
  });

  test("a missing dedup key is derived from title and source, stably", () => {
    const a = prepareAlert(INTEGRATION, { title: "Backup failed", description: "", severity: "", status: "firing", dedup_key: "", source: "fs-01", links: [], fields: {} });
    const b = prepareAlert(INTEGRATION, { title: "backup failed", description: "x", severity: "", status: "firing", dedup_key: "", source: "FS-01", links: [], fields: {} });
    assert.match(a.dedup_key, /^auto:[0-9a-f]{32}$/);
    assert.equal(a.dedup_key, b.dedup_key);
  });

  test("service identity and chip labels", () => {
    assert.equal(serviceIdentityName("Monitoring", "grafana"), "Monitoring (Grafana)");
    assert.equal(serviceIdentityName("Grafana prod", "grafana"), "Grafana prod");
    assert.equal(automatedChipLabel("grafana"), "Automated · Grafana");
    assert.equal(automatedChipLabel(undefined), "Automated");
  });

  test("request keys: a request id wins, else the payload hash this minute and last", () => {
    assert.deepEqual(requestKeys("{}", "abc"), ["id:abc"]);
    const now = 1_700_000_000_000;
    const k = requestKeys('{"a":1}', null, now);
    assert.equal(k.length, 2);
    assert.match(k[0], /^h:[0-9a-f]{64}:\d+$/);
    assert.equal(requestKeys('{"a":1}', null, now + 1000)[0], k[0]);
    assert.notEqual(requestKeys('{"a":2}', null, now)[0], k[0]);
  });
});

describe("sanitising", () => {
  test("HTML never survives as markup; script content is dropped", () => {
    const md = sanitizeDescription('<p>Disk <b>full</b></p><script>alert("x")</script><img src="https://t.example.test/p.gif" onerror="x()">');
    assert.doesNotMatch(md, /<script|<img|<p>|onerror/i);
    assert.match(md, /Disk/);
    assert.doesNotMatch(md, /alert\("x"\)/);
  });

  test("markdown keeps formatting, raw tags are escaped, javascript: and data: links lose their target", () => {
    const md = sanitizeDescription("**Bold** and <span>tag</span>? no: `<code>` [ok](https://ok.example.test) [bad](javascript:alert(1)) ![img](https://t.example.test/x.png) [d](data:text/html,x)\n[ref]: javascript:alert(2)");
    assert.match(md, /\*\*Bold\*\*/);
    assert.match(md, /\[ok\]\(<https:\/\/ok\.example\.test\/>\)/);
    assert.doesNotMatch(md, /javascript:/i);
    assert.doesNotMatch(md, /data:text/i);
    assert.doesNotMatch(md, /!\[/, "images become links");
    assert.match(md, /\[img\]\(<https:\/\/t\.example\.test\/x\.png>\)/);
  });

  test("raw HTML tags inside markdown text are escaped", () => {
    const md = sanitizeDescription("Hello <iframe src=x></iframe> world", "markdown");
    assert.doesNotMatch(md, /<iframe/);
  });

  test("an <a href=javascript:> in HTML is text, not a link", () => {
    const md = sanitizeDescription('<a href="javascript:alert(1)">click</a>');
    assert.doesNotMatch(md, /javascript/i);
    assert.match(md, /click/);
  });

  test("plain text is escaped to render as itself", () => {
    const md = sanitizeDescription("# not a heading\n* not a list [x](javascript:y)", "plain");
    assert.match(md, /^\\#/);
    assert.doesNotMatch(md, /\]\(javascript/);
  });

  test("links: http(s) only, no credentials; fields capped; lines without tags", () => {
    assert.equal(safeUrl("javascript:alert(1)"), null);
    assert.equal(safeUrl("https://user:pw@x.example.test/"), null);
    assert.equal(safeUrl("ftp://x.example.test/"), null);
    assert.equal(safeUrl("https://x.example.test/a b"), "https://x.example.test/a%20b");
    assert.deepEqual(cleanLinks([{ url: "http://a.example.test" }, "https://b.example.test/x", { label: "dup", url: "http://a.example.test" }]).map((l) => l.label), ["a.example.test", "b.example.test"]);
    const f = cleanFields({ a: 1, b: { c: 2 }, d: null, "": "x", e: "y".repeat(5000) });
    assert.deepEqual(Object.keys(f), ["a", "b", "e"]);
    assert.equal(f.b, '{"c":2}');
    assert.ok(f.e.length <= 1000);
    assert.equal(plainLine("<b>Disk</b>\n full", 100), "Disk full");
  });

  test("the opening message lists severity, source and links, escaped", () => {
    const p = prepareAlert(INTEGRATION, { title: "t", description: "d", severity: "critical", status: "firing", dedup_key: "k", source: "web_[01]", links: [{ label: "Run*book", url: "https://r.example.test" }], fields: {} });
    const body = openingBody(p, 1047);
    assert.match(body, /\*\*Severity:\*\* Critical/);
    assert.match(body, /web\\_\\\[01\\\]/);
    assert.match(body, /\*\*Links:\*\* \[Run\\\*book\]\(<https:\/\/r\.example\.test\/>\)/);
    assert.match(body, /fired before as #1047/);
  });
});

describe("automated email rules", () => {
  test("SPF/DKIM: only the provider's own verdict, aligned with the From domain, passes; none at all is \"none\"", () => {
    const from = "alerts@monitor.example.test";
    const v = (input: Parameters<typeof authVerdict>[0]) => authVerdict({ from, ...input });
    assert.deepEqual(v({ headers: {} }), { state: "none", ok: false, reason: "No SPF, DKIM or DMARC verdict from the mail provider", checked: false });
    assert.equal(v({ headers: { "authentication-results": "mx.example; spf=pass smtp.mailfrom=bounce@mail.monitor.example.test; dkim=pass header.d=monitor.example.test" } }).state, "pass");
    assert.equal(v({ headers: { "authentication-results": "mx.example; spf=fail smtp.mailfrom=monitor.example.test; dkim=none" } }).reason, "SPF fail, DKIM none");
    assert.equal(v({ headers: { "received-spf": "SoftFail (domain of x does not designate) envelope-from=a@monitor.example.test;" } }).ok, false);
    assert.equal(v({ headers: { "received-spf": "Pass (sender SPF authorized) identity=mailfrom; envelope-from=a@monitor.example.test;" } }).ok, true);
    assert.equal(v({ headers: { "received-spf": "Pass (sender SPF authorized)" } }).ok, false, "a pass for an unknown envelope sender is not aligned");
    assert.equal(v({ provider: "mailgun", auth: { envelopeFrom: "x@monitor.example.test" }, headers: { "x-mailgun-spf": "Pass", "x-mailgun-dkim-check-result": "Fail" } }).ok, true, "aligned SPF is enough (DMARC)");
    assert.equal(v({ provider: "mailgun", headers: { "x-mailgun-spf": "Fail", "x-mailgun-dkim-check-result": "Pass" } }).ok, false, "Mailgun names no DKIM domain");
    assert.equal(v({ provider: "sendgrid", auth: { spf: "pass", dkim: "{@monitor.example.test : pass}" } }).ok, true);
    assert.equal(v({ provider: "sendgrid", auth: { dkim: "{@monitor.example.test : fail}" } }).ok, false);
    assert.equal(v({ provider: "sendgrid", auth: { spf: "pass", envelopeFrom: "x@evil.example", dkim: "{@evil.example : pass}" } }).state, "fail", "passes for another domain are not aligned");
    assert.equal(v({ headers: { "authentication-results": "mx; dmarc=pass header.from=monitor.example.test" } }).ok, true);
    assert.equal(v({ headers: { "authentication-results": "mx; dmarc=fail header.from=monitor.example.test; dkim=pass header.d=monitor.example.test" } }).ok, false, "a DMARC fail wins");
  });

  test("SPF/DKIM: a verdict the sender wrote into the message never counts (finding #10)", () => {
    const from = "alerts@monitor.example.test";
    // The receiving provider's real verdict is on top; the forged one sits below the provider's Received header.
    const forgedBelow: [string, string][] = [
      ["authentication-results", "mx.provider; spf=fail smtp.mailfrom=monitor.example.test; dkim=none"],
      ["received", "from evil by mx.provider"],
      ["authentication-results", "x; spf=pass smtp.mailfrom=a@monitor.example.test; dkim=pass header.d=monitor.example.test"],
      ["received-spf", "pass envelope-from=a@monitor.example.test"],
    ];
    assert.equal(authVerdict({ from, headerList: forgedBelow }).state, "fail", "the topmost (provider's) verdict decides");
    // The provider added none: the sender's own copy below Received is ignored, so there is no verdict.
    assert.equal(authVerdict({ from, headerList: forgedBelow.slice(1) }).state, "none");
    // Mailgun: its own X-Mailgun-Spf is above its Received; a second copy lower down is the sender's.
    const mg: [string, string][] = [["x-mailgun-spf", "Fail"], ["received", "by mxa.mailgun.org"], ["x-mailgun-spf", "Pass"]];
    assert.equal(authVerdict({ from, provider: "mailgun", auth: { envelopeFrom: "a@monitor.example.test" }, headerList: mg }).ok, false);
    // SendGrid: in-message headers are never read, only its out-of-band fields.
    assert.equal(authVerdict({ from, provider: "sendgrid", headerList: [["authentication-results", "x; dmarc=pass header.from=monitor.example.test"]] }).state, "none");
    // Postmark: Authentication-Results is not one Postmark writes.
    assert.equal(authVerdict({ from, provider: "postmark", headerList: [["authentication-results", "x; dmarc=pass header.from=monitor.example.test"]] }).state, "none");
    assert.equal(authVerdict({ from, provider: "postmark", headerList: [["x-spam-tests", "DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU"]] }).ok, true);
  });

  test("organisational-domain alignment", () => {
    assert.equal(orgDomain("mail.corp.example.co.uk"), "example.co.uk");
    assert.equal(orgDomain("a.b.corp.example"), "corp.example");
    assert.equal(aligned("bounces.corp.example", "corp.example"), true);
    assert.equal(aligned("corp.example.evil.example", "corp.example"), false);
    assert.equal(aligned("evil.co.uk", "corp.co.uk"), false);
  });

  test("subject patterns: super-linear ones are refused and every match has a time budget (finding #22)", () => {
    for (const p of ["(a+)+$", "^(\\w+\\s?)+:", "(.*\\s?)*ID", "(a|aa)+", "(x+){2,}", "(\\d+)\\1"]) {
      assert.equal(superLinearPattern(p), true, p);
      assert.equal(validDedupPattern(p), false, p);
    }
    for (const p of ["UPS (\\w+)", "Job (\\w+) failed", "^\\[(\\w+)\\]", "(foo)+", "(a+)?", "[(+)]+"]) assert.equal(validDedupPattern(p), true, p);
    const started = Date.now();
    // A stored pattern from before this check: refused, the default key is used, at once.
    assert.equal(emailDedupKey(`${"a".repeat(60)}!`, "(a+)+$"), "a".repeat(60));
    // The budget alone: a catastrophic match is stopped and reads as no match.
    assert.equal(boundedMatch("(a+)+$", `${"a".repeat(40)}!`), null);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    assert.deepEqual(boundedMatch("unit (\\d+)", "UPS alarm: unit 7"), ["unit 7", "7"]);
  });

  test("subject dedup key: tags, prefixes and numbers stripped; or the admin's pattern", () => {
    assert.equal(defaultEmailDedupKey("[FIRING:2] Backup job 4412 failed on fs-01"), "backup job failed on fs");
    assert.equal(defaultEmailDedupKey("[RESOLVED] Backup job 4413 failed on fs-01"), "backup job failed on fs");
    assert.equal(defaultEmailDedupKey("Re: [OK] Backup job failed on fs-01"), "backup job failed on fs");
    assert.equal(emailDedupKey("UPS alarm: unit 7 on battery", "unit (\\d+)"), "7");
    assert.equal(emailDedupKey("no match here 12", "unit (\\d+)"), "no match here");
    assert.equal(validDedupPattern("(unclosed"), false);
    assert.equal(emailDedupKey("x 1", "(unclosed"), "x");
  });

  test("resolution tags", () => {
    assert.equal(emailStatus("[RESOLVED] Backup failed"), "resolved");
    assert.equal(emailStatus("[OK] Backup failed"), "resolved");
    assert.equal(emailStatus("Resolved: Backup failed"), "resolved");
    assert.equal(emailStatus("[FIRING:1] Backup failed"), "firing");
    assert.equal(emailStatus("Backup resolved nothing"), "firing");
  });

  test("sender address lists", () => {
    assert.deepEqual(cleanSenderAddresses(" Alerts@Example.test, ups@example.test;alerts@example.test"), ["alerts@example.test", "ups@example.test"]);
    assert.equal(cleanSenderAddresses(["not an address"]), null);
  });
});

describe("keys", () => {
  test("a key is shown once; only its hash matches, in constant time", () => {
    const k = newIntegrationKey();
    assert.match(k.key, /^cdhk_[A-Za-z0-9]{40}$/);
    assert.equal(k.hash, hashKey(k.key));
    assert.equal(k.prefix, k.key.slice(0, 11));
    assert.equal(keyMatches(k.key, k.hash), true);
    assert.equal(keyMatches(`${k.key}x`, k.hash), false);
    assert.equal(keyMatches("", k.hash), false);
    assert.equal(keyMatches(k.key, ""), false);
  });
});
