// Helpdesk 1.19.4: chat apps (Microsoft Teams and Slack), the client-safe
// half: the apps, what people may do in each, channel triggers, limits and
// the settings view the browser gets (never a secret: only whether one is
// saved). The server half is lib/helpdesk/chat.

export const HD_CHAT_APPS = ["teams", "slack"] as const;
export type HdChatApp = (typeof HD_CHAT_APPS)[number];
export const HD_CHAT_APP_LABEL: Record<HdChatApp, string> = { teams: "Microsoft Teams", slack: "Slack" };
export const HD_CHAT_APP_SHORT: Record<HdChatApp, string> = { teams: "Teams", slack: "Slack" };

export function isChatApp(v: unknown): v is HdChatApp {
  return typeof v === "string" && (HD_CHAT_APPS as readonly string[]).includes(v);
}

/** What people can do in an app ("What people can do in Teams"). */
export const HD_CHAT_ABILITIES = ["raise", "follow", "approve", "channel_ticket"] as const;
export type HdChatAbility = (typeof HD_CHAT_ABILITIES)[number];
export type HdChatAbilities = Record<HdChatAbility, boolean>;
export const HD_CHAT_ABILITY_DEFAULTS: HdChatAbilities = { raise: true, follow: true, approve: true, channel_ticket: false };
export const HD_CHAT_ABILITY_TEXT: Record<HdChatAbility, { label: string; help: string }> = {
  raise: { label: "Raise a request", help: "Message the CompassDocs app, or use the Get help message action on any message." },
  follow: { label: "Follow and reply", help: "Replies from the desk arrive in the chat; their answers go back to the ticket." },
  approve: { label: "Approve and decline", help: "Approvers get a card with Approve and Decline. Their own click decides, like the email buttons." },
  channel_ticket: { label: "Turn a channel message into a ticket", help: "Agents only, from the message's menu." },
};

/** How a configured channel opens tickets. */
export type HdChatTrigger = "mention" | "reaction";

export interface HdChatChannel {
  /** Stable id of the row (for the page's list keys). */
  id: string;
  app: HdChatApp;
  /** Slack: the channel ID (C…). Teams: the channel ID (19:…@thread.tacv2). */
  channel_id: string;
  /** The name shown in the table ("it-help"). */
  name: string;
  /** The desk team its tickets go to. */
  team_id: number;
  trigger: HdChatTrigger;
  /** Slack reaction name without colons ("ticket"); "" for a mention. */
  reaction: string;
}

export const CHAT_LIMITS = {
  /** A message turned into a request is cut at this many characters. */
  text: 8_000,
  /** The raw body an endpoint reads (Teams activities, Slack payloads). */
  bodyBytes: 256 * 1024,
  channels: 50,
  channelName: 80,
  appId: 100,
  secret: 512,
  /** Messages one chat account may send the app a minute. */
  perUserPerMinute: 20,
  /** A "Raise a request?" card works this long. */
  draftMinutes: 60,
  /** A plain reply in a direct chat goes to the request last talked about this recently. */
  focusDays: 3,
} as const;

/** The paths chat platforms call (shown on the settings page, under the workspace's address). */
export const CHAT_ENDPOINTS: Record<HdChatApp, string> = {
  teams: "/api/helpdesk/chat/teams/messages",
  slack: "/api/helpdesk/chat/slack/events",
};

/** Slack reaction names: lowercase letters, digits, -, _ and +. */
export function cleanReaction(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/^:|:$/g, "").toLowerCase().slice(0, 60) : "";
}
export const REACTION_RE = /^[a-z0-9_+'-]{1,60}$/;

/** The chip text for an app's state. */
export interface HdChatAppView {
  connected: boolean;
  /** Teams: the bot's app ID. */
  app_id: string;
  /** Teams: the Entra tenant ID. */
  tenant_id: string;
  /** Slack: the workspace (from the first Test or the first verified event). */
  team_id: string;
  team_name: string;
  secret_set: boolean;
  /** Slack: the signing secret is saved. */
  signing_secret_set: boolean;
  connected_at: string | null;
  connected_by: string;
  abilities: HdChatAbilities;
  last_test: { at: string; ok: boolean; message: string } | null;
}

export interface HdChatSettingsView {
  teams: HdChatAppView;
  slack: HdChatAppView;
  channels: HdChatChannel[];
  /** The workspace's address, for the endpoint URLs ("" when unknown). */
  origin: string;
  teams_list: { id: number; name: string }[];
}
