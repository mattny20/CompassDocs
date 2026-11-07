// Helpdesk 1.19.4: the chat apps' neutral shapes. lib/helpdesk/chat/core
// speaks these; teams.ts and slack.ts turn them into an activity or Block
// Kit. Text is a small Markdown: **bold**, [label](https://…) links and
// "• " lines, nothing else (escaped for Slack on the way out).

import type { HdChatApp } from "../chat-shared";

/** Where a message goes: a direct chat or a channel thread. */
export interface ConvRef {
  /** Teams only: the Bot Connector address the conversation lives at. */
  service_url?: string;
  /** Teams: the conversation ID; Slack: the channel ID (D… for a direct chat). */
  conversation_id: string;
  /** Slack: thread_ts; Teams: the activity replied to (a channel thread root). */
  thread_id?: string;
}

export type ChatMsg =
  | { kind: "text"; text: string }
  | {
      kind: "confirm";
      draftId: string;
      /** "Laptop or device problem · IT Service Desk", or "The helpdesk". */
      subtitle: string;
      device: string;
      body: string;
      typeId: number | null;
      assetId: number | null;
      types: { id: number; title: string }[];
      devices: { id: number; label: string }[];
    }
  | {
      kind: "approval";
      approvalId: number;
      requester: string;
      typeTitle: string;
      number: number;
      rows: [string, string][];
      openUrl: string;
      reminder: boolean;
    }
  | { kind: "decided"; title: string; text: string };

/** A chat account as the platform names it. */
export interface ChatPerson {
  app: HdChatApp;
  /** Teams: the Entra object ID (aadObjectId); Slack: the member ID. */
  id: string;
  name: string;
  /** Teams: the 29:… id this bot knows the person by. */
  platform_id?: string;
}

/** A CompassDocs account a chat account maps to. */
export interface ChatUser {
  id: number;
  username: string;
  name: string;
  email: string;
  role: import("../../types").Role;
}
