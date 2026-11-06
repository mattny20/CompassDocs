// The customer portal's one fetch helper (Helpdesk 1.19.1): portal pages
// talk only to /support/api, never to the app's /api. Answers the server's
// own sentence on a refusal.

export type PortalResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function portalFetch<T = Record<string, unknown>>(url: string, init: RequestInit, fallback: string): Promise<PortalResult<T>> {
  try {
    const res = await fetch(url, { ...init, credentials: "same-origin", headers: { accept: "application/json", ...(init.headers ?? {}) } });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: data?.error || fallback };
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, error: "Couldn't reach the server. Check your connection and try again." };
  }
}

/** "4 Nov, 09:12" in the reader's own time zone. */
export function portalDate(value: string): string {
  const d = new Date(value.includes("T") || /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}
