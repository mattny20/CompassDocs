// Helpdesk 1.20.7: what outgoing mail needs to know about the Microsoft 365
// connection, kept in memory so the ticket path pays no query for it: is a
// connection saved, which help addresses live on a connected mailbox (their
// replies carry a reply address even while the inbound webhook is off), and
// which of those send through Microsoft Graph.
//
// Loaded once per process, then refreshed by every write in
// lib/helpdesk/m365/mail and by the minute sweep (so another instance's
// change is seen within a minute). An install that never connects Microsoft
// 365 reads one settings row at the first mail and nothing after. Server-only.

import "server-only";
import { getSetting } from "../../db";
import { hq } from "../db-core";

export const M365_MAIL_KEY = "helpdesk_m365_mail";

export interface M365State {
  configured: boolean;
  /** Help addresses (hd_mailboxes.id) that live on a connected mailbox. */
  linked: ReadonlySet<number>;
  /** Those whose replies go out through Microsoft Graph. */
  sendVia: ReadonlySet<number>;
}

const EMPTY: M365State = { configured: false, linked: new Set(), sendVia: new Set() };
let state: M365State | null = null;
let loading: Promise<M365State> | null = null;

async function load(): Promise<M365State> {
  let configured = false;
  try {
    const raw = await getSetting(M365_MAIL_KEY);
    const v = raw ? JSON.parse(raw) : null;
    configured = !!(v && typeof v.tenant === "string" && v.tenant && typeof v.key === "string" && v.key);
  } catch {
    configured = false;
  }
  if (!configured) return EMPTY;
  const rows = await hq<{ mailbox_id: number; send_via: boolean }>("SELECT mailbox_id, send_via FROM hd_m365_links");
  return { configured, linked: new Set(rows.map((r) => r.mailbox_id)), sendVia: new Set(rows.filter((r) => r.send_via).map((r) => r.mailbox_id)) };
}

/** Read the state again (after a write, and once a minute from the sweep). */
export async function refreshM365State(): Promise<M365State> {
  loading = load()
    .then((s) => (state = s))
    .catch(() => state ?? EMPTY)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The state as last read; the first call reads it. */
export async function m365State(): Promise<M365State> {
  return state ?? loading ?? refreshM365State();
}

/** Tests: forget it. */
export function resetM365StateForTests(): void {
  state = null;
  loading = null;
}
