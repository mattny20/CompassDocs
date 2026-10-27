// "How people sign in" (1.16.0, Settings → Workspace → Sign-in page): the
// sentences the admin reads come from the same setup the sign-in page uses.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/sign-in-routing-summary.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupFrom } from "../src/lib/sign-in-routing";
import { summarizeRouting } from "../src/lib/sign-in-routing-summary";
import type { SsoConfig } from "../src/lib/sso-config";
import type { SamlConfig } from "../src/lib/saml-config";

const SSO: SsoConfig = {
  enabled: true,
  tenant: "11111111-2222-3333-4444-555555555555",
  clientId: "client",
  clientSecret: "secret",
  authority: "",
  autoProvision: true,
  defaultRole: "viewer",
  allowedDomains: [],
  ssoOnly: false,
  vendor: "microsoft",
};
const SAML: SamlConfig = {
  enabled: false,
  idpSsoUrl: "https://idp.example.test/sso",
  idpIssuer: "https://idp.example.test",
  idpCert: "MIIBdummy",
  autoProvision: true,
  defaultRole: "viewer",
  allowedDomains: [],
  buttonLabel: "Sign in with Okta",
};
const ORIGIN = "https://docs.acme.test";
const sum = (sso: Partial<SsoConfig> | null, saml: Partial<SamlConfig> | null, oidcStuck = false) =>
  summarizeRouting(setupFrom({ ...SSO, enabled: Boolean(sso), ...(sso ?? {}) }, { ...SAML, enabled: Boolean(saml), ...(saml ?? {}) }), { oidcStuck, origin: ORIGIN });

describe("How people sign in", () => {
  test("no provider: everyone uses a password", () => {
    const s = sum(null, null);
    assert.deepEqual(s.sentences, ["Everyone signs in with their email or username and a password."]);
    assert.deepEqual(s.warnings, []);
    assert.equal(s.localUrl, null);
  });

  test("configured but unusable OIDC says so", () => {
    const s = sum(null, null, true);
    assert.ok(s.warnings.includes("unusable"));
  });

  test("domains are named; a workspace with SSO but no domains is warned", () => {
    const withDomains = sum({ allowedDomains: ["acme.com", "acme.co.uk"] }, null);
    assert.match(withDomains.sentences.join(" "), /acme\.com and acme\.co\.uk/);
    assert.match(withDomains.sentences.join(" "), /Microsoft/);
    assert.ok(!withDomains.warnings.includes("no_domains"));
    assert.ok(sum({}, null).warnings.includes("no_domains"));
  });

  test("one provider: its domains, then its accounts, then everyone else", () => {
    assert.deepEqual(sum({ allowedDomains: ["acme.com"] }, null).sentences, [
      "People enter their email or username first.",
      "Emails at acme.com go straight to Microsoft.",
      "Accounts that already sign in with single sign-on go straight to Microsoft.",
      "Everyone else is asked for a password.",
    ]);
  });

  test("a domain both providers list is a choice, not two straight routes", () => {
    const both = sum({ allowedDomains: ["acme.com"] }, { allowedDomains: ["acme.com"] });
    assert.equal(both.sentences[1], "Emails at acme.com choose between Microsoft and SAML single sign-on.");
    assert.doesNotMatch(both.sentences.join(" "), /acme\.com go straight to/);

    const partial = sum({ allowedDomains: ["acme.com", "beta.com"] }, { allowedDomains: ["acme.com"] });
    assert.equal(
      partial.sentences[1],
      "Emails at beta.com go straight to Microsoft, and emails at acme.com choose between Microsoft and SAML single sign-on."
    );
  });

  test("with two providers, SSO accounts go to their own, whichever lists domains", () => {
    const mixed = sum({ allowedDomains: ["acme.com"] }, {});
    assert.deepEqual(mixed.sentences, [
      "People enter their email or username first.",
      "Emails at acme.com go straight to Microsoft.",
      "Accounts that already sign in with Microsoft or SAML single sign-on go straight to that provider.",
      "Everyone else is asked for a password.",
    ]);
    assert.ok(!mixed.warnings.includes("no_domains"));
  });

  test("SSO only gives the break-glass address, for anyone with a password", () => {
    const s = sum({ ssoOnly: true }, null);
    assert.equal(s.localUrl, `${ORIGIN}/login?local=1`);
    // SSO only removes no password (docs admin/sso.md), so the sentence names no role.
    assert.deepEqual(s.sentences, [
      "Everyone continues to Microsoft.",
      `Anyone with a password, administrators included, can still sign in at ${ORIGIN}/login?local=1.`,
    ]);
  });
});
