"use client";

// Collision warnings on the desk (1.19.1, agent V4): the presence heartbeat
// and the guarded send.
//
// useTicketPresence(number) POSTs a heartbeat every 10 s while the ticket
// is open and the tab is visible (paused while hidden; the server forgets a
// row after 30 s) and returns who else has it open. The composer reports
// typing through noteTyping/clearTyping, so the heartbeat says 'replying'
// for 20 s after the last keystroke, and a change of state beats at once.
// Leaving the ticket (or the page) deletes the row (a moment later, so a
// remount of the same ticket does not flicker it away).
//
// postGuarded() is the composer's message POST: a 409 carrying `newer`
// (someone replied while you were typing) throws CollisionError, which the
// composer turns into the collision dialog.

import { useEffect, useState } from "react";
import { PRESENCE_HEARTBEAT_MS, type HdNewerMessage, type HdPresence, type HdPresenceState } from "@/lib/helpdesk/presence-shared";
import { ApiError, noteDuoRequired } from "../api";

const REPLYING_MS = 20_000;
/** A remount of the same ticket (a reload of the pane) within this cancels the leave. */
const LEAVE_DELAY_MS = 2_000;
const pendingLeave = new Map<number, ReturnType<typeof setTimeout>>();
const typing = new Map<number, number>();
const listeners = new Set<() => void>();

function replying(n: number): boolean {
  const t = typing.get(n);
  return t !== undefined && Date.now() - t < REPLYING_MS;
}

/** The composer of ticket `n` has unsent text and was typed in just now. */
export function noteTyping(n: number): void {
  const was = replying(n);
  typing.set(n, Date.now());
  if (!was) for (const l of listeners) l();
}

/** The composer of ticket `n` was sent, emptied or discarded. */
export function clearTyping(n: number): void {
  if (typing.delete(n)) for (const l of listeners) l();
}

/** The newest message id the pane shows (the send guard's starting point). */
export function latestMessageId(messages: { id: number }[] | undefined): number {
  let max = 0;
  for (const m of messages ?? []) if (m.id > max) max = m.id;
  return max;
}

/** Who else has this ticket open, kept fresh by this tab's heartbeat. */
export function useTicketPresence(number: number, enabled = true): HdPresence[] {
  const [present, setPresent] = useState<HdPresence[]>([]);
  useEffect(() => {
    if (!enabled || !number) return;
    const url = `/api/helpdesk/tickets/${number}/presence`;
    // Back on the same ticket before the leave went out: it never left.
    const pending = pendingLeave.get(number);
    if (pending) {
      clearTimeout(pending);
      pendingLeave.delete(number);
    }
    let alive = true;
    let last: HdPresenceState | null = null;
    let inFlight = false;
    const beat = async () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      const state: HdPresenceState = replying(number) ? "replying" : "viewing";
      last = state;
      inFlight = true;
      // A beat that hangs must not stop the next ones: give up after 20 s.
      const ctrl = new AbortController();
      const giveUp = setTimeout(() => ctrl.abort(), 20_000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ state }),
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) return; // presence is decoration: a refused beat keeps quiet
        const data = (await res.json().catch(() => ({}))) as { present?: HdPresence[] };
        if (alive) setPresent(Array.isArray(data.present) ? data.present : []);
      } catch {
        /* offline: try again next beat */
      } finally {
        clearTimeout(giveUp);
        inFlight = false;
      }
    };
    const onState = () => {
      if ((replying(number) ? "replying" : "viewing") !== last) void beat();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    const leave = () => {
      try {
        void fetch(url, { method: "DELETE", keepalive: true, headers: { accept: "application/json" } }).catch(() => {});
      } catch {
        /* the page is going away */
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), PRESENCE_HEARTBEAT_MS);
    // Typing stops counting after 20 s: look again between beats.
    const recheck = setInterval(onState, 5_000);
    listeners.add(onState);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", leave);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(recheck);
      listeners.delete(onState);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", leave);
      // Sent a moment later, so a DELETE racing the remount's POST can't
      // erase the row the new mount just wrote.
      pendingLeave.set(
        number,
        setTimeout(() => {
          pendingLeave.delete(number);
          leave();
        }, LEAVE_DELAY_MS)
      );
      setPresent([]);
    };
  }, [number, enabled]);
  return present;
}

/** Someone replied while you were typing: the server's 409 with the messages you had not seen. */
export class CollisionError extends Error {
  newer: HdNewerMessage[];
  constructor(message: string, newer: HdNewerMessage[]) {
    super(message);
    this.newer = newer;
  }
}

/** POST a message with the send guard; throws CollisionError on a collision, ApiError otherwise. */
export async function postGuarded<T = unknown>(url: string, body: Record<string, unknown>, fallback: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: unknown; newer?: HdNewerMessage[] };
  if (res.status === 409 && Array.isArray(data.newer) && data.newer.length) throw new CollisionError(data.error || fallback, data.newer);
  noteDuoRequired(res.status, data.code); // 1.20.5: a refused Send raises the desk's Duo prompt; the text stays in the box
  if (!res.ok) throw new ApiError(data.error || fallback, res.status);
  return data as T;
}
