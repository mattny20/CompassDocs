// Helpdesk 1.20.2: the Integrations hub's tiles (client-safe): what each is
// called, where it opens, which desk capability opens it (the same one its
// page always needed), and the old address it moved from. The hub page
// (components/helpdesk/desk/integrations) adds the icons; the statuses come
// from lib/helpdesk/integrations-hub.

export const INTEGRATIONS_HUB = "/desk/settings/integrations";

export type HubStatus = "connected" | "not_set_up" | "attention" | "none";
export interface HubTileState {
  status: HubStatus;
  /** One short fact under the description ("412 devices"); '' = none. */
  note: string;
}

export const HUB_GROUPS = [
  { key: "assets", title: "Assets" },
  { key: "chat", title: "Chat" },
  { key: "claude", title: "Claude" },
  { key: "developers", title: "Developers" },
  { key: "alerts", title: "Alerts and monitoring" },
] as const;
export type HubGroupKey = (typeof HUB_GROUPS)[number]["key"];

export interface HubTile {
  key: string;
  group: HubGroupKey;
  name: string;
  /** The line under the name. */
  category: string;
  description: string;
  href: string;
  /** Any one of these desk capabilities opens it. */
  caps: readonly ("settings.manage" | "channels.manage")[];
  /** The button's words while it is not set up (else "Open"). */
  setup?: string;
  docs?: string;
}

const DOCS = "https://docs.compassdocs.io/helpdesk";

export const HUB_TILES = [
  { key: "snipe-it", group: "assets", name: "Snipe-IT", category: "Asset management", description: "Link devices to tickets and see each one's history. Synced from your Snipe-IT.", href: `${INTEGRATIONS_HUB}/snipe-it`, caps: ["settings.manage"], docs: `${DOCS}/assets/` },
  { key: "intune", group: "assets", name: "Microsoft Intune", category: "Device management", description: "Managed devices with their compliance, matched to people and to Snipe-IT by serial.", href: `${INTEGRATIONS_HUB}/intune`, caps: ["settings.manage"], docs: `${DOCS}/assets/` },
  { key: "assets", group: "assets", name: "Asset settings", category: "For every source", description: "Who sees assets: whether agents can search all of them.", href: `${INTEGRATIONS_HUB}/assets`, caps: ["settings.manage"] },
  { key: "teams", group: "chat", name: "Microsoft Teams", category: "Chat app", description: "Raise, follow and approve requests from Teams.", href: `${INTEGRATIONS_HUB}/chat#chat-teams`, caps: ["settings.manage"], docs: `${DOCS}/chat-apps/` },
  { key: "slack", group: "chat", name: "Slack", category: "Chat app", description: "Raise, follow and approve requests from Slack.", href: `${INTEGRATIONS_HUB}/chat#chat-slack`, caps: ["settings.manage"], docs: `${DOCS}/chat-apps/` },
  { key: "claude-connector", group: "claude", name: "Claude connector", category: "MCP", description: "What Claude can do in the helpdesk for people who connect it.", href: `${INTEGRATIONS_HUB}/claude-connector`, caps: ["settings.manage"] },
  { key: "claude-desk", group: "claude", name: "Claude in the desk", category: "In the ticket pane", description: "Agents ask Claude about a ticket. Also in the settings menu, with its policy controls.", href: "/desk/settings/claude-desk", caps: ["settings.manage"], docs: `${DOCS}/claude-in-the-desk/` },
  { key: "api-tokens", group: "developers", name: "API tokens", category: "REST API", description: "Tokens for scripts and tools that read and change tickets as a desk role.", href: `${INTEGRATIONS_HUB}/api#api-tokens`, caps: ["settings.manage"], docs: `${DOCS}/api-and-webhooks/` },
  { key: "webhooks", group: "developers", name: "Webhooks", category: "Outgoing events", description: "Tell your own systems when tickets change, signed and retried.", href: `${INTEGRATIONS_HUB}/api#webhooks`, caps: ["settings.manage"], docs: `${DOCS}/api-and-webhooks/` },
  { key: "alerts", group: "alerts", name: "Alert sources", category: "Monitoring tools, bots and automated mail", description: "Grafana, Prometheus, uptime checks and mailboxes that open and update tickets by themselves.", href: `${INTEGRATIONS_HUB}/alerts`, caps: ["settings.manage", "channels.manage"], setup: "Add a source", docs: `${DOCS}/integrations/` },
] as const satisfies readonly HubTile[];

export type HubTileKey = (typeof HUB_TILES)[number]["key"];

/** Where each page that used to be its own settings entry lives now (its old address redirects there). */
export const MOVED_SETTINGS: Readonly<Record<string, string>> = {
  "/desk/settings/assets": INTEGRATIONS_HUB,
  "/desk/settings/chat": `${INTEGRATIONS_HUB}/chat`,
  "/desk/settings/claude": `${INTEGRATIONS_HUB}/claude-connector`,
  "/desk/settings/api": `${INTEGRATIONS_HUB}/api`,
};

/** Segments under /desk/settings/integrations that are pages of their own, never an alert source's id. */
export const HUB_RESERVED = ["alerts", "new", "snipe-it", "intune", "assets", "chat", "claude-connector", "api"] as const;
