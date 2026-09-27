// Who sees which field. A field (or one of the contact columns — email,
// phone, mobile) can be for everyone or for admins only: a mobile number
// the whole firm should not have, a birthday, a home office. Redaction
// happens once, on the server, before people reach a page, an API, an
// export or a contact card — so a viewer's browser never holds the value.
// Pure module.

import type { FieldLike, LinkRef } from "./directory-display";

export const VISIBILITIES = ["everyone", "admins"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** The built-in contact columns an admin can restrict; name, title, department and office are always public. */
export const CONTACT_COLUMNS = ["email", "phone", "mobile"] as const;
export type ContactColumn = (typeof CONTACT_COLUMNS)[number];
export type ColumnVisibility = Partial<Record<ContactColumn, Visibility>>;

export function parseVisibility(v: unknown): Visibility {
  return v === "admins" ? "admins" : "everyone";
}

export function parseColumnVisibility(raw: unknown): ColumnVisibility {
  const out: ColumnVisibility = {};
  if (raw && typeof raw === "object") {
    for (const c of CONTACT_COLUMNS) {
      const v = (raw as Record<string, unknown>)[c];
      if (v === "admins") out[c] = "admins";
    }
  }
  return out;
}

/**
 * The column keys a viewer must not see: admin-only fields (and the other
 * end of an admin-only people field), plus restricted contact columns.
 * Empty for admins.
 */
export function hiddenKeysFor(
  fields: (FieldLike & { visibility?: string })[],
  columns: ColumnVisibility,
  isAdmin: boolean
): Set<string> {
  const hidden = new Set<string>();
  if (isAdmin) return hidden;
  for (const f of fields) {
    if (f.visibility !== "admins") continue;
    hidden.add(f.key);
    if (f.kind === "people") hidden.add(f.key === "assistant" ? "assists" : `${f.key}:in`);
  }
  for (const c of CONTACT_COLUMNS) if (columns[c] === "admins") hidden.add(c);
  return hidden;
}

interface RedactablePerson {
  email: string;
  phone: string;
  mobile: string;
  custom: Record<string, string>;
  synced?: Record<string, string>;
  manual?: Record<string, string>;
  links?: Record<string, LinkRef[]>;
  linked_by?: Record<string, LinkRef[]>;
  assistant_name?: string | null;
}

/** People with every hidden key blanked. Returns the same objects when nothing is hidden. */
export function redactPeople<P extends RedactablePerson>(people: P[], hidden: Set<string>): P[] {
  if (hidden.size === 0) return people;
  const strip = (o: Record<string, string> | undefined) => {
    if (!o) return o;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (!hidden.has(k)) out[k] = v;
    return out;
  };
  const stripLinks = (o: Record<string, LinkRef[]> | undefined) => {
    if (!o) return o;
    const out: Record<string, LinkRef[]> = {};
    for (const [k, v] of Object.entries(o)) if (!hidden.has(k)) out[k] = v;
    return out;
  };
  return people.map((p) => ({
    ...p,
    email: hidden.has("email") ? "" : p.email,
    phone: hidden.has("phone") ? "" : p.phone,
    mobile: hidden.has("mobile") ? "" : p.mobile,
    custom: strip(p.custom) ?? {},
    ...(p.synced ? { synced: strip(p.synced) } : {}),
    ...(p.manual ? { manual: strip(p.manual) } : {}),
    ...(p.links ? { links: stripLinks(p.links) } : {}),
    ...(p.linked_by ? { linked_by: stripLinks(p.linked_by) } : {}),
    ...(p.assistant_name !== undefined ? { assistant_name: hidden.has("assistant") ? null : p.assistant_name } : {}),
  }));
}

/** The registry without the fields a viewer must not see. */
export function visibleFields<F extends FieldLike & { visibility?: string }>(fields: F[], hidden: Set<string>): F[] {
  return hidden.size === 0 ? fields : fields.filter((f) => !hidden.has(f.key));
}
