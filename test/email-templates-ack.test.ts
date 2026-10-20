// The four read-confirmation templates of 1.13.0 (ack_welcome from D1;
// ack_due, ack_due_bundle and ack_escalation from E2) render their sample
// values with no tag left showing and with every documented tag consumed
// (the bundle's invariant 10), the samples name no tag the template does not
// document, and the welcome's subject counts the policies. ack_request has
// the same check in test/ack-due.test.ts.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/email-templates-ack.test.ts

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { getSetting } from "../src/lib/db";
import { SAMPLE_VARS, renderEmail, templateDef } from "../src/lib/email-templates";

const ORIGIN = "https://docs.example.test";
const KEYS = ["ack_welcome", "ack_due", "ack_due_bundle", "ack_escalation"] as const;

before(async () => {
  // renderEmail reads the template overrides and the workspace name.
  await getSetting("__schema_bootstrap__");
});

describe("the read-confirmation templates (D1, E2)", () => {
  for (const key of KEYS) {
    test(`${key}: every tag the template uses is documented, every documented tag is in the sample, and the sample renders with none left showing`, async () => {
      const def = templateDef(key);
      assert.ok(def, `${key} is a template`);
      const vars = SAMPLE_VARS[key];
      assert.ok(vars, `${key} has sample values`);
      const source = `${def!.subject}\n${def!.body}`;
      // Every documented tag is offered to the admin's override and has a
      // sample value (a documented tag the default body does not use, like
      // ack_due's due_date or ack_request's days_left, is the house pattern).
      for (const { tag } of def!.tags) {
        // org_name is filled in by renderEmail from the workspace settings.
        if (tag !== "org_name") assert.ok(tag in vars, `${key}: the sample carries ${tag}`);
      }
      // Nothing the template uses is undocumented, and the sample names no stray key.
      for (const used of source.match(/\{\{(\w+)\}\}/g) ?? []) {
        const name = used.slice(2, -2);
        assert.ok(def!.tags.some((t) => t.tag === name), `${key}: the template's {{${name}}} is a documented tag`);
      }
      for (const name of Object.keys(vars)) {
        assert.ok(def!.tags.some((t) => t.tag === name), `${key}: the sample's ${name} is a documented tag`);
      }
      const { subject, text, html } = await renderEmail(key, vars, ORIGIN);
      assert.doesNotMatch(subject + text + html, /\{\{/, `${key}: no tag is left showing`);
      assert.doesNotMatch(subject + text, /—|acknowledg|attest/i, `${key}: glossary`);
      assert.ok(subject.length > 0 && text.length > 0 && html.length > 0, `${key}: the three parts render`);
    });
  }

  test("ack_welcome's subject counts the policies", async () => {
    const { subject, text } = await renderEmail("ack_welcome", SAMPLE_VARS.ack_welcome, ORIGIN);
    assert.ok(subject.endsWith(`Welcome: ${SAMPLE_VARS.ack_welcome.count} policies to read`), subject);
    assert.ok(text.includes(`${ORIGIN}${SAMPLE_VARS.ack_welcome.portal_url}`) || text.includes(SAMPLE_VARS.ack_welcome.portal_url), "the link lands on My policies");
  });
});
