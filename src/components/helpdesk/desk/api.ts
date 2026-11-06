// Client-side fetch helpers for the desk (1.19.0). Every desk screen loads
// its data from the helpdesk REST API (src/app/api/helpdesk/**), so the
// pages stay thin and the same routes the specs call are the ones the UI
// uses. Errors carry the server's own sentence (STYLEGUIDE §Feedback:
// never fail silently, prefer the server's `error`).

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function parse(res: Response, fallback: string): Promise<unknown> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string })?.error;
    throw new ApiError(msg || fallback, res.status);
  }
  return data;
}

/** GET a JSON document; throws ApiError with the server's sentence. */
export async function getJson<T = unknown>(url: string, fallback = "Couldn't load that.", signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  return (await parse(res, fallback)) as T;
}

/** POST/PATCH/PUT/DELETE a JSON body; throws ApiError with the server's sentence. */
export async function sendJson<T = unknown>(
  url: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
  fallback = "Couldn't save that."
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await parse(res, fallback)) as T;
}

/**
 * A list out of a response that may be the array itself or an object
 * holding it under one of a few keys ({ tickets: [...] }, { items: [...] }).
 * The desk reads several routes built concurrently with it, so it accepts
 * either shape rather than breaking on a key name.
 */
export function listOf<T>(data: unknown, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of [...keys, "items", "rows", "data"]) {
      if (Array.isArray(o[k])) return o[k] as T[];
    }
  }
  return [];
}

/** One object out of a response that may wrap it ({ ticket: {...} }). */
export function itemOf<T>(data: unknown, ...keys: string[]): T {
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of keys) {
      if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) return o[k] as T;
    }
  }
  return data as T;
}

export const isLicenceError = (e: unknown) => e instanceof ApiError && e.status === 402;
export const isForbidden = (e: unknown) => e instanceof ApiError && e.status === 403;
