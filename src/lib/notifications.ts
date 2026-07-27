// The notification inbox behind the sidebar bell. `notify()` fans one event
// out to a set of users: a row each in the notifications table, plus a POST
// to each recipient's personal incoming webhook (Slack/Teams) when they've
// configured one. Fire-and-forget from write paths — call with `void`;
// failures are logged and never block the triggering action. Server-only.

import "server-only";
import { insertNotifications, getUserById } from "./db";
import { safeFetch } from "./safe-fetch";

export interface NotificationEvent {
  kind:
    | "mention"
    | "comment"
    | "doc_update"
    | "cr_submitted"
    | "cr_resolved"
    | "review_due"
    | "ack_requested";
  title: string;
  body?: string;
  /** In-app path, e.g. `/doc/12#comments`. */
  link?: string;
  actorName?: string;
  /** Absolute origin for webhook links; empty = link text stays relative. */
  origin?: string;
}

/** Tell every approver who can see the space that a change request is waiting. */
export async function notifyCrSubmitted(input: {
  spaceId: number;
  title: string;
  actorId: number;
  actorName: string;
  origin?: string;
}): Promise<void> {
  const { listApproverIdsForSpace } = await import("./db");
  await notify(await listApproverIdsForSpace(input.spaceId, input.actorId), {
    kind: "cr_submitted",
    title: `${input.actorName} submitted "${input.title}" for review`,
    link: "/review",
    actorName: input.actorName,
    origin: input.origin,
  });
}

export async function notify(userIds: number[], ev: NotificationEvent): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  try {
    await insertNotifications(ids, {
      kind: ev.kind,
      title: ev.title,
      body: ev.body,
      link: ev.link,
      actor_name: ev.actorName,
    });
  } catch (e) {
    console.error("notify: insert failed:", e);
    return; // no rows -> nothing to mirror to webhooks either
  }

  for (const id of ids) {
    try {
      const user = await getUserById(id);
      const hook = user?.notify_webhook_url?.trim();
      if (!user || !hook || user.status !== "active") continue;
      const line = ev.body ? `${ev.title}\n${ev.body}` : ev.title;
      const url = ev.link ? `${ev.origin || ""}${ev.link}` : "";
      // `text` is understood by both Slack and Teams incoming webhooks.
      const res = await safeFetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: url ? `${line}\n${url}` : line }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) console.error(`notify: webhook for user ${id} returned ${res.status}`);
    } catch (e) {
      console.error(`notify: webhook for user ${id} failed:`, e);
    }
  }
}
