"use client";

// The email template routes (1.19.0, /api/admin/email-templates/**), in
// one place: every screen calls these, so a route's address or answer
// changes here only. Each call resolves to { ok, status, data } and never
// throws; a refusal's sentence is data.error.

import type { EmailComposition, EmailPart, EmailPartKind, PartUsage } from "./types";

const BASE = "/api/admin/email-templates";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T & { error?: string; used_by?: PartUsage[] };
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as ApiResult<T>["data"];
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "The server could not be reached." } as ApiResult<T>["data"] };
  }
}

export interface PartDraft {
  name: string;
  subject?: string;
  content: string;
}

export const partsApi = {
  create: (kind: EmailPartKind, draft: PartDraft & { event_key?: string | null }) =>
    call<{ part: EmailPart & { used_by: PartUsage[] } }>("/parts", "POST", { kind, ...draft }),
  update: (id: number, draft: Partial<PartDraft>) =>
    call<{ part: EmailPart & { used_by: PartUsage[] } }>(`/parts/${id}`, "PATCH", draft),
  remove: (id: number) => call<{ ok: true }>(`/parts/${id}`, "DELETE"),
  reset: (id: number) => call<{ part: EmailPart & { used_by: PartUsage[] } }>(`/parts/${id}/reset`, "POST"),
  makeDefault: (id: number) => call<{ part: EmailPart }>(`/parts/${id}/default`, "POST"),
};

export interface Slots {
  header_id: number | null;
  body_id: number | null;
  signature_id: number | null;
  footer_id: number | null;
}

export const compositionsApi = {
  save: (event: string, scope: string, slots: Slots) =>
    call<{ composition: EmailComposition }>(`/compositions/${encodeURIComponent(event)}`, "PUT", { scope, ...slots }),
  removeVariant: (event: string, scope: string) =>
    call<{ ok: boolean; composition?: EmailComposition }>(`/compositions/${encodeURIComponent(event)}?scope=${encodeURIComponent(scope)}`, "DELETE"),
};

/** An unsaved combination, or an unsaved part inside the defaults. */
export interface PreviewRequest {
  event: string;
  scope?: string;
  /** Part ids per slot (null: the slot's inherited part). */
  header_id?: number | null;
  body_id?: number | null;
  signature_id?: number | null;
  footer_id?: number | null;
  /** Unsaved content for one slot, in place of its part. */
  draft?: { kind: EmailPartKind; subject?: string; content: string };
}

export const previewApi = {
  render: (req: PreviewRequest) => call<{ subject: string; html: string }>("/preview", "POST", req),
  sendTest: (req: PreviewRequest) => call<{ ok: true; to?: string }>("/test", "POST", req),
};
