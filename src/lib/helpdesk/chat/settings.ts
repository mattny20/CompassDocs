// Helpdesk 1.19.4: chat app settings (Desk settings → Chat apps). One
// settings row, "helpdesk_chat":
//
//   teams    app_id, secret (sealed), tenant_id, abilities, who connected it
//   slack    bot_token (sealed), signing_secret (sealed), team_id/team_name
//            (from Test, or pinned by the first verified event), abilities
//   channels the channels that open tickets
//
// Secrets are sealed with lib/secretbox (the Snipe-IT key's way): never
// returned (the view says only that one is saved), never logged, never in
// audit details. A saved secret is kept when the form leaves it empty;
// a new app ID, tenant or Slack workspace starts the app's links afresh
// (people, threads and cards of the old one are forgotten). Saving never
// calls Microsoft or Slack; Test does (lib/helpdesk/chat/test). Server-only.

import "server-only";
import { randomBytes } from "node:crypto";
import { getSetting, setSetting } from "../../db";
import { openSecret, sealSecret } from "../../secretbox";
import { hq } from "../db-core";
import {
  CHAT_LIMITS,
  HD_CHAT_ABILITIES,
  HD_CHAT_ABILITY_DEFAULTS,
  REACTION_RE,
  cleanReaction,
  isChatApp,
  type HdChatAbilities,
  type HdChatApp,
  type HdChatAppView,
  type HdChatChannel,
  type HdChatSettingsView,
} from "../chat-shared";

export const CHAT_SETTINGS_KEY = "helpdesk_chat";

export class ChatSettingsError extends Error {
  status = 400;
}

interface Stamp {
  connected_at: string | null;
  connected_by: string;
  last_test: { at: string; ok: boolean; message: string } | null;
}

export interface TeamsSettings extends Stamp {
  app_id: string;
  secret: string;
  tenant_id: string;
  abilities: HdChatAbilities;
}

export interface SlackSettings extends Stamp {
  bot_token: string;
  signing_secret: string;
  team_id: string;
  team_name: string;
  bot_user_id: string;
  abilities: HdChatAbilities;
}

export interface ChatSettings {
  teams: TeamsSettings;
  slack: SlackSettings;
  channels: HdChatChannel[];
}

const stamp = (): Stamp => ({ connected_at: null, connected_by: "", last_test: null });
const defaults = (): ChatSettings => ({
  teams: { app_id: "", secret: "", tenant_id: "", abilities: { ...HD_CHAT_ABILITY_DEFAULTS }, ...stamp() },
  slack: { bot_token: "", signing_secret: "", team_id: "", team_name: "", bot_user_id: "", abilities: { ...HD_CHAT_ABILITY_DEFAULTS }, ...stamp() },
  channels: [],
});

let testSettings: ChatSettings | null = null;
/** Tests: read (and write) these settings instead of the stored row (null restores). */
export function setChatSettingsForTests(s: ChatSettings | null): void {
  testSettings = s;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const open = (v: unknown): string => {
  if (typeof v !== "string" || !v) return "";
  try {
    return openSecret(v);
  } catch {
    return "";
  }
};

function abilitiesOf(v: unknown): HdChatAbilities {
  const o = obj(v);
  const out = { ...HD_CHAT_ABILITY_DEFAULTS };
  for (const k of HD_CHAT_ABILITIES) if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  return out;
}

function stampOf(v: Obj): Stamp {
  const t = obj(v.last_test);
  return {
    connected_at: typeof v.connected_at === "string" ? v.connected_at : null,
    connected_by: str(v.connected_by, 200),
    last_test: typeof t.at === "string" ? { at: t.at, ok: t.ok === true, message: str(t.message, 300) } : null,
  };
}

function channelOf(v: unknown): HdChatChannel | null {
  const o = obj(v);
  if (!isChatApp(o.app)) return null;
  const team = Number(o.team_id);
  const channel = str(o.channel_id, 200);
  if (!channel || !Number.isInteger(team) || team <= 0) return null;
  const trigger = o.trigger === "reaction" ? "reaction" : "mention";
  return {
    id: str(o.id, 40) || randomBytes(6).toString("hex"),
    app: o.app,
    channel_id: channel,
    name: str(o.name, CHAT_LIMITS.channelName) || channel,
    team_id: team,
    trigger,
    reaction: trigger === "reaction" ? cleanReaction(o.reaction) : "",
  };
}

export function parseChatSettings(raw: string | undefined): ChatSettings {
  let v: Obj = {};
  try {
    v = raw ? obj(JSON.parse(raw)) : {};
  } catch {
    v = {};
  }
  const t = obj(v.teams);
  const s = obj(v.slack);
  return {
    teams: { app_id: str(t.app_id, CHAT_LIMITS.appId), secret: open(t.secret), tenant_id: str(t.tenant_id, 100), abilities: abilitiesOf(t.abilities), ...stampOf(t) },
    slack: {
      bot_token: open(s.bot_token),
      signing_secret: open(s.signing_secret),
      team_id: str(s.team_id, 40),
      team_name: str(s.team_name, 200),
      bot_user_id: str(s.bot_user_id, 40),
      abilities: abilitiesOf(s.abilities),
      ...stampOf(s),
    },
    channels: (Array.isArray(v.channels) ? v.channels : []).map(channelOf).filter((c): c is HdChatChannel => !!c).slice(0, CHAT_LIMITS.channels),
  };
}

/** The settings with the secrets opened (server use only; never send this to a browser). */
export async function getChatSettings(): Promise<ChatSettings> {
  if (testSettings) return structuredClone(testSettings);
  return parseChatSettings(await getSetting(CHAT_SETTINGS_KEY));
}

function serialise(s: ChatSettings): string {
  const seal = (x: string) => (x ? sealSecret(x) : "");
  return JSON.stringify({
    teams: { ...s.teams, secret: seal(s.teams.secret) },
    slack: { ...s.slack, bot_token: seal(s.slack.bot_token), signing_secret: seal(s.slack.signing_secret) },
    channels: s.channels,
  });
}

export async function storeChatSettings(s: ChatSettings): Promise<void> {
  if (testSettings) {
    testSettings = structuredClone(s);
    return;
  }
  await setSetting(CHAT_SETTINGS_KEY, serialise(s));
}

/** Is the app set up (its credentials saved)? Disconnected = nothing is sent or read. */
export function appConnected(s: ChatSettings, app: HdChatApp): boolean {
  return app === "teams" ? !!(s.teams.app_id && s.teams.secret && GUID_RE.test(s.teams.tenant_id)) : !!(s.slack.bot_token && s.slack.signing_secret);
}

// --- Validation --------------------------------------------------------------------

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A tenant is its GUID or a verified domain (contoso.onmicrosoft.com). */
/**
 * The tenant is its GUID, nothing else: every activity's tenant is compared with it, and a
 * domain (contoso.onmicrosoft.com) can't be compared with what Teams sends.
 */
const TENANT_RE = GUID_RE;

export const validTenant = (t: string) => TENANT_RE.test(t);

function secretField(v: unknown, label: string, shape?: RegExp): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ChatSettingsError(`${label} is text.`);
  const t = v.trim();
  if (!t || t.length > CHAT_LIMITS.secret || /\s/.test(t)) throw new ChatSettingsError(`Paste the ${label.toLowerCase()} again: it looks incomplete.`);
  if (shape && !shape.test(t)) throw new ChatSettingsError(`That doesn't look like a ${label.toLowerCase()}.`);
  return t;
}

export interface ChatSettingsPatch {
  teams?: { app_id?: unknown; secret?: unknown; tenant_id?: unknown; abilities?: unknown; disconnect?: unknown };
  slack?: { bot_token?: unknown; signing_secret?: unknown; abilities?: unknown; disconnect?: unknown };
  channels?: unknown;
}

export interface ChatSaveResult {
  changed: string[];
  /** Apps whose earlier links were forgotten (new app ID, tenant or workspace, or a disconnect). */
  reset: HdChatApp[];
}

/**
 * Validate and save. Returns the names of what changed (for the audit;
 * secrets as "teams.secret" etc., never their values).
 */
export async function saveChatSettings(raw: Obj, actorName: string, validTeamIds: Set<number>): Promise<ChatSaveResult> {
  const cur = await getChatSettings();
  const next: ChatSettings = structuredClone(cur);
  const changed: string[] = [];
  const reset: HdChatApp[] = [];
  const now = new Date().toISOString();

  const t = raw.teams === undefined ? null : obj(raw.teams);
  if (t) {
    if (t.disconnect === true) {
      if (appConnected(cur, "teams") || cur.teams.app_id) {
        changed.push("teams.disconnected");
        reset.push("teams");
      }
      next.teams = { ...defaults().teams, abilities: cur.teams.abilities };
    } else {
      if (t.app_id !== undefined) {
        const id = str(t.app_id, CHAT_LIMITS.appId + 1);
        if (id && !GUID_RE.test(id)) throw new ChatSettingsError("The app ID is the Microsoft App ID of your Azure Bot: a GUID like 00000000-0000-0000-0000-000000000000.");
        if (id !== cur.teams.app_id) {
          changed.push("teams.app_id");
          next.teams.app_id = id;
          // A secret is only ever used with the app it was saved for.
          if (cur.teams.secret && (t.secret === undefined || t.secret === "")) {
            if (id) throw new ChatSettingsError("Paste the client secret again: a saved secret is only used with the app ID it was saved for.");
            next.teams.secret = "";
          }
        }
      }
      if (t.tenant_id !== undefined) {
        const ten = str(t.tenant_id, 120);
        if (ten && !validTenant(ten)) throw new ChatSettingsError("Enter the tenant ID, a GUID like 00000000-0000-0000-0000-000000000000 (Microsoft Entra admin center, Overview), not a domain.");
        if (ten !== cur.teams.tenant_id) {
          changed.push("teams.tenant_id");
          next.teams.tenant_id = ten;
        }
      }
      const sec = secretField(t.secret, "Client secret");
      if (sec !== undefined && sec !== cur.teams.secret) {
        changed.push("teams.secret");
        next.teams.secret = sec;
      }
      if (t.abilities !== undefined) diffAbilities("teams", cur.teams.abilities, t.abilities, next.teams.abilities, changed);
      if ((next.teams.secret || next.teams.tenant_id) && !next.teams.app_id) throw new ChatSettingsError("Enter the app ID the secret belongs to.");
      if (next.teams.app_id !== cur.teams.app_id || next.teams.tenant_id !== cur.teams.tenant_id) {
        if (cur.teams.app_id) reset.push("teams");
      }
      if (appConnected(next, "teams") && (!appConnected(cur, "teams") || reset.includes("teams") || next.teams.secret !== cur.teams.secret)) {
        next.teams.connected_at = now;
        next.teams.connected_by = actorName;
        next.teams.last_test = null;
      }
    }
  }

  const s = raw.slack === undefined ? null : obj(raw.slack);
  if (s) {
    if (s.disconnect === true) {
      if (appConnected(cur, "slack") || cur.slack.team_id) {
        changed.push("slack.disconnected");
        reset.push("slack");
      }
      next.slack = { ...defaults().slack, abilities: cur.slack.abilities };
    } else {
      const tok = secretField(s.bot_token, "Bot token", /^xoxb-[A-Za-z0-9-]+$/);
      if (tok !== undefined && tok !== cur.slack.bot_token) {
        changed.push("slack.bot_token");
        next.slack.bot_token = tok;
      }
      const sig = secretField(s.signing_secret, "Signing secret", /^[0-9a-f]{16,128}$/i);
      if (sig !== undefined && sig !== cur.slack.signing_secret) {
        changed.push("slack.signing_secret");
        next.slack.signing_secret = sig;
      }
      if (s.abilities !== undefined) diffAbilities("slack", cur.slack.abilities, s.abilities, next.slack.abilities, changed);
      if (tok !== undefined && tok !== cur.slack.bot_token && cur.slack.bot_token) {
        // A new token may be another workspace's: the workspace is learnt again (Test, or the first event).
        next.slack.team_id = "";
        next.slack.team_name = "";
        next.slack.bot_user_id = "";
        reset.push("slack");
      }
      if (appConnected(next, "slack") && (!appConnected(cur, "slack") || tok !== undefined || sig !== undefined)) {
        next.slack.connected_at = now;
        next.slack.connected_by = actorName;
        next.slack.last_test = null;
      }
    }
  }

  if (raw.channels !== undefined) {
    if (!Array.isArray(raw.channels)) throw new ChatSettingsError("Channels are a list.");
    if (raw.channels.length > CHAT_LIMITS.channels) throw new ChatSettingsError(`Up to ${CHAT_LIMITS.channels} channels.`);
    const list: HdChatChannel[] = [];
    const seen = new Set<string>();
    for (const c of raw.channels) {
      const o = obj(c);
      const ch = channelOf(o);
      if (!ch) throw new ChatSettingsError("Each channel needs an app, a channel ID and a team.");
      if (ch.app === "slack" && !/^[CG][A-Z0-9]{2,30}$/.test(ch.channel_id)) throw new ChatSettingsError(`"${ch.name}": a Slack channel ID starts with C (open its details: the ID is at the bottom).`);
      if (ch.app === "teams" && !/^19:[^\s;]{3,180}$/.test(ch.channel_id)) throw new ChatSettingsError(`"${ch.name}": a Teams channel ID starts with 19: (Get link to channel: it's the part after /channel/).`);
      if (!validTeamIds.has(ch.team_id)) throw new ChatSettingsError(`"${ch.name}": choose one of the desk's teams.`);
      if (ch.trigger === "reaction") {
        if (ch.app === "teams") throw new ChatSettingsError(`"${ch.name}": in Teams, channel tickets open from a mention (Teams doesn't give apps the message someone reacted to).`);
        if (!REACTION_RE.test(ch.reaction)) throw new ChatSettingsError(`"${ch.name}": name the reaction, like ticket or sos.`);
      }
      const key = `${ch.app}:${ch.channel_id}`;
      if (seen.has(key)) throw new ChatSettingsError(`"${ch.name}" is listed twice.`);
      seen.add(key);
      list.push(ch);
    }
    if (JSON.stringify(list) !== JSON.stringify(cur.channels)) changed.push("channels");
    next.channels = list;
  }

  if (changed.length) await storeChatSettings(next);
  if (reset.length) await forgetApp(reset);
  return { changed, reset };
}

function diffAbilities(app: HdChatApp, cur: HdChatAbilities, raw: unknown, into: HdChatAbilities, changed: string[]): void {
  const o = obj(raw);
  for (const k of HD_CHAT_ABILITIES) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") throw new ChatSettingsError("Each of What people can do is on or off.");
    if (o[k] !== cur[k]) changed.push(`${app}.${k}`);
    into[k] = o[k] as boolean;
  }
}

/** Forget an app's people links, threads and waiting cards (a disconnect, or another app/workspace). */
export async function forgetApp(apps: HdChatApp[]): Promise<void> {
  if (!apps.length) return;
  await hq("DELETE FROM hd_chat_people WHERE app = ANY($1::text[])", [apps]);
  await hq("DELETE FROM hd_chat_threads WHERE app = ANY($1::text[])", [apps]);
  await hq("DELETE FROM hd_chat_drafts WHERE app = ANY($1::text[])", [apps]);
}

/** Record a Test result (or the workspace Slack named) without touching anything else. */
export async function recordChatTest(app: HdChatApp, result: { ok: boolean; message: string }, slackTeam?: { id: string; name: string; bot_user_id: string }): Promise<void> {
  const at = new Date().toISOString();
  const test = { at, ok: result.ok, message: result.message.slice(0, 300) };
  if (!testSettings) {
    // Only these fields, in one statement: a Test never writes back a stale copy over an admin's save.
    const cur = await getChatSettings();
    if (app === "slack" && slackTeam && cur.slack.team_id && cur.slack.team_id !== slackTeam.id) await forgetApp(["slack"]);
    const patch: Record<string, unknown> = app === "teams" ? { last_test: test } : { last_test: test, ...(slackTeam ? { team_id: slackTeam.id, team_name: slackTeam.name, bot_user_id: slackTeam.bot_user_id } : {}) };
    await hq(`UPDATE settings SET value = jsonb_set(value::jsonb, ARRAY[$2::text], (value::jsonb -> $2) || $3::jsonb)::text WHERE key = $1 AND value::jsonb ? $2`, [CHAT_SETTINGS_KEY, app, JSON.stringify(patch)]);
    return;
  }
  const s = await getChatSettings();
  if (app === "teams") s.teams.last_test = { at, ok: result.ok, message: result.message.slice(0, 300) };
  else {
    s.slack.last_test = { at, ok: result.ok, message: result.message.slice(0, 300) };
    if (slackTeam) {
      if (s.slack.team_id && s.slack.team_id !== slackTeam.id) await forgetApp(["slack"]);
      s.slack.team_id = slackTeam.id;
      s.slack.team_name = slackTeam.name;
      s.slack.bot_user_id = slackTeam.bot_user_id;
    }
  }
  await storeChatSettings(s);
}

/** The first verified event names the Slack workspace when no Test has (it was signed with our secret). */
export async function pinSlackTeam(teamId: string): Promise<void> {
  if (!/^[TE][A-Z0-9]{2,30}$/.test(teamId)) return;
  if (testSettings) {
    if (!testSettings.slack.team_id) testSettings.slack.team_id = teamId;
    return;
  }
  // One atomic update of that field, only while it is still empty and Slack is still set up: it can
  // never write back an older copy of the settings over an admin's save or disconnect.
  await hq(
    `UPDATE settings SET value = jsonb_set(value::jsonb, '{slack,team_id}', to_jsonb($2::text))::text
      WHERE key = $1 AND coalesce(value::jsonb #>> '{slack,team_id}', '') = '' AND coalesce(value::jsonb #>> '{slack,bot_token}', '') <> ''`,
    [CHAT_SETTINGS_KEY, teamId]
  );
}

function appView(app: HdChatApp, s: ChatSettings): HdChatAppView {
  const a = app === "teams" ? s.teams : s.slack;
  return {
    connected: appConnected(s, app),
    app_id: app === "teams" ? s.teams.app_id : "",
    tenant_id: app === "teams" ? s.teams.tenant_id : "",
    team_id: app === "slack" ? s.slack.team_id : "",
    team_name: app === "slack" ? s.slack.team_name : "",
    secret_set: app === "teams" ? !!s.teams.secret : !!s.slack.bot_token,
    signing_secret_set: app === "slack" && !!s.slack.signing_secret,
    connected_at: a.connected_at,
    connected_by: a.connected_by,
    abilities: { ...a.abilities },
    last_test: a.last_test,
  };
}

/** Desk settings → Chat apps, as the browser sees it (no secret in it). */
export async function chatSettingsView(origin: string): Promise<HdChatSettingsView> {
  const s = await getChatSettings();
  const teams = await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, name, id");
  return { teams: appView("teams", s), slack: appView("slack", s), channels: s.channels, origin, teams_list: teams };
}
