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
//
// Distinguished names (1.14.1). AD's own `assistant` attribute holds the
// assistant's DN, and a CN in the "Last, First" form is escaped in it:
// `CN=Ruiz\, Dana,OU=Staff,DC=firm,DC=com` (or `\2C`, or the older quoted
// `CN="Ruiz, Dana"`). The CN is read with those escapes (RFC 4514), a DN is
// never cut at its commas when it does not resolve, and a person's own
// on-premises DN is indexed exactly, so a DN names the account it points at
// even when the CN differs from the Entra display name or two people share
// a name. Letter case never matters: every handle and token is lowercased.

/**
 * The Microsoft Graph user properties the index reads besides the base set
 * (id, mail, userPrincipalName, displayName). Graph returns them only when
 * asked by $select, so the sync asks for them whenever a people field is
 * mapped from Microsoft (directory.ts providerSelectProperties).
 */
export const MICROSOFT_RESOLVER_PROPERTIES = [
  "mailNickname",
  "onPremisesSamAccountName",
  "onPremisesUserPrincipalName",
  "onPremisesDistinguishedName",
  "proxyAddresses",
] as const;

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

/** A value that reads as a distinguished name: `CN=…`, `cn = …` and the like. */
export function isDistinguishedName(value: string): boolean {
  return /^\s*cn\s*=/i.test(value);
}

/**
 * Split a DN into its RDNs at the commas that are not escaped (`\,`, `\2C`)
 * and not inside a quoted value, each RDN trimmed. Escapes are kept as typed.
 */
function splitRdns(dn: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < dn.length; i++) {
    const c = dn[i];
    if (c === "\\" && i + 1 < dn.length) {
      cur += c + dn[i + 1];
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if ((c === "," || c === ";") && !quoted) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * One DN in the form both sides of a comparison share: lowercased, each RDN
 * trimmed and its `attr = value` spacing removed, joined with plain commas.
 * Escapes stay as typed, which is how AD writes the same DN everywhere.
 */
export function canonicalDn(dn: string): string {
  return splitRdns(String(dn ?? "").trim())
    .filter(Boolean)
    .map((rdn) => {
      const eq = rdn.indexOf("=");
      return eq > 0 ? `${rdn.slice(0, eq).trim()}=${rdn.slice(eq + 1).trim()}` : rdn;
    })
    .join(",")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** An RDN value with its RFC 4514 escapes undone: `Ruiz\, Dana`, `Ruiz\2C Dana` and `"Ruiz, Dana"` are all "Ruiz, Dana". */
function unescapeRdnValue(raw: string): string {
  let v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  const bytes: number[] = [];
  let out = "";
  const flush = () => {
    if (bytes.length) {
      // TextDecoder, not Buffer: this module is pure and runs anywhere.
      out += new TextDecoder().decode(new Uint8Array(bytes));
      bytes.length = 0;
    }
  };
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "\\" && i + 1 < v.length) {
      const hex = v.slice(i + 1, i + 3);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      flush();
      out += v[i + 1];
      i++;
      continue;
    }
    flush();
    out += c;
  }
  flush();
  return out;
}

/** The CN of a DN, unescaped; "" when the first RDN is not a CN. */
export function commonNameOf(dn: string): string {
  const first = splitRdns(String(dn ?? "").trim())[0] ?? "";
  const m = /^cn\s*=\s*([\s\S]*)$/i.exec(first);
  return m ? unescapeRdnValue(m[1]) : "";
}

/** What a token might be, in the order to try: the most specific first. */
function tokenCandidates(token: string): { exact: string[]; names: string[] } {
  let t = token.trim();
  if (!t) return { exact: [], names: [] };
  // "Dana Ruiz <dana@firm.com>" — the address is the reliable part.
  const angled = /<([^<>]+)>\s*$/.exec(t);
  if (angled) t = angled[1];
  // A distinguished name: the person whose own DN it is, else the CN as a
  // display name (AD's CN is usually the display name, in either order).
  if (isDistinguishedName(t)) return { exact: [canonicalDn(t)], names: nameForms(commonNameOf(t)) };
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
    for (const k of ["userPrincipalName", "mail", "mailNickname", "onPremisesSamAccountName", "onPremisesUserPrincipalName", "primaryEmail"]) {
      const v = str(r[k]);
      if (v) addExact(v, p.id);
    }
    // The person's own on-premises DN: what AD's DN-valued attributes
    // (assistant, secretary, manager) hold when they name this person.
    const dn = str(r["onPremisesDistinguishedName"]);
    if (dn) {
      const k = canonicalDn(dn);
      if (k && !exact.has(k)) exact.set(k, p.id);
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
      // Semicolons and line breaks separate people, except an escaped `\;`
      // inside a DN.
      for (const part of String(value ?? "").split(/(?<!\\);|\n/).map((s) => s.trim()).filter(Boolean)) {
        const whole = resolve(part);
        // A DN is one person whether or not it resolved: its commas separate
        // RDNs, never people, so it is reported whole rather than as pieces.
        if (whole || !part.includes(",") || isDistinguishedName(part)) {
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
