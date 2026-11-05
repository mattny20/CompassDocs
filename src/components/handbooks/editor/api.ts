// The routes the handbook editor talks to (src/app/api/handbooks/**, owned
// by lib/handbooks' routes), in one place so the editor's calls and the
// route files cannot drift apart silently. Every call answers the route's
// own `error` sentence on a refusal, or the caller's fallback.

import type { FindMode, Handbook, HandbookCandidate } from "@/lib/handbooks";
import { HANDBOOK_CHANGED_ELSEWHERE, HANDBOOK_FOREIGN_CONTENTS } from "@/lib/handbook-shared";

export const HANDBOOKS_URL = "/api/handbooks";
export const handbookUrl = (id: number) => `${HANDBOOKS_URL}/${id}`;
export const contentsUrl = (id: number) => `${HANDBOOKS_URL}/${id}/contents`;
export const publishUrl = (id: number) => `${HANDBOOKS_URL}/${id}/publish`;
export const candidatesUrl = (id: number) => `${HANDBOOKS_URL}/${id}/candidates`;
export const itemUrl = (id: number, docId: number) => `${HANDBOOKS_URL}/${id}/items/${docId}`;

/**
 * `foreign`: the route's 403 HANDBOOK_FOREIGN_CONTENTS, refusing to publish,
 * or to change who reads or owns, a handbook holding documents from spaces
 * this editor can't add from (its locked placeholders). The editor shows it
 * as a FormError on the Details card, not a toast.
 */
export type Refusal = { ok: false; error: string; foreign?: true };

export type Answer<T> = { ok: true; value: T } | Refusal;

/** The `foreign` mark, when the answer is that refusal. */
const foreignMark = (status: number, error: string) =>
  status === 403 && error === HANDBOOK_FOREIGN_CONTENTS ? { foreign: true as const } : {};

async function call<T>(method: string, url: string, body: unknown, fallback: string): Promise<Answer<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = (data as { error?: string })?.error || fallback;
      return { ok: false, error, ...foreignMark(res.status, error) };
    }
    return { ok: true, value: data as T };
  } catch {
    return { ok: false, error: fallback };
  }
}

export const createHandbook = (body: unknown) =>
  call<{ handbook: Handbook }>("POST", HANDBOOKS_URL, body, "Couldn't create the handbook.");

/**
 * The two saves of the editor's working copy are conditional (optimistic
 * concurrency): `ifUpdatedAt` is the handbook's updated_at as the editor
 * last loaded it, or as the previous save answered it. When someone else
 * saved in between, nothing is written and the answer is the route's 409
 * sentence ("This handbook was changed by someone else. Reload to see
 * their changes.", `conflict: true`); otherwise `updated_at` is the token
 * for the next save. Leave it out for an unconditional save.
 */
export type SaveAnswer = { ok: true; value: { handbook: Handbook; updated_at: string } } | (Refusal & { conflict?: true });

async function save(method: "PATCH" | "PUT", url: string, body: object, ifUpdatedAt: string | undefined, fallback: string): Promise<SaveAnswer> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ifUpdatedAt === undefined ? body : { ...body, if_updated_at: ifUpdatedAt }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; handbook?: Handbook; updated_at?: string };
    if (!res.ok) {
      const error = data?.error || fallback;
      return {
        ok: false,
        error,
        ...(res.status === 409 && error === HANDBOOK_CHANGED_ELSEWHERE ? { conflict: true as const } : {}),
        ...foreignMark(res.status, error),
      };
    }
    const handbook = data.handbook as Handbook;
    return { ok: true, value: { handbook, updated_at: data.updated_at ?? handbook.updated_at } };
  } catch {
    return { ok: false, error: fallback };
  }
}

export const updateDetails = (id: number, body: object, ifUpdatedAt?: string) =>
  save("PATCH", handbookUrl(id), body, ifUpdatedAt, "Couldn't save the handbook.");

export const saveContents = (id: number, body: object, ifUpdatedAt?: string) =>
  save("PUT", contentsUrl(id), body, ifUpdatedAt, "Couldn't save the contents.");

export const saveFindMode = (id: number, docId: number, mode: FindMode) =>
  call<{ handbook: Handbook }>("PATCH", itemUrl(id, docId), { find_mode: mode }, "Couldn't change where people find that policy.");

export const setPublished = (id: number, publish: boolean) =>
  call<{ handbook: Handbook }>(
    "POST",
    publishUrl(id),
    { publish },
    publish ? "Couldn't publish the handbook." : "Couldn't unpublish the handbook."
  );

export const deleteHandbook = (id: number) => call<unknown>("DELETE", handbookUrl(id), undefined, "Couldn't delete the handbook.");

export async function searchCandidates(
  id: number,
  q: { q: string; type: "policy" | "all"; spaceId: number | null },
  signal?: AbortSignal
): Promise<Answer<HandbookCandidate[]>> {
  const params = new URLSearchParams();
  if (q.q.trim()) params.set("q", q.q.trim());
  params.set("type", q.type);
  if (q.spaceId !== null) params.set("space", String(q.spaceId));
  try {
    const res = await fetch(`${candidatesUrl(id)}?${params}`, { signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { error?: string })?.error || "Couldn't search the documents." };
    return { ok: true, value: ((data as { candidates?: HandbookCandidate[] }).candidates ?? []) as HandbookCandidate[] };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return { ok: false, error: "Couldn't search the documents." };
  }
}
