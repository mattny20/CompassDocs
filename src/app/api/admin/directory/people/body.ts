// The one place the admin people API decides which keys a request may touch.
//
// A synced row belongs to its provider for the columns the provider fills:
// name, title, department, contact details, photo. Letting an admin "edit"
// those would show their change until the next sync silently put it back —
// the worst kind of edit. What an admin owns on every row is the manual layer
// (custom values, which shadow synced ones per key), manual links, hidden,
// and the pin.

import type { PersonInput, PersonSource } from "@/lib/directory";

type Body = Record<string, unknown>;

function idList(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function linkMap(v: unknown): Record<string, number[]> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, number[]> = {};
  for (const [k, ids] of Object.entries(v as Record<string, unknown>)) {
    const list = idList(ids);
    if (list && /^[a-z0-9_]{1,40}$/.test(k)) out[k] = list;
  }
  return out;
}

function customMap(v: unknown): Record<string, string | null> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string | null> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
    out[k] = val === null ? null : String(val ?? "");
  }
  return out;
}

/** Everything a PATCH/POST may set, filtered by who owns the row. */
export function readPersonBody(body: Body, source: PersonSource): Partial<PersonInput> & { hidden?: boolean } {
  const out: Partial<PersonInput> & { hidden?: boolean } = {};
  if (source === "manual") {
    for (const k of ["name", "title", "department", "email", "phone", "mobile", "office"] as const) {
      if (body[k] !== undefined) out[k] = String(body[k]);
    }
  }
  if (body.hidden !== undefined) out.hidden = Boolean(body.hidden);
  if (body.pin_order !== undefined) {
    out.pin_order = body.pin_order === null || body.pin_order === false ? null : Number(body.pin_order);
    if (out.pin_order !== null && !Number.isInteger(out.pin_order)) out.pin_order = null;
  } else if (body.pinned !== undefined) {
    // A boolean convenience: pin at the end, or unpin.
    out.pin_order = body.pinned ? Number.MAX_SAFE_INTEGER : null;
  }
  const custom = customMap(body.custom);
  if (custom) out.custom = custom;
  const links = linkMap(body.links);
  if (links) out.links = links;
  const linkedBy = linkMap(body.linked_by);
  if (linkedBy) out.linked_by = linkedBy;
  return out;
}
