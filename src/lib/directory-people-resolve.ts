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
// `CN="Ruiz, Dana"`). The CN is read with those escapes (RFC 4514); a
// person's own on-premises DN is indexed, compared in one canonical form
// whatever escape spelling either side used, so a DN names the account it
// points at even when the CN differs from the Entra display name or two
// people share a name; a DN whose CN names someone whose own DN is known
// and different (a departed namesake) links nobody; several DNs in one value
// are told apart, and one that matches nobody is reported whole. Letter case
// never matters: every handle and token is lowercased.

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
   * Resolve a whole attribute value. Semicolons and line breaks separate
   * people (an escaped `\;` inside a DN does not); a comma separates people
   * only when the text on either side is not one person's name: "Ruiz, Dana"
   * is one assistant, "Dana Ruiz, Sam Chen" is two, "CN=Dana Ruiz,OU=Staff"
   * is one, and "CN=Ruiz\, Dana,…,DC=com, CN=Chen\, Sam,…,DC=com" is two
   * DNs. The whole part is tried first, then its comma pieces; a value led
   * by a DN is cut into its DNs first.
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

// --- Distinguished names (RFC 4514) -------------------------------------------------

/** A value that reads as a distinguished name: `CN=…`, `cn = …` and the like. */
export function isDistinguishedName(value: string): boolean {
  return /^\s*cn\s*=/i.test(value);
}

/** Is the character at `i` escaped, i.e. preceded by an odd run of backslashes? */
function escapedAt(s: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

/** Trim leading whitespace, and trailing whitespace that is not escaped (`Name\ ` keeps its space). */
function trimRdn(s: string): string {
  let out = s.replace(/^\s+/, "");
  while (out.length && /\s/.test(out[out.length - 1]) && !escapedAt(out, out.length - 1)) out = out.slice(0, -1);
  return out;
}

/**
 * Split a DN into its RDNs at the commas (and the old `;` separators) that
 * are not escaped and not inside a quoted value. Escapes are kept as typed.
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
      out.push(trimRdn(cur));
      cur = "";
      continue;
    }
    cur += c;
  }
  if (trimRdn(cur)) out.push(trimRdn(cur));
  return out;
}

/** An RDN value with its escapes undone: `Ruiz\, Dana`, `Ruiz\2C Dana` and `"Ruiz, Dana"` are all "Ruiz, Dana". */
function unescapeRdnValue(raw: string): string {
  let v = raw;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"') && !escapedAt(v, v.length - 1)) v = v.slice(1, -1);
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

/** One RDN as `type` and unescaped `value`; null when it is not `attr=value`. */
function parseRdn(rdn: string): { type: string; value: string } | null {
  const m = /^([A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)*)\s*=([\s\S]*)$/.exec(rdn);
  return m ? { type: m[1].toLowerCase(), value: unescapeRdnValue(trimRdn(m[2].replace(/^\s+/, ""))) } : null;
}

/**
 * One DN in the form both sides of a comparison share, whatever escape
 * spelling each used: each RDN as `type=value` with the value unescaped,
 * lowercased and its whitespace collapsed, joined with a separator no value
 * can contain. "" when the text is not a DN.
 */
export function canonicalDn(dn: string): string {
  const rdns = splitRdns(String(dn ?? "").trim()).map(parseRdn);
  if (rdns.length === 0 || rdns.some((r) => r === null)) return "";
  return (rdns as { type: string; value: string }[])
    .map((r) => `${r.type}=${r.value.toLowerCase().replace(/\s+/g, " ").trim()}`)
    .join("\u0001");
}

/** The CN of a DN, unescaped; "" when the first RDN is not a CN. */
export function commonNameOf(dn: string): string {
  const first = parseRdn(splitRdns(String(dn ?? "").trim())[0] ?? "");
  return first && first.type === "cn" ? first.value.trim() : "";
}

/**
 * Cut a value that starts with a DN into its DNs and any plain pieces after
 * them. A new DN starts where a `CN=` RDN follows an RDN that is not a CN
 * (`…,DC=com, CN=…`; `CN=Dana,CN=Users,DC=…` stays one DN); a piece that is
 * not `attr=value` (an address, a name) ends the DN before it.
 */
function splitDnLed(part: string): { text: string; dn: boolean }[] {
  const out: { text: string; dn: boolean }[] = [];
  let cur: string[] = [];
  let lastType = "";
  const close = () => {
    if (cur.length) out.push({ text: cur.join(","), dn: true });
    cur = [];
    lastType = "";
  };
  for (const rdn of splitRdns(part)) {
    const parsed = parseRdn(rdn);
    if (!parsed) {
      close();
      if (rdn) out.push({ text: rdn, dn: false });
      continue;
    }
    if (parsed.type === "cn" && cur.length > 0 && lastType !== "cn") close();
    cur.push(rdn);
    lastType = parsed.type;
  }
  close();
  return out;
}

/** Split a whole value at semicolons and line breaks that are not escaped. */
function splitPeople(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if ((c === ";" && !escapedAt(value, i)) || c === "\n" || c === "\r") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// --- The index ---------------------------------------------------------------------

/** What a token might be, in the order to try: the most specific first. */
function tokenCandidates(token: string): { exact: string[]; names: string[]; dn: string | null } {
  let t = token.trim();
  if (!t) return { exact: [], names: [], dn: null };
  // "Dana Ruiz <dana@firm.com>" — the address is the reliable part.
  const angled = /<([^<>]+)>\s*$/.exec(t);
  if (angled) t = angled[1];
  // A distinguished name: the person whose own DN it is, else the CN as a
  // display name (AD's CN is usually the display name, in either order).
  if (isDistinguishedName(t)) {
    const dn = canonicalDn(t);
    return { exact: dn ? [dn] : [], names: nameForms(commonNameOf(t)), dn: dn || null };
  }
  return { exact: [norm(t)], names: nameForms(t), dn: null };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Index people by every handle a token could carry. Unique handles (object
 * id, email, sign-in names, aliases, the on-premises DN) map to one person,
 * the first that holds them; a SAM account name or mail nickname is unique
 * only within one AD domain, and a name can be shared, so those are tracked
 * as sets and a handle two people hold resolves to nobody.
 */
export function buildPeopleIndex(people: ResolvablePerson[]): PeopleIndex {
  const exact = new Map<string, number>();
  const shared = new Map<string, Set<number>>();
  const names = new Map<string, Set<number>>();
  /** Each person's own canonical DN, when the record carries one. */
  const ownDn = new Map<number, string>();
  const addExact = (key: string, id: number) => {
    const k = norm(key);
    if (k && !exact.has(k)) exact.set(k, id);
  };
  const addShared = (key: string, id: number) => {
    const k = norm(key);
    if (!k) return;
    const set = shared.get(k) ?? new Set<number>();
    set.add(id);
    shared.set(k, set);
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
    for (const k of ["userPrincipalName", "mail", "onPremisesUserPrincipalName", "primaryEmail"]) {
      const v = str(r[k]);
      if (v) addExact(v, p.id);
    }
    for (const k of ["mailNickname", "onPremisesSamAccountName"]) {
      const v = str(r[k]);
      if (v) addShared(v, p.id);
    }
    const aliases = r["proxyAddresses"];
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        const v = str(a).replace(/^smtp:/i, "");
        if (v) addExact(v, p.id);
      }
    }
    // The person's own on-premises DN: what AD's DN-valued attributes
    // (assistant, secretary, manager) hold when they name this person.
    const dn = canonicalDn(str(r["onPremisesDistinguishedName"]));
    if (dn) {
      ownDn.set(p.id, dn);
      if (!exact.has(dn)) exact.set(dn, p.id);
    }
    if (p.name) addName(p.name, p.id);
    const display = str(r["displayName"]);
    if (display && norm(display) !== norm(p.name)) addName(display, p.id);
  }
  // A shared handle held by one person is as good as a unique one.
  const fromSet = (set: Set<number> | undefined): Resolution =>
    !set || set.size === 0 ? undefined : set.size === 1 ? { id: [...set][0] } : { ambiguous: set.size };

  const resolve = (token: string): Resolution => {
    const { exact: exactKeys, names: nameKeys, dn } = tokenCandidates(token);
    for (const k of exactKeys) {
      const id = exact.get(k);
      if (id !== undefined) return { id };
    }
    if (!dn) {
      for (const k of exactKeys) {
        const hit = fromSet(shared.get(k));
        if (hit) return hit;
      }
    }
    for (const n of nameKeys) {
      let set = names.get(n);
      if (!set || set.size === 0) continue;
      // A DN that missed every own DN names some other AD object: never
      // link it by name to someone whose own (different) DN is known.
      if (dn) set = new Set([...set].filter((id) => !ownDn.has(id)));
      if (set.size === 0) return undefined;
      return fromSet(set);
    }
    return undefined;
  };
  return {
    resolve,
    resolveList(value: string) {
      const out: { token: string; hit: Resolution }[] = [];
      for (const part of splitPeople(String(value ?? ""))) {
        // "Name <CN=…>": the DN in the brackets is one person, never cut.
        const angled = /<([^<>]+)>\s*$/.exec(part);
        if (angled && isDistinguishedName(angled[1])) {
          out.push({ token: part, hit: resolve(part) });
          continue;
        }
        // A value led by a DN: its DNs one by one, each whole (a DN's
        // commas separate RDNs, never people), then any plain pieces.
        if (isDistinguishedName(part)) {
          for (const seg of splitDnLed(part)) out.push({ token: seg.text, hit: resolve(seg.text) });
          continue;
        }
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
