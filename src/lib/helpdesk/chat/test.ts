// Helpdesk 1.19.4: Test on Desk settings → Chat apps. The only place an
// admin's action calls Microsoft or Slack directly:
//
//   Teams  a fresh bot token from login.microsoftonline.com/<tenant> (proves
//          the app ID, secret and tenant) and the Bot Framework's signing
//          keys (proves this server can verify what Teams sends)
//   Slack  auth.test (proves the token; names the workspace, pinned so
//          events from any other workspace are refused) and the token's
//          scopes against the ones the app needs
//
// The result is recorded on the settings (shown under the card) and the
// sentence never holds a secret. Server-only.

import "server-only";
import { HD_CHAT_APP_SHORT, type HdChatApp } from "../chat-shared";
import { ChatHttpError } from "./http";
import { appConnected, getChatSettings, recordChatTest } from "./settings";

export async function testChatApp(app: HdChatApp): Promise<{ ok: boolean; message: string }> {
  const s = await getChatSettings();
  if (!appConnected(s, app)) return { ok: false, message: `Connect ${HD_CHAT_APP_SHORT[app]} first.` };
  let result: { ok: boolean; message: string };
  let team: { id: string; name: string; bot_user_id: string } | undefined;
  try {
    if (app === "teams") {
      const t = await import("./teams");
      await t.botToken(s.teams, { fresh: true });
      if (!(await t.refreshTeamsKeys())) throw new ChatHttpError("Microsoft's signing keys came back empty. Try again shortly.", 0);
      result = { ok: true, message: "Microsoft accepted the app ID and secret, and Teams' signing keys can be read." };
    } else {
      const sl = await import("./slack");
      const r = await sl.slackApi(s.slack.bot_token, "auth.test");
      team = { id: String(r.json.team_id ?? ""), name: String(r.json.team ?? ""), bot_user_id: String(r.json.user_id ?? "") };
      const missing = r.scopes.length ? sl.SLACK_SCOPES.filter((x) => !r.scopes.includes(x)) : [];
      result = missing.length
        ? { ok: false, message: `Connected to ${team.name || "Slack"}, but the app is missing ${missing.join(", ")}. Add the scopes, then reinstall the app.` }
        : { ok: true, message: `Connected to ${team.name || "the Slack workspace"}.` };
    }
  } catch (e) {
    result = { ok: false, message: e instanceof ChatHttpError ? e.message : `Couldn't test ${HD_CHAT_APP_SHORT[app]}.` };
  }
  await recordChatTest(app, result, team);
  return result;
}
