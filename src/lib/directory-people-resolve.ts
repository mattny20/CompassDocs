// Turning what a people-field mapping produced into a person.
//
// A tenant rarely keeps an assistant as an object id. The attribute holds
// whatever someone typed years ago: a display name ("Dana Ruiz"), the AD
// form ("Ruiz, Dana"), a sign-in name (dana@firm.com or DRuiz), a
// distinguished name (CN=Dana Ruiz,OU=Staff,…), or "Dana Ruiz
// <dana@firm.com>". All of those name one person to a human, so they must
// name one person here. A name two people share resolves to nobody, and
// says so, rather than guessing.
//
// Pure module: build an index once per sync, resolve each token against it.

export interface ResolvablePerson {
  id: number;
  external_id: string | null;
  email: string;
  name: string;
  /** The provider's raw user object, when the sync stored one. */
  record?: Record<string, unknown> | null;
}

export type Resolution = { id: number } | { ambiguous: number } | undefined;

export interface PeopleIndex {
  resolve(token: string): Resolution;
  /**
   * Resolve a whole attribute value. Semicolons always separate people; a
   * comma separates people only when the text on either side is not one
   * person's name — "Ruiz, Dana" is one assistant, "Dana Ruiz, Sam Chen" is
   * two, and "CN=Dana Ruiz,OU=Staff" is one. The whole part is tried first,
   * then its comma pieces.
   */
  resolveList(value: string): { token: string; hit: Resolution }[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** "Ruiz, Dana" → "dana ruiz"; anything else normalised as is. */
function nameForms(raw: string): string[] {
  const n = norm(raw);
  if (!n) return [];
  const out = new Set<string>([n]);
  const comma = n.indexOf(",");
  if (comma > 0) out.add(norm(`${n.slice(comma + 1)} ${n.slice(0, comma)}`));
  // Honorifics and suffixes do not change who it is.
  const stripped = n
    .replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/, "")
    .replace(/,?\s+(jr|sr|ii|iii|iv|esq)\.?$/, "");
  if (stripped !== n) out.add(stripped);
  return [...out];
}

/** What a token might be, in the order to try: the most specific first. */
function tokenCandidates(token: string): { exact: string[]; names: string[] } {
  let t = token.trim();
  if (!t) return { exact: [], names: [] };
  // "Dana Ruiz <dana@firm.com>" — the address is the reliable part.
  const angled = /<([^<>]+)>\s*$/.exec(t);
  if (angled) t = angled[1];
  // A distinguished name: the CN is the display name.
  const cn = /^cn=([^,]+)/i.exec(t);
  if (cn) return { exact: [], names: nameForms(cn[1]) };
  const exact = [norm(t)];
  return { exact, names: nameForms(t) };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Index people by every handle a token could carry. Exact handles (object
 * id, email, sign-in name, mail nickname, SAM account name) are unique to a
 * person by construction; names can collide and are tracked as a list.
 */
export function buildPeopleIndex(people: ResolvablePerson[]): PeopleIndex {
  const exact = new Map<string, number>();
  const names = new Map<string, Set<number>>();
  const addExact = (key: string, id: number) => {
    const k = norm(key);
    if (k && !exact.has(k)) exact.set(k, id);
  };
  const addName = (raw: string, id: number) => {
    for (const form of nameForms(raw)) {
      const set = names.get(form) ?? new Set<number>();
      set.add(id);
      names.set(form, set);
    }
  };
  for (const p of people) {
    if (p.external_id) addExact(p.external_id, p.id);
    if (p.email) addExact(p.email, p.id);
    const r = p.record ?? {};
    for (const k of ["userPrincipalName", "mail", "mailNickname", "onPremisesSamAccountName", "primaryEmail"]) {
      const v = str(r[k]);
      if (v) addExact(v, p.id);
    }
    const aliases = r["proxyAddresses"];
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        const v = str(a).replace(/^smtp:/i, "");
        if (v) addExact(v, p.id);
      }
    }
    if (p.name) addName(p.name, p.id);
    const display = str(r["displayName"]);
    if (display && norm(display) !== norm(p.name)) addName(display, p.id);
  }
  const resolve = (token: string): Resolution => {
    const { exact: exactKeys, names: nameKeys } = tokenCandidates(token);
    for (const k of exactKeys) {
      const id = exact.get(k);
      if (id !== undefined) return { id };
    }
    for (const n of nameKeys) {
      const set = names.get(n);
      if (!set || set.size === 0) continue;
      if (set.size === 1) return { id: [...set][0] };
      return { ambiguous: set.size };
    }
    return undefined;
  };
  return {
    resolve,
    resolveList(value: string) {
      const out: { token: string; hit: Resolution }[] = [];
      for (const part of String(value ?? "").split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
        const whole = resolve(part);
        if (whole || !part.includes(",")) {
          out.push({ token: part, hit: whole });
          continue;
        }
        for (const piece of part.split(",").map((s) => s.trim()).filter(Boolean)) {
          out.push({ token: piece, hit: resolve(piece) });
        }
      }
      return out;
    },
  };
}
