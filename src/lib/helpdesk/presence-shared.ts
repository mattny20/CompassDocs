// Helpdesk 1.19.1: ticket presence and the send guard, the parts the desk's
// client code and the server share (agent V4). Dependency-free.
//
// Presence: while a ticket is open the desk POSTs a heartbeat every
// PRESENCE_HEARTBEAT_MS (paused while the tab is hidden); a row not seen
// for PRESENCE_TTL_SECONDS counts as gone. Only agents who work the ticket
// read or write it; requesters never see presence.
//
// Send guard: the composer remembers the newest message id when typing
// starts and sends it as `expect_last_message_id`. A newer public reply or
// internal note by someone else answers 409 { error, newer: HdNewerMessage[] }
// and nothing is posted; `force: true` sends anyway.

export const PRESENCE_TTL_SECONDS = 30;
export const PRESENCE_HEARTBEAT_MS = 10_000;
/** The sweep deletes rows older than this. */
export const PRESENCE_SWEEP_SECONDS = 300;

export type HdPresenceState = "viewing" | "replying";

export function isPresenceState(v: unknown): v is HdPresenceState {
  return v === "viewing" || v === "replying";
}

/** Someone else with the ticket open. */
export interface HdPresence {
  user_id: number;
  name: string;
  initials: string;
  state: HdPresenceState;
  /** When the current state began (ISO). */
  since: string;
  /** The last heartbeat (ISO). */
  seen_at: string;
}

/** A message that landed after the composer started (the 409's `newer`). */
export interface HdNewerMessage {
  id: number;
  author_id: number | null;
  author_name: string;
  initials: string;
  kind: "public" | "internal";
  /** Written by the ticket's requester (not an agent). */
  from_requester: boolean;
  /** The text, cut to NEWER_BODY_MAX characters. */
  body: string;
  created_at: string;
}

export const NEWER_BODY_MAX = 600;
export const COLLISION_ERROR = "Someone replied while you were typing. Nothing was sent.";

/** "Sam Lee" · "Sam and Ana" · "Sam and 2 others": who is present, for the header. */
export function presenceNames(list: Pick<HdPresence, "name">[]): string {
  if (!list.length) return "";
  const first = (n: string) => n.trim().split(/\s+/)[0] || n;
  if (list.length === 1) return list[0].name;
  if (list.length === 2) return `${first(list[0].name)} and ${first(list[1].name)}`;
  return `${first(list[0].name)} and ${list.length - 1} others`;
}

/** "is viewing" / "is replying" / "are viewing" / "are replying" (anyone replying wins). */
export function presenceVerb(list: Pick<HdPresence, "state">[]): string {
  const replying = list.some((p) => p.state === "replying");
  return `${list.length > 1 ? "are" : "is"} ${replying ? "replying" : "viewing"}`;
}

/** "Ana Ruiz" → "AR" (UserAvatar's rule, without the component). */
export function presenceInitials(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((p) => p.replace(/^[^\p{L}\p{N}]+/u, "")[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return letters || name.trim().slice(0, 1) || "?";
}
