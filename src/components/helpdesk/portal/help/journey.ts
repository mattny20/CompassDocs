// The help centre's journey (Helpdesk 1.19.4, C3), client side: a random
// id for this browser tab, kept in sessionStorage (never a cookie, never
// sent anywhere but the portal's own stats routes), so the settings page
// can count searches that ended in an article rather than a request.
// Best effort: storage that throws (a private window, blocked site data)
// simply means nothing is counted.

const KEY = "compass_hc_journey";

function randomId(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID().replace(/-/g, "");
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

/** This tab's journey id; with `create`, one is made when there is none. "" when storage is unavailable. */
export function journeyId(create = false): string {
  try {
    let id = sessionStorage.getItem(KEY) ?? "";
    if (!id && create) {
      id = randomId();
      if (id) sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}

/**
 * Keep a journey this tab did not start: the one the sign-in link carried
 * from the tab that asked for it (the email opens in a new tab or another
 * browser). A journey already here wins.
 */
export function adoptJourney(id: unknown): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return;
  try {
    if (!sessionStorage.getItem(KEY)) sessionStorage.setItem(KEY, id);
  } catch {
    /* best effort */
  }
}

/** The journey ended in a request (the server recorded it): this tab starts afresh. */
export function endJourney(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
}

/**
 * Tell the stats an article was opened (starting a journey if needed).
 * Fire and forget, surviving the page change. A request raised afterwards
 * is recorded by the server: the request form sends the journey with the
 * request, and the sign-in link carries it (PortalSignIn → PortalContinue).
 */
export function journeyStep(event: "open"): void {
  const id = journeyId(true);
  if (!id) return;
  try {
    void fetch("/support/api/help/journey", {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, event }),
    }).catch(() => {});
  } catch {
    /* best effort */
  }
}
