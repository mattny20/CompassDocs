// What Settings → Single sign-on → Duo shows (1.20.5): the saved settings
// without the secret, plus the facts the form's guards need. Shared by the
// page (app/(app)/admin/sso) and the route (api/admin/duo). Server-only.

import "server-only";
import { getAllSettings } from "./db";
import { duoDisabledByEnv, duoPolicyFromSettings, duoTestApiBase, duoVerifiedBy } from "./duo-config";
import { duoConfigured, duoSettingsFrom } from "./duo-policy";
import { eePresent, featureEnabled } from "./ee";
import { normalizeDomain } from "./settings";

export async function duoView(userId: number, sid: string) {
  const [map, licensed] = await Promise.all([getAllSettings(), featureEnabled("sso")]);
  const cfg = duoSettingsFrom(map);
  const domain = normalizeDomain(map.custom_domain || "");
  return {
    enabled: licensed, // bundled AND licensed
    bundled: eePresent(),
    client_id: cfg.clientId,
    /** The secret is write-only: only whether one is stored. */
    has_secret: Boolean(cfg.clientSecret),
    api_host: cfg.apiHost,
    username_source: cfg.usernameSource,
    enforce_signin: cfg.enforceSignIn,
    enforce_desk: cfg.enforceDesk,
    desk_hours: cfg.deskHours,
    bypass_user_ids: cfg.bypassUserIds,
    fail_open: cfg.failOpen,
    configured: duoConfigured(cfg),
    /** This admin, in this session, has passed "Test with my account" against what is saved. */
    tested: duoVerifiedBy(cfg, sid, userId),
    /**
     * The one address Duo sends people back to (lib/duo-config
     * duoReturnOrigin): the custom domain, else where the test was run.
     * Empty until a test has passed.
     */
    return_origin: domain ? `https://${domain}` : cfg.rev && cfg.verified?.rev === cfg.rev ? cfg.verified.origin : "",
    /** A rule is on and really being enforced right now. */
    enforcing: duoPolicyFromSettings(map) !== null,
    disabled_by_env: duoDisabledByEnv(),
    /** Only on a test rig (lib/duo-config duoTestApiBase); null everywhere else. */
    test_api_base: duoTestApiBase(),
  };
}

export type DuoView = Awaited<ReturnType<typeof duoView>>;
